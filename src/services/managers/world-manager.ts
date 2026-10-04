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

import { tileViewRank, cityLodMetric, assignDrawDistances, type DistanceTier, type FogTierClass, type FogExtraClass, type FogClassify } from './view-cull';
import { SimLod } from '../../world/sim-lod';
import { motionDropAllowed } from '../../renderer/core/resolution-scaler';
import { defaultCityLodSettings, sanitizeCityLodSettings, cityLodSettingsDiff, cityLodFamilies, scaleDistanceTiers, stampTwinDistances, collectCityLodStats, LodDebugTint, applyLodRendererSettings, cityLodSettingsView, type CityLodSettingsView, type CityLodSettings, type CityLodSettingsPatch, type CityLodFamily, type CityLodFamilyStats } from './world-lod-settings';
import { isShadowQualityPreset, shadowQualitySpec } from '../../renderer/3d/shadow-quality';
import { getArrayInstanceCount } from '../../scene-graph/shapes/array-group-3d';
import type { Scene3DManager, FlatColorLayer3D } from './scene3d-manager';
import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { generateCityLayout, tiledWorldExtent, buildLayoutPreview, buildBiome, buildStreets, buildRoadPaint, buildVoidGrid, buildBorderGlow, buildApron, buildTrafficLights, buildSignage, buildAwnings, buildFurniture, buildRailway, buildLocalLine, buildSkyway, buildSky, buildPedestrians, buildLandmarks, buildShotengai, buildWater, buildTerraces, makeElevation, makeHeightField, applyHeightField, regionAt, computeTraffic, computeTextSigns, computeSignalTextSigns, buildRoadSigns, cellLevelAt, hash2, makeDomainWarpInto, applyDomainWarp, cityStyle, CITY_STYLE_NAMES, Accum3D, LANDMARK_LABEL, LANDMARK_H, pointInPolygon } from '../../world';
import { PROP_TWIN_M } from '../../world/lod-accum';
import { TREE_TWIN_M } from '../../world/city-foliage';
import { chunkCityLayers, chunkMinCell, CHUNK_SKIP_GROUPS, type ChunkOptions } from '../../world/chunking';
import { withContactShadows, cityContactShadowOptions, isContactDone } from '../../world/contact-shadows';
import { buildLightSpill } from '../../world/light-spill';
import { layerInstanceCount, slicePacked, unpackLayerInstances } from '../../world/packed-instances';
import { CITY_STYLES } from '../../world/styles';
import { PED_SHADE } from '../../world/mannequin';
import type { LayoutParams, WorldGraph, RegionSeed, LayoutPreviewLayer, MoverSpec, Landmark } from '../../world';
import { WorldLiveCrowd, type LiveCrowdOptions } from './world-live-crowd';
import { WorldCrowd } from './world-crowd';
import { drapeCrowdRecords } from '../../world/crowd-instanced';
import { WorldTraffic, STATIC_WHILE_LIVE, type MoverRec } from './world-traffic';
import { WorldMoverShadows, MOVER_SHADOW_DEFAULTS } from './world-mover-shadows';
import { DEFAULT_SIGNAL_TIMING } from '../../world/signals';
import { drawLandmarkCard, drawLandmarkPill, CARD3D_RADIUS_PX } from '../../world/landmark-card';
import { computeDayNight, DEFAULT_SKY, SHADOW_TINTS, type TimeGradePhase, type SkyKey } from '../../world/day-night';
import { skyDomeParams, cleanSkyDome } from '../../world/sky';   // visual-polish #9: the stylised sky dome
import type { CitySkyDome } from '../../world/styles';
import type { CityLook, CityOutlines } from '../../world/styles';
import { DEFAULT_SKY as DEFAULT_PROC_SKY, ambientMatchedSkyIntensity, type ProceduralSkyParams } from '../../renderer/3d/procedural-sky';
import { CITY_SCENE_PRESETS, CITY_SCENE_PRESET_NAMES, CITY_CLEAN_LOOK, cityScenePreset, withGraphicLook } from '../../world/scene-presets';
import { cityMetresPerUnit, PEDESTRIAN_STYLES, type PedestrianStyle } from '../../world/types';
import type { AdvertCatalog } from '../../world/adverts';
import { DEFAULT_TOON_SHADOWS } from '../../renderer/3d/material-3d';
import { buildTileLayerGroups } from '../../world/tile-build';
import type { TileLayerGroup, TileBuildOptions } from '../../world/tile-build';
import { DRESSING_ORDER, FULL_BUILD_ORDER } from '../../world/build-order';
import { buildGroupFor, widenToTiledExtent, buildSelectedGroups } from '../../world/centre-build';
import { applyGraphPatch, buildRingGroups, type GraphPatchEntry, type RingJob } from '../workers/world-jobs';
import { roadNet } from '../../world/route-sim';
import { precomputeTraffic, wantsTraffic, type TrafficPrecompute } from '../../world/traffic-precompute';
/** An in-flight selective (worker) regen — see WorldManager._startSelectiveWorker. */
interface SelectiveState { names: string[]; graph: WorldGraph; ctx: ReassembleCtx | null; patch: GraphPatchEntry[] }
import type { RenderStyle } from '../../renderer/3d/material-3d';
import { applyObjectStyle, isEmptyStyle, mergeObjectStyle, neutralizeClearedFields, sanitizeObjectStyle, type ObjectStyle, type ObjectStylePatch } from './object-style';
import type { PostProcessConfig } from '../../renderer/3d/post-process-pass';
import { StreamManager } from '../streaming/stream-manager';
import type { Focus, StreamBudget } from '../streaming/stream-manager';
import { CityStreamSource, tileKey, hlodKey, isHlodKey, parseKey } from '../streaming/city-stream-source';
import { HLOD_DEFAULTS, sanitizeHlod, hlodLevelFor, pointBoxDistance, hlodFadeCoverage, oldTierFadeLevel, type HlodSettings } from '../streaming/hlod-select';
import type { HlodLevel } from '../../world/tile-hlod';
import { TileWorkerPool } from '../streaming/tile-worker-pool';
import { windowFocusPoint, windowFocusTile, windowTiles, outsideTier, type OutsideTiles } from '../streaming/tile-window';
import { FocusMotion, MOTION_DEFAULTS, DEFAULT_FULL_LATENCY_S, keepUpTiles, sanitizeMotion, predictedWindowTiles, fastWindowTier, corridorTiles, type MotionWindowOptions, type MotionState } from '../streaming/motion-window';
import { ByteLru } from '../streaming/byte-lru';
import type { Camera3D } from '../../renderer/3d/camera-3d';
import { debugLog } from '../debug-log';
import { EventEmitter } from '../../renderer/util/event-emitter';
import { GroupBoundsJob } from './group-bounds';
import { STREAM_HITCH, streamHitchStats } from '../../renderer/3d/stream-hitch';
import { P20_RENDER as Renderer3DP20 } from '../../renderer/3d/lighter-tiles';
import { P22_RENDER as Renderer3DP22, TILE_LANDING } from '../../renderer/3d/tile-landing';

/** P16: nodes in a subtree (the LOD restamp skip's change signature). */
function countNodes(root: unknown): number {
    let n = 0;
    const st: unknown[] = [root];
    while (st.length) { const x = st.pop() as { children?: unknown[] } | null; if (!x) continue; n++; if (x.children) for (const c of x.children) st.push(c); }
    return n;
}

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
    /** Split-tone hues (city-quality P7) — absent = [1,1,1] (off). */
    shadowTint?: [number, number, number];
    highlightTint?: [number, number, number];
}
// Day/night types + defaults now live in the pure module src/world/day-night.ts (audit C3);
// re-exported here so existing host imports keep working.
export type { TimeGradePhase, SkyKey } from '../../world/day-night';

/** Default cinematic keyframes: cool bloomy nights → warm dawns → neutral noons → golden dusks. */
const DEFAULT_TIME_GRADE: Record<TimeGradePhase, TimeGradeKey> = {
    night: { bloomThreshold: 0.4, bloomIntensity: 1.55, brightness: -0.04, contrast: 0.12, saturation: 0.05, tint: [0.86, 0.9, 1.12], vignette: 0.35 },
    dawn: { bloomThreshold: 0.62, bloomIntensity: 0.72, brightness: 0.0, contrast: 0.05, saturation: 0.1, tint: [1.06, 0.97, 0.94], vignette: 0.22 },
    noon: { bloomThreshold: 0.78, bloomIntensity: 0.4, brightness: 0.02, contrast: 0.04, saturation: 0.07, tint: [1, 1, 1], vignette: 0.14 },
    dusk: { bloomThreshold: 0.52, bloomIntensity: 1.1, brightness: -0.01, contrast: 0.09, saturation: 0.14, tint: [1.12, 0.93, 0.85], vignette: 0.28 },
};

/** In-flight progressive tile reassembly: groups accumulate into `out`; the tile's Promise resolves when `remaining` hits 0.
 *  `staged` = a CENTRE worker regen's groups — added HIDDEN via _addStaged (not tile-tracked), revealed by the swap. */
// (Tile drape now happens IN THE WORKER — see src/world/drape.ts; reassembly is mesh-wrap + upload only.)
interface ReassembleCtx { out: MeshGroup3D[]; remaining: number; resolve: (m: MeshGroup3D[]) => void; staged?: boolean }
/** One queued reassembly job (a group chunk of a tile / the centre). */
interface ReassembleJob { name: string; layers: LayoutPreviewLayer[]; prio: number; ctx: ReassembleCtx }
/** Step 3b: the job being wrapped in slices — layer / unit cursors, phase (0 wrap, 1 warm, 2 attach), its warm frames. */
interface SliceJob {
    job: ReassembleJob; layers: LayoutPreviewLayer[]; crowd: LayoutPreviewLayer[] | null; group: MeshGroup3D | null;
    li: number; ui: number; phase: 0 | 1 | 2; warmFrame: number; warmFrames: number; stall: number; ms: number; unwarmed?: Mesh3D[];
}

/** Per-mesh-name classification for the glow / surface-look passes (performance-plan P5.W3; see WorldManager.glowTraits). */
interface GlowTraits {
    skip: boolean; celestial: boolean; skyClouds: boolean; cloud: boolean; cloudRim: boolean; lampPool: boolean;
    /** visual-polish #5: a night light-spill layer (world:light-spill*). */
    lightSpill: boolean;
    /** Index of the first matching WorldManager.GLOW row. */
    row: number;
    crowd: boolean; roadPaintEnd: boolean; snowGround: boolean; trainWin: boolean; wetRoad: boolean;
    cleanGround: boolean; mute: boolean; sidewalks: boolean; roadsWear: boolean; kerb: boolean;
}
/** One glow re-dress: the per-pass constants, a snapshot of the meshes and the slicing cursor. */
interface GlowPass {
    night: number; meshes: Mesh3D[]; i: number; ms: number; slices: number;
    litFrac: number; wet: boolean; snowy: boolean; clear: boolean; showSky: boolean;
    /** visual-polish #9: the sky dome draws the stars + moon (domeSky) / the painted clouds (domeClouds) itself. */
    domeSky: boolean; domeClouds: boolean;
    cloudGlow: [number, number, number] | null; cloudRim: [number, number, number] | null;
}

export class WorldManager {
    public _groups: MeshGroup3D[] = [];
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
    public _graph: WorldGraph | null = null;
    public _heightFn: (x: number, z: number) => number = () => 0;   // full elevation (smooth + terraces) applied to every layer
    public _smoothFn: (x: number, z: number) => number = () => 0;   // smooth terrain only — bridges use this so they arch OVER sunken canals
    // DOMAIN WARP — the final horizontal post-transform. ALLOCATION-FREE fill variant (writes into a scratch)
    // so the per-frame traffic tick's ~200 warp calls/frame don't churn ~12k throwaway arrays/sec (GC hitches).
    public _warpInto: (x: number, z: number, out: [number, number]) => void = (_x, _z, out) => { out[0] = 0; out[1] = 0; };
    public readonly _warpScratch: [number, number] = [0, 0];
    public _params: LayoutParams | null = null;   // last full params (after defaults) — the base for live edits
    private _autoFrame = true;                      // suppressed during live slider updates so orbit isn't yanked
    private _activeRegions: Set<number> | null = null;   // active-region editor: null = ALL districts build; else only these region ids
    private _cityMode = false;
    // Day/night cycle: 0 = midnight · 0.25 = sunrise · 0.5 = noon · 0.75 = sunset. null = untouched (editor lighting).
    public _timeOfDay: number | null = null;
    // Sun compass bearing (radians). The daily east→west sweep is ADDED to this, so rotating it turns the whole
    // arc — shadows can reach every side. Default leans the arc diagonally (reads best in the iso view).
    private _sunAzimuth = Math.PI * 0.25;
    private _cyclePeriod = 120;
    /** The city's LOOK (render style / toon shadows / rim) — re-applied after every regen and PERSISTED in the City
     *  marker (2026-09-29; the render style used to be lost on reload). Manager-level, so it carries to the next city. */
    public _style: ObjectStyle | undefined = undefined;
    /** True when the city has any style set — or the crowd has a non-flat pedestrianStyle (every regen / spawn path
     *  re-applies it through _applyRenderStyle). */
    public _hasStyle(): boolean { return !isEmptyStyle(this._style) || this.pedestrianStyle !== 'flat'; }
    // Traffic sim (v1) — extracted to WorldTraffic (audit C3); movers slide along routes via the shared ticker.
    private readonly _traffic = new WorldTraffic(this);
    /** Round 7: the LIVE near-field crowd (the static people nearest the camera, lifted out + idling). */
    private readonly _liveCrowd = new WorldLiveCrowd(this);
    /** P12: the INSTANCED static crowd (lazy near / mid cells, xfar copies, tier swaps). */
    readonly _crowd = new WorldCrowd(this);
    /** visual-polish #16: the moving contact blobs (walkers, cars, trains, the Play player) — one mesh, follows the poses. */
    readonly _moverShadows = new WorldMoverShadows(this);
    /** The live traffic movers (read by the mover blobs; a new array on every respawn). */
    get _trafficMovers(): readonly MoverRec[] { return this._traffic.movers; }
    /** The City wrapper container (null = no city) — read by the live crowd for the camera → city-local transform. */
    get cityRoot(): MeshGroup3D | null { return this._cityContainer; }
    private get _trafficOn() { return this._traffic.on; }
    private set _trafficOn(v: boolean) { this._traffic.on = v; }
    private get _movers() { return this._traffic.movers; }
    // All movers (traffic + clouds) live over the CENTRE city. In follow mode, once you've panned the centre
    // fully off-screen they're wasted work (ticked + drawn every frame for nothing) → pause + hide them, resume
    // when the centre re-enters the view. Off in the diorama / non-tiled worlds (centre is always visible there).
    private _moversHidden = false;
    private _centreVisible = true;
    // DOOR VISITS: pedestrians occasionally walk to a stamped front door, it swings open, they step inside
    // (despawn) and come back out later. Two reusable animated door LEAVES serve all visits.

    public _simTime = 0;      // seconds of sim time (chat pauses/cooldowns + weather anims key off this)
    private _flash = 0;        // lightning strobe level (storms) — read by _applyTimeOfDay
    // Cinematic grade: post-processing (bloom/grade/vignette) keyed to the time of day (4 lerped keyframes).
    private _gradeOn = false;
    private _gradeKeys: Record<TimeGradePhase, TimeGradeKey> = JSON.parse(JSON.stringify(DEFAULT_TIME_GRADE)) as Record<TimeGradePhase, TimeGradeKey>;
    private _skyKeys: Record<TimeGradePhase, SkyKey> = JSON.parse(JSON.stringify(DEFAULT_SKY)) as Record<TimeGradePhase, SkyKey>;
    private _prePostFX: PostProcessConfig | null = null;   // the host's config, captured on enable + restored on disable

    constructor(public readonly scene3d: Scene3DManager) {
        // polish-round-3 T1.2: a FRESH session's cities start on the clean PBR look (data only - applied when the city
        // lights). A restored doc overwrites every look field from its marker (absent fields -> the legacy defaults),
        // so saved cities reload exactly as they were.
        this._setLookData(CITY_CLEAN_LOOK);
        // Streamed neighbour tiles: the content-agnostic StreamManager drives the city's tiles through a
        // CityStreamSource whose hooks delegate back to this manager (build / dispose / progress / settled).
        this._stream = new StreamManager<MeshGroup3D[]>(this._streamSrc = new CityStreamSource({
            tileParams: () => this._tileParamsForBuild,
            buildTile: (p, tx, tz, proxy, massing, hlod) => this._hlodLanded(this._buildTile(p, tx, tz, proxy, massing, hlod), hlod),
            buildTileAsync: (p, tx, tz, key) => this._buildTileAsync(p, tx, tz, key),
            buildCheapTileAsync: (p, tx, tz, massing, key, hlod) => {
                const a = this._buildCheapTileAsync(p, tx, tz, massing, key, hlod);
                return a && hlod ? a.then(g => this._hlodLanded(g, hlod)) : a;
            },
            crossFadeTile: (pk, prev, pp, nk, next) => this._crossFadeTile(pk, prev, pp, nk, next),
            cancelTileBuild: (key) => this._cancelTileBuild(key),
            hasRetired: (key) => this._tileRetired.has(key) || this._proxyRetired.has(key) || this._hlodRetired.has(key),
            canUseWorkers: () => this._workersEnabled && this._ensureTilePool().available,
            workerCount: () => this._tilePool?.size ?? 0,   // caps concurrent async dispatches to the pool size
            reserveCheap: () => WorldManager.P10.reserveCheapWorkers && WorldManager.P10.cheapInWorker,
            cheapBoost: () => this._outsideTiles === 'hlod' && WorldManager.P10.cheapInWorker,   // P17: the skyline keeps up with a fly
            // P20 slotOnWorkerDone: a build whose worker result is being reassembled no longer holds a worker slot
            holdsWorker: (key) => !WorldManager.P20.slotOnWorkerDone || !this._tileReassembly.has(key),
            // P22 landingSlots: a still camera landing full tiles keeps every full-class slot (no HLOD borrowing)
            landing: () => WorldManager.P22.landingSlots && this._landing(true),
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
                sunAzimuth: (deg: number) => this.setSunAzimuth(deg * Math.PI / 180),   // rotate the sun bearing (degrees) → shadows onto any side
                sun: (deg: number) => this.setSunAzimuth(deg * Math.PI / 180),          // alias
                cycle: (periodSec = 120) => periodSec > 0 ? this.playDayCycle(periodSec) : this.stopDayCycle(),
                override: (on = true) => this.setOverrideGlobalLighting(on), // city drives its own lighting (true) vs inherit global (false)
                spin: (degPerSec = 6) => this.setTurntable(degPerSec),     // ◉ slow turntable orbit; spin(0) stops
                pedestrianStyle: (s?: PedestrianStyle) => { if (s) this.setPedestrianStyle(s); return this.pedestrianStyle; },   // ◧ crowd shading: 'flat' | 'default' | 'cel' | 'cel-hd' | 'ink' (live, persisted)
                style: (s: RenderStyle | null) => this.setRenderStyle(s),  // 'cel'|'cel-hd'|'sketch'|'ink'|'gouraud'|null(PBR)
                pack: (name: string) => this.applyStyle(name),             // one-call style pack: tokyo|oldtown|seaside|noir|toon|retro
                packs: () => this.styleNames,
                scene: (name: string) => this.applyScenePreset(name),      // T1.1: morning|noon|golden|dusk|night|rainyEvening|snowyMorning|overcast
                scenes: () => this.scenePresetNames,
                street: (opts: Parameters<WorldManager['streetView']>[0] = {}) => this.streetView(opts),   // T1.5: eye-level street shot
                traffic: (on = true) => on ? this.startTraffic() : this.stopTraffic(),   // ▶ moving cars/train/walkers
                grade: (on = true) => this.setCinematicGrade(on),          // cinematic post keyed to the time of day
                gradeKey: (k: TimeGradePhase, v: Partial<TimeGradeKey>) => this.setTimeGradeKey(k, v),   // tune a keyframe live
                skyKey: (k: TimeGradePhase, v: Partial<SkyKey>) => this.setSkyKey(k, v),                 // author the sky colour at a phase
                skyKeys: () => this.skyKeys,                                                            // read current sky palette
                skyReset: () => this.resetSkyKeys(),                                                    // back to the default sky palette
                perf: () => this.scene3d.getPerf3D(),   // paste when frames dip — poolRebuilds/atlasRebuilds climbing = the culprit
                // ◧ Y-SCAN — every city mesh's world-Y extent, lowest first. For "something is under the
                // world": whatever is sitting below the ground surface shows up at the top of this list with
                // its layer name, which localises it to one builder instead of guessing from a screenshot.
                yscan: (limit = 20) => this._yscan(limit),
                // ◧ WATER — retune the live water material without a regen. Every field is optional:
                //   salsaWorld.water({ glitter: 2 })  ·  .water({ choppy: 0.8, waveSpeed: 1.4 })
                //   .water({ deep: [0.02,0.12,0.2], shallow: [0.4,0.7,0.7] })
                // waveScale is CYCLES PER WORLD UNIT (the city is ~15 m per unit), so small changes there
                // are large changes on screen. Call with no args to read the current values back.
                water: (p?: Partial<{ deep: [number, number, number]; shallow: [number, number, number];
                        waveScale: number; waveSpeed: number; choppy: number; glitter: number }>) => this._tuneWater(p),
                // ◧ per-frame CPU: which pre-render callback (springs / IK / idle / gizmos) eats the frame. Call once to
                //   start, then again after a few seconds of the slow thing (e.g. armature Play): salsaWorld.callbackStats()
                callbackStats: () => this.scene3d.getCallbackProfile3D() ?? 'profiling started — call again in a few seconds',
                callbackStatsOff: () => this.scene3d.setCallbackProfiling3D(false),
                cullChunks: (on = true, tune?: Partial<ChunkOptions> & { minCellMul?: number }) => this.setCullChunks(on, tune),   // ◧ spatial chunking of the city-wide merged layers (Round 5) — off to A/B (rebuilds)
                // ◧ P9 CPU / geometry A/B (performance-plan P9): propTwins(false) = no prop far twins + the two-tier crowd
                //   (REBUILDS); p9(false) = also the renderer / sim switches (hierarchical cull, draw-list fast paths,
                //   resolution-aware distances, traffic blocker grid, lazy camera candidates). Read back with no args.
                propTwins: (on?: boolean) => { if (on !== undefined) this.setPropTwins(on); return this._params?.propTwins !== false; },
                p9: (on?: boolean) => this._p9Switches(on),
                frameStats: () => this.scene3d.getFrameStats3D(),
                edgeWear: (level?: 'off' | 'subtle' | 'heavy') => { if (level) this.setEdgeWear(level); return this.edgeWear; },   // ◧ E2 chipped stone edges (near chunks only)
                // ◧ Round 7 LIVE CROWD: the N static people nearest the camera idle (breathing / weight shifts / head turns /
                //   phone / talk). liveCrowd(false) = everyone frozen (A/B); liveCrowd(true, { count, radiusIn, radiusOut }) metres.
                liveCrowd: (on = true, o: Partial<LiveCrowdOptions> = {}) => { this._liveCrowd.setOptions({ ...o, on }); this.scene3d.requestRender3D(); return { ...this._liveCrowd.opts, on }; },
                liveCrowdStats: (reset = false) => { const s = { ...this._liveCrowd.stats }; if (reset) this._liveCrowd.resetStats(); return s; },
                // ◧ visual-polish #16 MOVER BLOBS: moverShadows(false) = off (A/B); moverShadows(true, 0.5) = on at that opacity.
                moverShadows: (on?: boolean, strength?: number) => { if (on !== undefined) this.setMoverShadows(on, strength); return { ...this.moverShadows, ...this.moverShadowStats() }; },
                // ◧ P12 INSTANCED CROWD: instancedCrowd(false) = the baked per-colour crowd (A/B, REBUILDS); crowdStats() = the
                //   lazy cells / tiers / bytes (reset = zero the maxima).
                instancedCrowd: (on?: boolean) => { if (on !== undefined) this.setInstancedCrowd(on); return this._params?.instancedCrowd !== false; },
                // ▶ SIM LOD (performance-plan §P13): simLod() = stats; simLod(false|true) = the A/B switch; simLod({ nearM, midM, midHz, farHz, offscreenHz, fogFreeze }) = tune; simLod('reset') = counters
                simLod: (on?: boolean | 'reset' | Record<string, unknown>) => { if (on === 'reset') { this._sim.resetStats(); return this._sim.stats(); } if (on !== undefined) this.setSimLod(typeof on === 'boolean' ? { enabled: on } : on); return this._sim.stats(); },
                crowdStats: (reset = false) => { const s = { ...this._crowd.stats, bytes: this._crowd.bytes() }; if (reset) this._crowd.resetStats(); return s; },   // ◧ per-frame render profile: drawCalls / meshes / arrayGroups / instances / msTotal / msUpload / msShadow (find the bottleneck)
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
                detailLod: (on = true, far?: number) => this.setCityDetailLOD(on, far),
                distanceLod: (on = true, mul?: number) => this.setCityDistanceLOD(on, mul),                // ◧ R6.1 per-chunk camera-distance LOD; mul scales the distances (1 = the zoom-tier thresholds)                   // ◧ zoom-gated fine-detail cull; far = camera dist (world units) past which balconies/trim/props stop drawing
                streamFollow: (on = true) => this.setStreamFollow(on),                                     // ▤ tiled worlds: stream the tile window to follow the camera (pan → tiles load ahead / unload behind)
                streamMaxDist: (n = 5) => this.setStreamMaxDist(n),                                         // ▤ max render distance in tiles (2–8) + zoom-out cap; bounds the resident set for huge worlds
                dynRes: (on = true) => this.setDynamicResEnabled(on),                                       // ◨ pan-time dynamic resolution (0.78× while the camera moves) — off to A/B crispness
                streamWorkers: (on = true) => this.setStreamWorkers(on),                                    // ▤ Web-Worker off-thread tile generation (default ON); off = main-thread build (A/B the stall)
                streamStats: () => this.getStreamStats(),                                                  // ▤ streaming state: focus tile + live/pending tile counts
                streamOutside: (m?: OutsideTiles) => { if (m) this.setStreamOutsideTiles(m); return this._outsideTiles; },   // ▤ P10.D outside-the-window tiles: 'none' | 'flat' | 'massing' | 'hlod' (P17)
                hlod: (patch?: Partial<HlodSettings>) => this.setStreamHlod(patch),   // ▤ P17 HLOD settings: { midTiles, skylineTiles, maxTiles, fade, fadeMs }
                hlodStats: () => this.getHlodStats(),
                // ▤ P19 speed-aware window + old-tier dissolves: stream19() reads, stream19(false) = all off, stream19({ fastWindow: false }),
                //   stream19(undefined, { fast: 'landing', fastTiles: 1 }) = the motion settings; streamMotion() = speed / state / lead
                stream19: (on?: boolean | Partial<typeof WorldManager.STREAM19>, o?: Partial<MotionWindowOptions>) => this.setStreamMotion(on, o),
                streamMotion: () => this.getStreamMotionStats(),
                // ◧ P10 streaming A/B (performance-plan P10): p10() reads the switches, p10(false) = all off (pre-P10),
                //   p10({ farMassing: false }) = one off. Build-side switches (tileFrame, seedDedup, tileContactInWorker,
                //   lazyElevation) apply to tiles built AFTER the change (re-run tiles(...) / a seed change to rebuild).
                p10: (on?: boolean | Partial<typeof WorldManager.P10>) => this.setP10Switches(on),
                // ◧ P20 lighter tiles A/B: p20() reads, p20(false) = all off (baked props, the old renderer paths),
                //   p20({ propInstancing: false }); build-side switches apply to tiles built after the change.
                p20: (on?: boolean | Partial<typeof WorldManager.P20 & typeof Renderer3DP20>) => this.setLighterTiles(on),
                // ◧ P22 tile landing A/B: p22() reads, p22(false) = all off, p22({ splitTile: false, packedVertices: false })
                p22: (on?: boolean | Partial<typeof WorldManager.P22 & typeof Renderer3DP22>) => this.setTileLanding(on),
                p20Stats: () => this.getLighterTilesStats(),
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
        this.scene3d.addPreRenderCallback3D(this._hlodFadeCb); // P17: HLOD tier-swap dissolves (true while one runs: keeps the loop alive)
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
    // ★ city-quality L5: the LIT layers (building signs + screens, shop signs, lamp heads + pools, lanterns, city
    //   screens) are NOT culled at any tier — they're what a night city reads by from afar; culling them left the
    //   default overview dark and neon-less. Only the unlit fine clutter goes.
    private static readonly DETAIL_LOD = /world:detail-juliet|world:detail-windowtrim|world:detail-greenery|world:detail-bloom|world:detail-awning|world:detail-pfoliage|world:detail-trim|world:balcony|awning-|textsign-|world:roadsign-|world:warning|util-wire|laundry|world:detail-duct|world:detail-railing-steel|alley-clutter|noren|world:ped-|world:traffic-walker|world:traffic-robot-visor|world:traffic-bird|world:detail-door|world:rail-fine-|world:local-fine-/;   // (world:rail-fine- = railway sleepers / rails / catenary, railway-upgrade R1.3/R1.4)
    private static readonly ROOF_LOD = /world:roof-detail|world:roof-equip|world:roof-mark|world:detail-roof-equip/;
    // Tier 2b (PROPS): all the small scene furniture — invisible once tiles are small, but a huge chunk of the draw
    // count. Trees / rocks / lamp posts / parked cars / utility poles / benches / bus stops / bikes / vending / signs
    // / screens / apron nature. Keeps building bases, roofs, roads, landmarks (the readable-from-afar silhouette).
    private static readonly PROPS_LOD = /world:tree-|world:rocks|world:apron-foliage|world:apron-rocks|world:apron-trunks|world:lightpoles|world:util-pole|world:car-|world:bench|world:busstop|world:bicycle|world:cabinet|world:cone|world:guardrail|world:manhole|world:planter|world:postbox|world:vending-|world:sg-struct|world:park-prop|world:cafe-terrace|world:shopfront|world:construction|world:tactile|world:retaining|world:stairs|world:stair-|world:bridge-rail|world:bridge-railpost|world:bridge-lamplights|world:water-rail|world:water-railposts|world:signal-|world:lamp-banner|world:frontage-|world:rail-stn-prop|world:rail-arc-prop|world:metro-(?!sign)|world:local-prop|world:local-xing-(?!lamp)/;   // (world:frontage- = D1 nobori flags; rail-stn-prop = station benches/gates; rail-arc-prop = R3.1 arcade racks/bikes/fences/cloth; metro- = R2.3 kiosks, lit sign untiered)
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
    // ★ T7.3: HEAVY layers that no tier covered — `world:signal-` (the rebuilt traffic-signal housings + their lamp
    // lenses, ~120k tris: PROPS tier with the poles they hang on; lamps sub-pixel there anyway), `world:lamp-banner`
    // (PROPS), `world:detail-door` / `-doorframe` (~40k, DETAIL) and `world:detail-sign-text` (the lit sign glyphs,
    // ~80k — the sign PANELS stay lit; only the lettering drops, at the extreme zoom-out band). The lit lamp glass
    // (`world:lamplights`) and the lamp pools stay untiered (night overview).
    private static readonly STRUCTURE_LOD = /world:rail-(?!train|fine-|stn-prop|arc-prop)|world:local-(?!train|fine-|prop|xing-|stn-sign-lit|stn-lamplights)|world:sg-(?!lantern|struct|paving)|world:bridge-stone|world:bridge-paint|world:fountain-water|world:lm-accent|world:lm-glass|world:lm-field|world:lm-red|world:lm-steps|world:detail-sign-text/;
    // ── R6.1 DISTANCE LOD (camera-aware, per chunk). The tiers above are GLOBAL: one metric (the orbit radius, or 2 ×
    // the camera's distance to the city) hides a whole tier at once — right for zooming out over the diorama, blind to
    // where the camera actually is once it can fly anywhere. Now every mesh in the DETAIL / ROOF / PROPS / FLATMAP
    // tiers (+ the sign lettering) also carries a per-mesh `drawDistance`, and the RENDERER drops it once the camera is
    // farther than that from the mesh's own box — so with chunked layers the far cells down a long street lose their
    // detail while the near ones keep it, in every camera mode (editor free3D, City orbit, Play). Distances derive from
    // the zoom tiers' Tier-1 threshold F = 2.8 R: fine DETAIL (+ sign lettering) at DIST_LOD_FINE × F, ROOF ×1.25 of
    // that, PROPS 1.2 F and FLATMAP 1.4 F (the zoom numbers — trees / cars read from farther). STRUCTURE (massing, the
    // rail viaduct, bridges) and every untiered layer (roads, bodies, the lit signs / lamps) never distance-hide.
    // Camera-aware: _lodCb adds the camera's distance to the city VOLUME as a bias (0 at street level, the height
    // above the roofs from the air — so the aerial overview keeps its L5 look and the zoom tiers own it); the renderer
    // scales by the lens (fovDistanceScale: a 75° Play camera drops detail sooner) and applies 10 % hysteresis. The
    // stamp walk runs only when the scene epoch or the thresholds change.
    private _distLodOn = true;
    private _distLodMul = 1;
    private _distLodBias = -1;         // last bias pushed to the renderer (bucketed)
    private _distLodKey = '';          // thresholds last stamped (R|mul|on) — re-stamp on change
    private _distLodEpoch = -1;        // scene epoch last stamped
    private _distTiers: DistanceTier[] = [];
    /** The distance tiers for a Tier-1 draw distance `far` (world units). Order matters: the sign lettering is claimed
     *  before STRUCTURE could (it is detail-sized); the tiers are otherwise disjoint. `unitsPerMetre` (world units per
     *  real metre; 0 = unknown) turns the P8 shadow feature sizes (SHADOW_FEATURE_M, metres) into the fourth element. */
    static cityDistanceTiers(far: number, unitsPerMetre = 0): DistanceTier[] {
        const fine = far * WorldManager.DIST_LOD_FINE;
        const tb = WorldManager.DIST_LOD_TINY_BIAS;
        const sf = WorldManager.SHADOW_FEATURE_M, sh = (m: number): number => (unitsPerMetre > 0 ? m * unitsPerMetre : 0);
        // FOG HORIZON (docs/specs/fog-horizon.md): the sixth element is each family's class for "Buildings only in
        // fog" (fogT pads the optional bias / shadow / kind elements with their defaults, so the stamp is unchanged).
        const fogT = WorldManager._fogTier;
        return [
            // P7 per-family classes (claimed FIRST — the zoom-tier regexes below would otherwise take them). Same
            // street-level distance as their zoom tier where the features are person-sized; the sub-metre street
            // furniture drops at the fine distance (a 0.3–0.5 m signal housing / insulator / bollard is under a pixel
            // past it), the vending cans at a third of it. None of them takes the aerial bias (DIST_LOD_TINY_BIAS):
            // from the air they are just as small as their true distance says.
            // P8: the fourth element is the class's shadow feature size — a shadow map whose texel is coarser leaves
            // these out of its casters (Renderer3D.shadowSizeLod).
            fogT([WorldManager.CANS_DIST_LOD, fine * WorldManager.DIST_LOD_CANS, tb, sh(sf.cans)], 'other'),
            // (LOD settings families, docs/ui/performance.md: split out of the tier below with ITS distance and bias, so
            // they can be tuned apart; the stamp is unchanged)
            // (2026-10-01: + the walkers' chat bubbles, which were untiered and so drew at any distance while shown)
            fogT([/world:ped-|world:traffic-walker|world:traffic-robot-visor|world:traffic-bird|world:traffic-emote/, fine, tb, sh(sf.crowd)], 'other'),
            fogT([/world:rail-fine-|world:local-fine-/, fine, tb, sh(sf.tiny)], 'other'),
            fogT([WorldManager.TINY_DIST_LOD, fine, tb, sh(sf.tiny)], 'other'),
            fogT([WorldManager.SMALL_PROPS_DIST_LOD, fine, tb, sh(sf.small)], 'other'),
            fogT([WorldManager.THIN_PROPS_DIST_LOD, far * 1.2, tb, sh(sf.thin)], 'other'),
            fogT([/world:detail-sign-text/, fine], 'attachment'),
            // (fog horizon: the road / warning signs split out of the name plates with the same distance - street
            // furniture, not a building attachment)
            fogT([/world:roadsign-|world:warning/, fine], 'other'),
            fogT([/textsign-/, fine], 'attachment'),   // (LOD settings family, split out of DETAIL)
            fogT([WorldManager.DETAIL_LOD, fine], 'attachment'),        // facade trim, sills, balconies, awnings, greenery
            fogT([WorldManager.ROOF_LOD, fine * 1.25], 'attachment'),   // rooftop equipment, clutter, markings
            // (LOD settings families: trees / parked cars / vending machines, split out of PROPS with its distance)
            fogT([/world:tree-|world:apron-foliage|world:apron-trunks/, far * 1.2], 'other'),
            fogT([/world:car-/, far * 1.2], 'other'),
            fogT([/world:vending-/, far * 1.2], 'other'),
            fogT([WorldManager.PROPS_LOD, far * 1.2], 'other'),
            // Paving is GROUND: kept in the fog like the roads, so the fogged ground stays continuous.
            fogT([WorldManager.FLATMAP_LOD, far * 1.4], 'building'),
            // P7: the contact-shadow blobs (under people / cars / props) were never distance-hidden; they follow the
            // props they ground.
            fogT([/world:contact-shadow/, far * 1.2], 'other'),
            // P9 NEAR/FAR TWIN swap distances of the heavy props (kind 'twin', fifth element; view-cull.ts): the near
            // twin (the full prop) within this distance of a chunk, the cheap far twin (lod-accum.ts) past it. Real
            // metres (PROP_TWIN_M) — they do not scale with F. `unitsPerMetre` 0 = the distances in metres.
            ...WorldManager.propTwinTiers(unitsPerMetre > 0 ? unitsPerMetre : 1),
            // P8 FAR CROWNS: the trees' full leaf / tip crowns swap to the thinned far crowns (city-foliage.ts) past
            // TREE_TWIN_M (real metres, like the P9 twins). Console A/B of the crowns: `Renderer3D.groupTwins = false`.
            [/world:tree-/, TREE_TWIN_M * (unitsPerMetre > 0 ? unitsPerMetre : 1), 0, 0, 'twin'],
        ];
    }
    /** A draw tier with its fog-horizon class (the optional bias / shadow-size / kind elements padded with their
     *  defaults: bias 1, shadow 0, 'draw' - exactly what the stamp assumes when they are absent). */
    private static _fogTier(t: DistanceTier, c: FogTierClass): DistanceTier {
        return [t[0], t[1], t.length > 2 ? (t as readonly [RegExp, number, number])[2] : 1, t.length > 3 ? (t as readonly [RegExp, number, number, number])[3] : 0, 'draw', c];
    }
    /** FOG HORIZON: untiered layers classed by name (no draw tier claims them, so they never distance-hide). The lit
     *  shop signs, sign boards and screens are building ATTACHMENTS; the street lamps, lamp pools and the traffic
     *  movers are OTHER. Everything else untiered (building bodies, roofs, landmarks, roads, ground, water, the rail
     *  viaduct and bridges) is BUILDING: the silhouette and its ground. */
    static readonly FOG_EXTRA_CLASSES: readonly FogExtraClass[] = [
        [/world:detail-sign|world:detail-lightbox|world:detail-screen|world:detail-frosted|world:sign-|world:screen-|world:rail-arc-sign-|world:stall-awning|world:rail-stn-sign-lit|world:local-stn-sign-lit|world:metro-sign/, 'attachment'],
        [/world:lamplights|world:lamp-|world:sg-lantern|world:rail-stn-lamplights|world:local-stn-lamplights|world:rail-arc-lamplights|world:rail-arc-lantern|world:bridge-lamplights|world:traffic-|world:veh-|world:rail-train|world:local-train|world:stall|world:crate|world:trash|world:vent|world:aboard|world:bollard|world:bike-rack|world:poster|world:duck-|world:local-xing-|world:signaltext-/, 'other'],
    ];
    /** Step 3 (fog-horizon §6 "a cheap step"): the overlays that lie ON a building-class surface — road paint, road wear,
     *  gutters, storefronts — are fog colour over fog colour past Far (37-53 % of the meshes drawn past Far were such
     *  layers). Class 'overlay': culled past Far like class 2, no fade (they fog with their surface up to Far).
     *  Switch: WorldManager.STEP3.overlaysFogCulled (sm.setStep3Options3D). */
    static readonly FOG_OVERLAYS: FogExtraClass = [/world:roadpaint|world:roads-wear|world:gutter|world:detail-storefront/, 'overlay'];
    private static _fogClassifyCache: FogClassify | null = null;
    private static _fogClassifyOverlays = true;
    /** The fog-horizon classification input of assignDrawDistances (the unit tiers' classes + the untiered extras). */
    static fogClassify(): FogClassify {
        const ov = WorldManager.STEP3.overlaysFogCulled;
        if (WorldManager._fogClassifyCache && WorldManager._fogClassifyOverlays === ov) return WorldManager._fogClassifyCache;
        WorldManager._fogClassifyOverlays = ov;
        return WorldManager._fogClassifyCache = { tiers: WorldManager.cityDistanceTiers(1), extras: ov ? [WorldManager.FOG_OVERLAYS, ...WorldManager.FOG_EXTRA_CLASSES] : WorldManager.FOG_EXTRA_CLASSES };
    }
    /** P9: the prop families' twin tiers (`[re, distance, 0, 0, 'twin']`, world units). */
    static propTwinTiers(unitsPerMetre: number): DistanceTier[] {
        const m = PROP_TWIN_M, u = unitsPerMetre;
        return [
            [/world:util-pole/, m.pole * u, 0, 0, 'twin'],                     // the poles + their insulators
            [/world:signal-housing/, m.signal * u, 0, 0, 'twin'],
            [/world:lightpoles/, m.lamp * u, 0, 0, 'twin'],
            [/world:detail-roof-equip/, m.roofEquip * u, 0, 0, 'twin'],
            [/world:car-trim|world:car-chrome|world:veh-trim|world:veh-chrome/, m.carTrim * u, 0, 0, 'twin'],   // parked + traffic cars
        ];
    }
    /** P7 DISTANCE-ONLY classes (no zoom-tier change). Vending CANS: ~0.12 m, ~1 px at fine × DIST_LOD_CANS. */
    private static readonly CANS_DIST_LOD = /world:vending-stock/;
    /** P7 TINY: sub-metre DETAIL clutter that the aerial bias kept drawn over a whole tiled world from the air — the
     *  static crowd + walkers + birds, wires, laundry, alley clutter, doors, steel railings, ducts and the rail
     *  sleepers / rails / catenary. Same distance as before. The LIT sign lettering and name plates (sign-text,
     *  textsign-, road signs, warnings) keep the bias: from the air they are the city's colour pops. */
    private static readonly TINY_DIST_LOD = /world:ped-|world:traffic-walker|world:traffic-robot-visor|world:traffic-bird|util-wire|laundry|alley-clutter|world:detail-door|world:detail-railing-steel|world:detail-duct|world:rail-fine-|world:local-fine-/;
    /** P7 SMALL PROPS: the sub-metre members of the PROPS tier (signal housings + lenses, pole insulators, parked-car
     *  trim, tactile paving, cones, manholes, post boxes, cabinets, planters, benches, bikes, banners, bollards,
     *  rail posts, tree grates / guards) + P9 the traffic cars' trim and chrome. PROPS kept them to 1.2 × F like a 6 m tree — 0.5–1 px there. */
    private static readonly SMALL_PROPS_DIST_LOD = /world:signal-|world:util-pole-insulator|world:car-trim|world:car-lens|world:veh-trim|world:veh-chrome|world:tactile|world:cone|world:manhole|world:postbox|world:cabinet|world:planter|world:bench|world:bicycle|world:lamp-banner|world:bridge-railpost|world:water-railposts|world:stair-rail|world:guardrail-bollard|world:tree-grate|world:tree-guard/;
    /** P7 THIN PROPS: poles (utility + lamp posts, ~1.5k triangles each) — read as lines down a street, so they keep
     *  the PROPS distance, but at 0.2–0.3 m wide they take no aerial bias. */
    private static readonly THIN_PROPS_DIST_LOD = /world:util-pole|world:lightpoles/;
    /** Fraction of the aerial bias the P7 classes take (0 = true distance). Console A/B: set it, then
     *  `salsaWorld.distanceLod(true)` to re-stamp. */
    static DIST_LOD_TINY_BIAS = 0;
    /** The vending cans' distance as a fraction of the fine distance. */
    static DIST_LOD_CANS = 0.35;
    /** FINE-detail distance factor (DETAIL / ROOF / sign lettering) relative to the Tier-1 zoom threshold. Their
     *  features are 0.3–1.5 m, a few pixels past this; PROPS (6 m trees, cars) and FLATMAP keep the zoom numbers. */
    static DIST_LOD_FINE = 0.6;
    /** P8 SHADOW LOD: the smallest shadow-relevant feature (metres) of each sub-metre class — cans 0.12 m; the CROWD
     *  0.8 m (a person is 0.5 m across but its shadow runs ~1.7 m along the sun, so it still reads on a 0.4 m texel);
     *  wires, railings and other TINY clutter 0.4 m; SMALL street furniture 0.4 m; THIN poles 0.3 m (their width).
     *  0 = the class always casts. Console A/B: change, then `salsaWorld.distanceLod(true)` to re-stamp. */
    static SHADOW_FEATURE_M = { cans: 0.12, crowd: 0.8, tiny: 0.4, small: 0.4, thin: 0.3 };
    /** Toggle / tune the per-chunk distance LOD. `mul` scales every distance (1 = the zoom-tier thresholds). */
    setCityDistanceLOD(enabled: boolean, mul?: number): void {
        this._distLodOn = enabled;
        if (mul !== undefined && mul > 0) this._distLodMul = mul;
        this._lodCfg = sanitizeCityLodSettings({ distanceLod: enabled, global: this._distLodMul }, this._lodCfg);
        this._distLodKey = '';   // force a re-stamp next frame
        this.scene3d.requestRender3D();
    }

    // ── LOD SETTINGS (docs/ui/performance.md §LOD settings; the City panel's Performance group) ──
    private _lodCfg: CityLodSettings = defaultCityLodSettings();
    private _lodCfgVer = 0;
    private readonly _lodTwinBase = new WeakMap<object, [number, number]>();
    private readonly _lodTint = new LodDebugTint();
    private _lodRendererKey = '';     // renderer-wide settings last written (PCF tier / shadow slack)
    private _lodFamiliesCache: CityLodFamily[] | null = null;
    /** The distance-LOD families, from cityDistanceTiers (so tiers added later show up by themselves). */
    getLodFamilies(): CityLodFamily[] {
        return this._lodFamiliesCache ??= cityLodFamilies(WorldManager.cityDistanceTiers(1));
    }
    /** Change the city LOD settings (merged; `reset: true` = back to the defaults first). Live: re-stamps the draw
     *  distances, rescales the twins, re-pushes the aerial bias and the renderer-wide shadow options. No regen.
     *  Shadow `cascades` / `nearMetres` go to setShadowCascades (persisted with the city lighting as before). */
    setLodSettings(patch: CityLodSettingsPatch & { shadow?: CityLodSettingsPatch['shadow'] & { cascades?: number; nearMetres?: number } }): CityLodSettings {
        const sc = patch?.shadow;
        // P14 shadow quality preset: it sets the cascade count too (an explicit `cascades` in the same patch wins).
        const qc = sc && isShadowQualityPreset(sc.quality) && sc.cascades === undefined ? shadowQualitySpec(sc.quality).cascades : undefined;
        if (sc && (sc.cascades !== undefined || sc.nearMetres !== undefined || qc !== undefined)) this.setShadowCascades({ cascades: sc.cascades ?? qc, nearMetres: sc.nearMetres });
        else if (patch?.reset) this.setShadowCascades({ cascades: 2, nearMetres: 24 });
        const prevTint = this._lodCfg.debugTint;
        this._lodCfg = sanitizeCityLodSettings(patch, this._lodCfgNow());
        this._sim.configure(this._lodCfg.sim);   // SIM LOD: the live settings (Scene3DManager.simLod) follow
        this._distLodOn = this._lodCfg.distanceLod;
        this._distLodMul = this._lodCfg.global;
        this._lodCfgVer++;
        this._distLodKey = '';        // re-stamp next frame
        this._distLodBias = -1;       // re-push the aerial bias
        this._lodAppliedEpoch = -1;   // re-evaluate the zoom tiers
        if (prevTint && !this._lodCfg.debugTint) this._restoreLodTint();
        this._applyLodRenderer();
        this._applyShadowCascades();   // P14: the preset's map sizes / refresh
        this._stampWorldParams();
        this.scene3d.requestRender3D();
        return this.getLodSettings();
    }
    /** The current LOD settings (a copy). */
    getLodSettings(): CityLodSettings { return JSON.parse(JSON.stringify(this._lodCfgNow())); }
    /** The settings with the LIVE sim-LOD group (Scene3DManager.simLod owns it: ShapeManager.setSimLod3D and the
     *  console switch write it directly). */
    /** The scene's sim LOD (a local stand-in for a host without one: unit tests). */
    private readonly _simLocal = new SimLod();
    private get _sim(): SimLod { const l = (this.scene3d as unknown as { simLod?: unknown }).simLod; return l instanceof SimLod ? l : this._simLocal; }
    private _lodCfgNow(): CityLodSettings { this._lodCfg.sim = { ...this._sim.settings }; return this._lodCfg; }
    /** SIM LOD (src/world/sim-lod.ts): merge a patch into the simulation-LOD settings (`{ enabled: false }` = the A/B
     *  switch) — saved with the city LOD settings (only the non-default fields). Returns the settings. */
    setSimLod(patch: CityLodSettingsPatch['sim']): CityLodSettings['sim'] { return this.setLodSettings({ sim: patch ?? {} }).sim; }
    /** The settings as the Performance panel shows them: + the family table (multiplier, distance in units and
     *  metres), the city's shadow cascades, F and the metres-per-unit scale. */
    getLodSettingsView(): CityLodSettingsView {
        return cityLodSettingsView(this._lodCfgNow(), this.getLodFamilies(), this.lodTierF, cityMetresPerUnit(this._params?.radius ?? 10), this.shadowCascades);
    }
    /** Per-family LOD state of the current city (shown / LOD-hidden / zoom-hidden objects and triangles). */
    getLodStats(groupLodHidden: (id: string) => boolean = () => false): CityLodFamilyStats[] {
        const far = this._lodCityR * 2.8 * this._distLodMul;
        const tiers = this._distTiers.length ? this._distTiers : WorldManager.cityDistanceTiers(far);
        return collectCityLodStats(this._groups, tiers, this.getLodFamilies(), groupLodHidden, p => getArrayInstanceCount(p as Parameters<typeof getArrayInstanceCount>[0]));
    }
    /** F, the Tier-1 zoom threshold in world units (draw distances are multiples of it). */
    get lodTierF(): number { return this._lodCityR * 2.8; }
    /** Renderer-wide LOD options (PCF tier, shadow slack): written while a city exists, the defaults otherwise. */
    private _applyLodRenderer(): void {
        const on = !!this._cityContainer;
        const key = on ? `${this._lodCfg.shadow.pcf}|${this._lodCfg.shadow.slackTexels}|${this._lodCfg.shadow.quality}` : 'default';
        if (key === this._lodRendererKey) return;
        this._lodRendererKey = key;
        applyLodRendererSettings(this.scene3d, on ? this._lodCfg : null);
    }
    private _restoreLodTint(): void {
        if (!this._lodTint.active) return;
        this._lodTint.restore();
        this._lastGlowNight = -1;   // let the night glow re-dress the restored colours
        this._redressGlow();
    }
    /** Stamp drawDistance on the city's meshes when the scene or the thresholds changed (never per frame). */
    private _stampDrawDistances(roots: readonly unknown[], force: boolean): void {
        const far = this._distLodOn ? this._lodCityR * 2.8 * this._distLodMul : 0;
        const upm = 1 / cityMetresPerUnit(this._params?.radius ?? 10);
        const sf = WorldManager.SHADOW_FEATURE_M;
        const key = `${far}|${upm}|${sf.cans},${sf.crowd},${sf.tiny},${sf.small},${sf.thin}|${this._lodCfgVer}`;   // + the LOD settings version
        let keyChanged = false;
        if (key !== this._distLodKey) { this._distLodKey = key; this._distTiers = far > 0 ? scaleDistanceTiers(WorldManager.cityDistanceTiers(far, upm), this.getLodFamilies(), this._lodCfg) : []; force = true; keyChanged = true; }
        if (!force) return;
        // P16 lodStampMemo: a restamp forced only by new nodes (the epoch, not the thresholds) skips the groups already
        // stamped for this key with the same node count (streamed tiles are stamped by _applyLodToGroup as they land).
        let list = roots;
        if (STREAM_HITCH.lodStampMemo && !keyChanged) {
            list = roots.filter((r) => {
                const ok = this._stampedFor.get(r as object) === key + '#' + countNodes(r);
                if (ok) streamHitchStats.stampSkipped++;
                return !ok;
            });
        }
        if (!list.length) return;
        assignDrawDistances(list, this._distTiers, WorldManager.fogClassify());
        this._stampLodExtras(list);
        this._noteStamped(list);
    }
    /** P16: the stamp key + node count each world group was last stamped for (see _stampDrawDistances). */
    private readonly _stampedFor = new WeakMap<object, string>();
    private _noteStamped(roots: readonly unknown[]): void {
        if (!STREAM_HITCH.lodStampMemo) return;
        for (const r of roots) { this._stampedFor.set(r as object, this._distLodKey + '#' + countNodes(r)); streamHitchStats.stampDone++; }
    }
    /** LOD settings on top of the draw-distance stamp: the twin swap distances and the debug tint. */
    private _stampLodExtras(roots: readonly unknown[]): void {
        stampTwinDistances(roots, this._lodCfg, this._lodTwinBase);
        if (this._lodCfg.debugTint) this._lodTint.apply(roots, WorldManager.cityDistanceTiers(1));
    }
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
    public _sceneEpoch = 0;
    /** Bumped when a streamed tile lands or is disposed. Tiles deliberately do NOT bump _sceneEpoch (that would make the
     *  LOD re-walk the whole tree per tile — see _addTracked), but the signal / crossing-lamp rescans must see them. */
    private _tileEpoch = 0;
    /** Changes whenever the set of world meshes changes (centre OR streamed tiles) — mesh-scan caches key on this
     *  (bug-hunt 2026-10-01 D-W6: streamed-tile lamps were missed and disposed tile meshes kept referenced). */
    get _meshSetEpoch(): number { return this._sceneEpoch + this._tileEpoch; }
    private _lodAppliedEpoch = -1;
    private _lodFrame = 0;
    private readonly _lodCb = (): boolean => {
        if (this._cityContainer && this._groups.length) {
            try { this._crowd.update(); } catch (err) { if (!this._crowdErr) { this._crowdErr = true; console.error('[world] instanced crowd update failed:', err); } }   // eslint-disable-line no-console
            try { this._liveCrowd.scan(); } catch (err) { if (!this._liveCrowdErr) { this._liveCrowdErr = true; console.error('[world] live crowd scan failed:', err); } }   // eslint-disable-line no-console
            try { this._moverShadows.update(); } catch (err) { if (!this._moverShadowErr) { this._moverShadowErr = true; console.error('[world] mover shadows failed:', err); } }   // eslint-disable-line no-console
        }
        // FOG HORIZON: the fade band is set in metres; the renderer needs world units per metre (the city's scale).
        { const r3 = (this.scene3d as unknown as { renderer3D?: { fogHorizonUnitsPerMetre: number } }).renderer3D;
          if (r3) r3.fogHorizonUnitsPerMetre = this._cityContainer && this._params ? 1 / cityMetresPerUnit(this._params.radius) : 1; }
        // SIM LOD: the band distances are metres — tell it the city's scale (1 m = 1 unit without a city).
        this._sim.view.mpu = this._cityContainer && this._params ? cityMetresPerUnit(this._params.radius) : 1;
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
        // ★ T7.5: perspective metric is CAMERA-AWARE — min(orbit radius, 2 × camera distance to the city's ground
        // disc) (view-cull.ts cityLodMetric). Same as the orbit radius at an overview pitch; at street level / near the
        // edge it collapses, so the detail around the lens stays drawn even while orbiting a far pivot.
        const orbitR = Math.hypot(cam.position[0] - cam.target[0], cam.position[1] - cam.target[1], cam.position[2] - cam.target[2]);
        const ct = this._cityTransform;
        const metric = ortho ? cam.orthoSize
            : cityLodMetric([cam.position[0] - ct.x, cam.position[1] - ct.y, cam.position[2] - ct.z], orbitR, 0, 0,
                this._params?.worldMode === 'tiled' ? Infinity : this._lodCityR, this._params?.groundY ?? 0, 0);
        const R = this._lodCityR;
        // Tier 1 ≈ 25% zoom, Tier 2 (roof objects) ≈ 20% (orthoSize ∝ 1/zoom%, so 25→20 is a ×1.25 bigger orthoSize).
        // Tune Tier 1 via salsaWorld.detailLod(true, <orthoSize>); Tier 2 tracks it at ×1.25.
        // city-quality L5: thresholds raised (was 0.19R / 1.9R) — the default overview framing sat past every tier, so
        // the first view of a city was bare boxes. Still culls when truly zoomed out.
        // LOD settings: the tier thresholds are multiples of F (zoom.*); zoomTiers off = every tier stays shown.
        const zt = this._lodCfg.zoom, ztOn = this._lodCfg.zoomTiers;
        const farDetail = ztOn ? (this._lodFar || (ortho ? R * 0.3 : R * 2.8)) * zt.detail : Infinity;
        const farRoof = ztOn ? (this._lodFar || (ortho ? R * 0.3 : R * 2.8)) * zt.roof : Infinity;
        // Re-hide the hidden tiers only when the scene graph changed (new nodes may have spawned visible). All the
        // add paths bump the epoch (audited), so the safety sweep is a slow backstop (every 300 frames ≈ 5 s), not
        // the twice-a-second full tree walk × 5 tiers it used to be.
        const dirty = this._sceneEpoch !== this._lodAppliedEpoch || (++this._lodFrame % 300 === 0);
        this._lodShown = this._tier(metric, farDetail, this._lodShown, WorldManager.DETAIL_LOD, dirty);
        this._lodRoofShown = this._tier(metric, farRoof, this._lodRoofShown, WorldManager.ROOF_LOD, dirty);
        const farF = farDetail / zt.detail;   // F itself (Infinity when the zoom tiers are off)
        this._lodPropsShown = this._tier(metric, farF * zt.props, this._lodPropsShown, WorldManager.PROPS_LOD, dirty);   // hide props (trees/cars/lamps/furniture) just past fine detail
        this._lodFlatShown = this._tier(metric, farF * zt.flatmap, this._lodFlatShown, WorldManager.FLATMAP_LOD, dirty);   // hide flat-map fine layers a touch past the detail cutoff
        this._lodStructShown = this._tier(metric, farF * zt.structure, this._lodStructShown, WorldManager.STRUCTURE_LOD, dirty);   // Tier 4: extreme zoom-out → basic structure only
        if (dirty) this._lodAppliedEpoch = this._sceneEpoch;   // caught up to the current epoch
        // R6.1: per-chunk distance LOD stamp — only when new nodes arrived or the thresholds moved.
        this._stampDrawDistances(this._groups, this._distLodEpoch !== this._sceneEpoch);
        this._distLodEpoch = this._sceneEpoch;
        // The draw distances grow by the camera's distance to the city VOLUME (0 at street level / inside the city):
        // an aerial overview keeps its detail (the zoom tiers above own that case), street level gets the true per-
        // chunk distances. Half the camera-aware zoom metric with no orbit cap IS that distance. Bucketed (2 % of R).
        const bias = ortho ? 0 : 0.5 * cityLodMetric([cam.position[0] - ct.x, cam.position[1] - ct.y, cam.position[2] - ct.z], Infinity, 0, 0,
            this._params?.worldMode === 'tiled' ? Infinity : this._lodCityR, this._params?.groundY ?? 0, 0);
        const biasOut = this._lodCfg.aerialBias ? bias : 0;   // LOD settings: aerial bias off = true distances from the air too
        if (this._distLodBias < 0 || Math.abs(biasOut - this._distLodBias) > 0.02 * R) { this._distLodBias = biasOut; this.scene3d.setDistanceLod3D({ bias: biasOut }); }
        this._applyLodRenderer();
        if (!ortho) this._zoomOutFog(Math.hypot(cam.position[0] - ct.x, cam.position[1] - ct.y, cam.position[2] - ct.z));
        return false;
    };

    // ★ T7.4 ZOOM-OUT FOG (diorama cities; tiled worlds re-derive theirs in _streamCb). The day/night fog is scaled
    // to the city radius (near ≈ 2.4R) — fine at the default framing, but with the City-mode zoom-out cap gone the
    // camera can pull back until the whole city drowns in haze. Once the camera is farther than 0.6 × the base fog
    // END from the city centre (past every normal framing — the hero view sits ≈ 0.5×), scale both distances by
    // camera→centre / (0.6 × baseFar), so the haze grows with the pull-back. The base is whatever the look /
    // time-of-day last set (detected as "fog differs from what we last wrote"), so weather haze etc. is preserved and
    // it snaps back exactly at normal framing. 2%-gated → no per-frame fog churn.
    private _fogBase: { near: number; far: number } | null = null;
    private _fogWritten: { near: number; far: number } | null = null;
    /** Hard fog edge (sm.setFogHardEdge3D): the user owns the fog — the city must not rescale or replace it. */
    private _fogLocked(): boolean {
        return !!(this.scene3d as unknown as { renderer3D?: { fogHardEdge?: boolean } }).renderer3D?.fogHardEdge;
    }
    /** Called when the hard-fog-edge switch flips. Turning it OFF in City mode hands the fog back to the city. */
    onFogHardEdgeChanged(): void {
        if (this._fogLocked()) return;
        this._fogBase = null; this._fogWritten = null; this._lastFogReach = 0;
        if (this._cityMode && this._timeOfDay != null) this._applyTimeOfDay();
    }
    private _zoomOutFog(camToCentre: number): void {
        if (!this._fogColor || this._params?.worldMode === 'tiled' || this._fogLocked()) return;
        const f = this.scene3d.getFog3D();
        if (f.mode !== 'linear' || !(f.near > 0)) return;
        const w = this._fogWritten;
        if (!w || !this._fogBase || Math.abs(f.near - w.near) > 1e-6 || Math.abs(f.far - w.far) > 1e-6) this._fogBase = { near: f.near, far: f.far };
        const base = this._fogBase;
        const scale = Math.max(1, camToCentre / (base.far * 0.6));   // 1 at every normal framing (hero ≈ 0.5 × far)
        const near = base.near * scale, far = base.far * scale;
        if (Math.abs(near - f.near) <= f.near * 0.02 && !(scale === 1 && near !== f.near)) return;
        this._fogWritten = { near, far };
        this.scene3d.setFog3D({ ...f, near, far });
    }

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
            // hide the node (+ its subtree) — hidden ArrayGroups are skipped in the sync. Never re-show a static the live sim
            // replaced (raised crossing arm / parked train) — it would stand next to the live one (bug-hunt 2026-10-01 D-W5).
            if (re.test(n.name)) { n.visible = show && !(this._traffic.staticsHidden && STATIC_WHILE_LIVE.test(n.name)); continue; }
            if (n.children) for (const k of n.children) stack.push(k as typeof n);
        }
        // ★ Showing needs the host render list rebuilt (it filters `visible` only when it rebuilds) — without this the
        // static crowd / walkers / fine detail hidden at spawn stayed undrawn after zooming in until a 2D pan.
        if (show) this.scene3d.notifyVisibilityChanged3D?.();
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
    // P19: the motion estimate keeps the loop alive until it settles (a stopped camera must be SEEN stopped, or the
    // window stays in its fast state with nothing rendering to notice).
    private readonly _streamCb = (): boolean => this._streamStep() || (this._streamFollow && WorldManager.STREAM19.motionWindow && this._motion.settling);
    private readonly _streamStep = (): boolean => {
        const p = this._params;
        if (!p || p.worldMode !== 'tiled' || !this._cityContainer) return false;
        const span = 2 * (p.radius ?? 0);
        if (span <= 0) return false;
        const cam = this.scene3d.getCamera();
        // ZOOM-OUT CAP + max render distance: never zoom past where `_maxRenderTiles` fill the view — keeps the
        // streamed set bounded and the world always looks populated (ortho: orthoSize; perspective: the orbit
        // radius). Applies whether or not follow is on, whenever a tiled world is active.
        if (cam.mode === 'orthographic') {
            const maxOrtho = this._maxRenderTiles * span;
            if (cam.orthoSize > maxOrtho) { cam.orthoSize = maxOrtho; this.scene3d.requestRender3D(); }
        } else {
            // T7.4: City mode no longer caps the orbit radius at 50 (diorama cities zoom out freely); a TILED world
            // keeps a generous cap tied to its render distance so the streamed ring still fills the view.
            const ctrl = this.scene3d.getOrbitController();
            const maxR = this._maxRenderTiles * span * 1.5;
            if (ctrl && ctrl.radius > maxR) { ctrl.radius = maxR; ctrl.applySpherical(); this.scene3d.requestRender3D(); }
        }
        if (!this._streamFollow) return false;
        // P19 SPEED-AWARE WINDOW: feed the window's focus point (the eye, or the player in Play) to the motion estimate
        // EVERY frame, before the view gates (a camera that stopped must still decay the speed). A fast-state flip
        // re-keys the window even when the view did not change.
        if (WorldManager.STREAM19.motionWindow && this._eyeWindowOn(p)) {
            const ct = this._cityTransform, pf0 = this._playerFocus();
            const ex = cam.mode === 'orthographic' && WorldManager.STEP3.orthoViewCentre ? cam.target : cam.position;
            const [mx, mz] = windowFocusPoint(ex as unknown as ArrayLike<number>, pf0, ct);
            // the adaptive limit: the speed at which a new window row still lands before the focus reaches it
            this._motion.keepUp = keepUpTiles(this._fullLatencyS, this._motion.opts.maxLeadTiles, (p.tileRadius ?? 0) | 0);
            if (this._motion.update(mx, mz, WorldManager._now(), span)) { this._lastVisibleSig = ''; this._lastViewSig = ''; this._lastCoarseSig = ''; }
            // the prediction lead moves by sub-quantum steps as the speed changes: re-run the window scan per lead quantum
            const [lx, lz] = this._motion.lead();
            const lq = `${Math.round(lx * 8)},${Math.round(lz * 8)}`;
            if (lq !== this._lastLeadSig) { this._lastLeadSig = lq; this._lastCoarseSig = ''; this._lastViewSig = ''; }
        }
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
        if (this._fogColor && !this._fogLocked()) {
            const reach = Math.hypot(cam.position[0] - cam.target[0], cam.position[1] - cam.target[1], cam.position[2] - cam.target[2])
                + (cam.mode === 'orthographic' ? cam.orthoSize : 0);
            if (Math.abs(reach - this._lastFogReach) > this._lastFogReach * 0.01) {
                this._lastFogReach = reach;
                // city-quality L8: keep the WEATHER's closer haze (rain / snow) — this used to reset to clear-weather
                // distances on the first camera move.
                const wx = this._params?.weather ?? 'clear';
                const nearK = wx === 'rain' ? 0.6 : wx === 'snow' ? 0.55 : 0.95, farK = wx === 'rain' ? 1.7 : wx === 'snow' ? 1.6 : 2.2;
                this.scene3d.setFog3D({ mode: 'linear', color: this._fogColor, near: reach * nearK, far: reach * farK, density: 0.1 });
            }
        }
        // COARSE MOVEMENT GATE: everything below (centre check, mover/shadow gates, the 121-tile projection scan +
        // sort + key strings) only matters once the camera has moved a MEANINGFUL amount — a 1/32-tile step or ~1%
        // zoom. Small quick back-and-forth pans stay inside one quantum and skip it all (the tile-set membership
        // hysteresis margins are far wider than a quantum, so nothing can change inside one).
        const q = span / 32;
        const pf = this._playerFocus();   // P10.D: in Play the window follows the player
        const csig = `${pf ? Math.round(pf[0] / q) + ':' + Math.round(pf[2] / q) + ':' : ''}${Math.round(cam.target[0] / q)},${Math.round(cam.target[2] / q)},${Math.round(cam.position[0] / q)},${Math.round(cam.position[1] / q)},${Math.round(cam.position[2] / q)},${Math.round(Math.log2(Math.max(1e-3, cam.orthoSize)) * 64)}`;
        if (csig === this._lastCoarseSig) return false;
        this._lastCoarseSig = csig;
        // CENTRE-CITY MOVER GATE: all movers (traffic + clouds) sit over the centre tile (0,0). Once it's fully
        // off-screen — OR the view is zoomed out past the props LOD band, where cars are sub-pixel — they're pure
        // waste (ticked + transform-uploaded every frame); pause + hide, resume when the centre is back and near.
        const vpc = cam.getViewProjectionMatrix() as Float32Array;
        const centreVisible = this._tileScreenRank(vpc, this._cityTransform.x, this._cityTransform.y, this._cityTransform.z, p.radius) >= 0;
        this._centreVisible = centreVisible;
        const moversZoomedOut = cam.mode === 'orthographic' && cam.orthoSize > (this._lodFar || this._lodCityR * 0.19) * 1.2;
        // P10.D EYE WINDOW (tileDetail 'full'): the Tile radius defines the ACTIVE window of full tiles, centred on the
        // tile under the camera eye (the player in Play), and the centre city streams like any other tile — so the keys
        // come first (they decide whether the centre is resident). Legacy: the 9 tiles nearest the camera are full and
        // the centre is only group-HIDDEN when off-screen (its geometry stayed resident).
        const eyeWin = this._eyeWindowOn(p);
        if (eyeWin && this._centreHidden) this._setCentreHidden(false);
        if (!eyeWin && !this._centreResident()) this._restoreCentreNow();
        // Stream exactly the tiles whose footprint is IN THE CAMERA VIEW (projection-based → tracks pan/zoom/orbit).
        // Reconcile only when that tile SET changes (sub-tile pans don't rebuild anything).
        const keys = eyeWin ? this._windowTileKeys(p, cam, span) : this._visibleTileKeys(p, cam, span);
        this._setMoversHidden(!centreVisible || moversZoomedOut || !this._centreResident());   // no-ops when the state is unchanged
        // Off-screen centre → GROUP-hide its non-backdrop groups: thousands of meshes leave the per-frame walk.
        if (!eyeWin) this._setCentreHidden(!centreVisible);
        // Zoomed out past the props band, shadows are sub-pixel — skip the whole-scene shadow depth pass.
        this.scene3d.setShadowsSuspended3D(moversZoomedOut);
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
        // P10.D4: a continuous fly never goes idle — the dead space of the tiles it left stayed in the pool for the whole
        // flight. Past MAX_COMPACT_DEFER ms of deferral, request it now (the renderer still gates it on real waste, and
        // the GPU compaction is ~10-25 ms of CPU, so this is an occasional frame, not a stall).
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        if (!this._compactTimer) this._compactSince = now;
        else if (WorldManager.P10.compactWhileMoving && now - this._compactSince > WorldManager.MAX_COMPACT_DEFER) {
            this._compactSince = now;
            this.scene3d.requestGeomCompaction3D();
        }
        if (this._compactTimer) clearTimeout(this._compactTimer);
        this._compactTimer = setTimeout(() => {
            this._compactTimer = null;
            this.scene3d.requestGeomCompaction3D();
            this.scene3d.requestRender3D();
        }, 350);
    }

    private _compactSince = 0;
    private static readonly MAX_COMPACT_DEFER = 2000;
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
        // Step 2 (C): the resolution setting's `motion` decides whether this move may drop the scale (docs/ui/
        // performance.md §Resolution scaling). Default 'auto': editor moves always; Play (the camera follows the
        // player every frame, so the drop never released) only while the GPU frame is over budget — GPU timing is
        // leased while Play moves the camera so that budget is measured.
        const mc = this.scene3d.getMotionResolutionContext3D?.(0);
        if (mc) {
            const s = mc.settings;
            if (mc.playing && s.motion === 'auto') this.scene3d.getMotionResolutionContext3D(1500);   // keep GPU timing on
            if (!motionDropAllowed(s, mc.playing, s.gpuMs, s.timing, this._dynResOn ? mc.engaged : 1)) {
                if (this._dynResTimer) { clearTimeout(this._dynResTimer); this._dynResTimer = null; }
                this._dynResMoveStart = 0;
                if (this._dynResOn) { this._dynResOn = false; this.scene3d.setDynamicResScale3D(1); this.scene3d.requestRender3D(); }
                return;
            }
        }
        const motionScale = mc?.settings.motionScale ?? 0.78;
        const now = performance.now();
        if (!this._dynResMoveStart) this._dynResMoveStart = now;
        if (!this._dynResOn && now - this._dynResMoveStart >= 150) {
            this._dynResOn = true;
            this.scene3d.setDynamicResScale3D(motionScale);
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
    // P10.D3: byte- AND count-capped (ByteLru) so an endless fly keeps the CPU side flat.
    private readonly _tileRetired = new ByteLru<MeshGroup3D[]>(WorldManager.TILE_RETIRE_CAP, WorldManager.TILE_RETIRE_COUNT);
    private static readonly TILE_RETIRE_CAP = 256 * 1024 * 1024;   // CPU-side cap (~1-3 full tiles since the P9 content growth)
    private static readonly TILE_RETIRE_COUNT = 8;
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
        const vis = this._scanVisibleTiles(p, cam, span, false);
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
        // P10.C1 MASSING TIER: zoomed out past the STRUCTURE band (hysteretic — the LOD tier state), a tile is ~100 px
        // across and the zoom tiers already hide everything but roads, building bodies and roofs. Every streamed tile
        // then builds as the massing tier (flat map + one box per building lot): synchronous, a few ms, no worker
        // round-trip, ~1 draw per zone bucket. Perspective only (the 2D ortho views keep their own zoom tiers).
        if (WorldManager.P10.farMassing && cam.mode !== 'orthographic' && !this._lodStructShown) return vis.map(t => tileKey(t.tx, t.tz, true, false, true));
        return vis.map(t => tileKey(t.tx, t.tz, !full.has(t.id), lite));
    }

    // ── P10.D the ACTIVE window (performance-plan P10.D; tile-window.ts) ──────────────────────────────────────────
    // Follow ON in a 'full' tiled world: the Tile radius setting IS the active window — (2r+1)² FULL tiles around the
    // tile directly below the camera EYE (the player's feet in Play), with a ~12% hysteresis band at tile borders.
    // Everything else in view is the OUTSIDE tier (None / Flat / Massing, setStreamOutsideTiles). The centre city
    // (0,0) is not special: when it leaves the window its groups are PARKED (removed from the scene → their GPU
    // geometry is evicted; the built CPU objects are kept) and it shows as an outside tile; coming back re-attaches
    // them time-sliced (no regeneration — the same seed's same city). Zoomed out past the STRUCTURE band the active
    // tiles are massing too (the zoom tiers hide everything else there); past the PROPS band they build LITE.
    private _focusTile: [number, number] | null = null;
    // ── P19 streaming follow-ups (performance-plan §P19; motion-window.ts). A/B switches, all on by default:
    //  motionWindow     — the window centres on the PREDICTED focus (velocity × look-ahead); outside tiles queue ahead-first
    //  fastWindow       — while fast (≥ MotionWindowOptions.fastTiles), tiles not already full show the stand-in tier
    //                     instead of starting full builds (fast 'landing': plus one full tile at the predicted landing)
    //  dissolveOldTiers — a replaced full / flat / massing / preview tier dissolves out (flags2 bit 5) instead of going
    //                     at once; quantised to OLD_TIER_FADE_STEPS coverage steps (each step = a material rewrite of
    //                     every mesh of the tile); array-group sources stay whole until the tier goes
    //  messageParts     — a worker tile build comes back one group per message (world-jobs postGroupParts), so the main
    //                     thread deserialises it in pieces instead of one 6-15 ms message task
    //  cappedWindow     — between the adaptive keep-up speed and fastTiles (a Play run) the full window is capped to a
    //                     CORRIDOR (motion-window corridorTiles: the tile under the focus + the tiles along its path, as
    //                     far ahead as a build takes to land); off = that band shows stand-ins like the fast state
    //  standInFirst     — while moving, a window tile with NOTHING on screen yet asks for its stand-in (HLOD mid, a
    //                     worker build) before its full build, instead of the stream's synchronous main-thread flat
    //                     preview (18-70 ms a tile in the predicted window's leading row)
    static readonly STREAM19 = { motionWindow: true, fastWindow: true, dissolveOldTiers: true, messageParts: true, cappedWindow: true, standInFirst: true };
    /** Coverage steps of an old (non-HLOD) tier's dissolve (an HLOD tile has ~12 meshes and fades smoothly). */
    static OLD_TIER_FADE_STEPS = 4;
    private readonly _motion = new FocusMotion({ ...MOTION_DEFAULTS });
    private _ownTile: [number, number] | null = null;   // P19: the tile under the focus itself (hysteretic), kept in the window
    private _lastLeadSig = '';
    private _fastStandIns = 0;                           // P19: window tiles showing their stand-in because the window is fast
    private _corridorN = 0;                              // P19: full tiles of the capped corridor (0 = not capped)
    /** P19: the smoothed full-tile latency (s, dispatch → reassembled) — the adaptive fast threshold's input. */
    private _fullLatencyS = DEFAULT_FULL_LATENCY_S;
    private _noteFullLatency(ms: number): void {
        if (!(ms > 0) || !isFinite(ms)) return;
        this._fullLatencyS += 0.3 * (ms / 1000 - this._fullLatencyS);
    }
    /** P19: set the switches (true / false = all; an object = those keys) and / or the motion settings; returns both. */
    setStreamMotion(on?: boolean | Partial<typeof WorldManager.STREAM19>, opts?: Partial<MotionWindowOptions>): { switches: typeof WorldManager.STREAM19; options: MotionWindowOptions } {
        if (on !== undefined) {
            const S = WorldManager.STREAM19 as Record<string, boolean>;
            if (typeof on === 'boolean') for (const k of Object.keys(S)) S[k] = on;
            else for (const [k, v] of Object.entries(on)) if (k in S && typeof v === 'boolean') S[k] = v;
        }
        if (opts) this._motion.opts = sanitizeMotion(this._motion.opts, opts);
        if (on !== undefined || opts) { this._motion.reset(); this._lastVisibleSig = ''; this._lastViewSig = ''; this._lastCoarseSig = ''; this.scene3d.requestRender3D(); }
        return { switches: { ...WorldManager.STREAM19 }, options: { ...this._motion.opts } };
    }
    /** P19 diagnostics: the focus speed (tiles/s), the fast state, the lead, the stand-ins shown for speed. */
    getStreamMotionStats(): { speed: number; state: MotionState; lead: [number, number]; standIns: number; fastAt: number; capAt: number; corridor: number; fullLatencyS: number } {
        const [a, b] = this._motion.lead(), r2 = (v: number): number => Math.round(v * 100) / 100;
        return { speed: r2(this._motion.speed), state: this._motion.state, lead: [r2(a), r2(b)], standIns: this._fastStandIns, fastAt: r2(this._motion.fastAt),
            capAt: r2(this._motion.capAt), corridor: this._corridorN, fullLatencyS: r2(this._fullLatencyS) };
    }
    // P17 (2026-10-03): HLOD is the default outside tier (the flat map + its far massing stay one setting away, and
    // the ortho / 2D views keep them whatever this says). WorldManager.DEFAULT_OUTSIDE_TILES = 'flat' = the old default.
    static DEFAULT_OUTSIDE_TILES: OutsideTiles = 'hlod';
    private _outsideTiles: OutsideTiles = WorldManager.DEFAULT_OUTSIDE_TILES;
    private _eyeWindowOn(p: LayoutParams): boolean { return WorldManager.P10.eyeWindow && p.tileDetail === 'full'; }
    /** The player's feet (world space) while Play runs, else null — the window then centres on the player. */
    private _playerFocus(): ArrayLike<number> | null {
        return (this.scene3d as unknown as { getPlayerFeet3D?: () => ArrayLike<number> | null }).getPlayerFeet3D?.() ?? null;
    }
    private _windowTileKeys(p: LayoutParams, cam: Camera3D, span: number): string[] {
        const ct = this._cityTransform;
        // Step 3 orthoViewCentre: under ORTHO the eye is not where the view is (an oblique / isometric ortho camera sits far
        // off along the view axis, and its dolly is invisible) — the window centres on the VIEW CENTRE (the target).
        const eye = cam.mode === 'orthographic' && WorldManager.STEP3.orthoViewCentre ? cam.target : cam.position;
        const [fx, fz] = windowFocusPoint(eye as unknown as ArrayLike<number>, this._playerFocus(), ct);
        // P19 (motionWindow): the window centres on the PREDICTED focus (the focus + velocity × look-ahead, ≤ 1 tile), so
        // the tiles ahead are asked for first and the trailing ones leave (and are cancelled) earlier; the tile under the
        // focus itself always stays in. Off / still = the focus itself (the P10.D window exactly).
        const S19 = WorldManager.STREAM19, M = this._motion;
        const moving = S19.motionWindow && cam.mode !== 'orthographic';
        const [lu, lv] = moving ? M.lead() : [0, 0];
        const px = fx + lu * span, pz = fz + lv * span;
        const ft = this._focusTile = windowFocusTile(px, pz, span, this._focusTile);
        const own = moving ? (this._ownTile = windowFocusTile(fx, fz, span, this._ownTile)) : ft;
        this._followBackdrop(ft[0] * span, ft[1] * span);   // step 3: the apron / void grid / border glow around the window
        const radius = Math.max(0, Math.min(3, (p.tileRadius ?? 0) | 0));
        const farMass = WorldManager.P10.farMassing && cam.mode !== 'orthographic' && !this._lodStructShown;
        const lite = (p.detailedBuildings ?? false) && !this._lodPropsShown;
        const pack = (tx: number, tz: number): number => (tx + 8192) * 16384 + (tz + 8192);
        const active = new Set<number>();
        const keys: string[] = [];
        let centreWanted = false;
        const hlodOn = this._outsideTiles === 'hlod' && cam.mode !== 'orthographic';
        // (ortho / 2D views keep the flat / massing outside tiers: P17 HLOD is a perspective feature)
        const tier = hlodOn ? 'h' : outsideTier(this._outsideTiles === 'hlod' ? 'flat' : this._outsideTiles, farMass);
        // P19 (fastWindow): while the focus moves fast, tiles that are not full yet show the stand-in tier instead of
        // starting a 2-4 s full build that would be cancelled before it lands (fast 'landing': except the predicted
        // landing tile). Already-full tiles stay full. The stand-in is the outside tier (HLOD mid / massing / flat).
        // P19 (cappedWindow): between the adaptive keep-up speed and fastTiles (a Play run) only the CORRIDOR builds full
        // — the tile under the focus + the tiles along its path, as far ahead as a build takes to land; off = that band
        // shows stand-ins like the fast state (the first P19 build).
        const banded = moving && S19.fastWindow && M.state === 'capped' && !farMass;
        const capped = banded && S19.cappedWindow;
        const fast = moving && S19.fastWindow && (M.state === 'fast' || (banded && !capped)) && !farMass;
        const mo = M.opts;
        let landing: [number, number] | null = null;
        if (fast && mo.fast === 'landing') { const [a, b] = M.landingLead(); landing = [Math.round(fx / span + a), Math.round(fz / span + b)]; }
        const stand = (tx: number, tz: number): string => tier === 'h' ? hlodKey(tx, tz, 'mid') : tileKey(tx, tz, true, false, tier === 'm');
        let wtiles = moving ? predictedWindowTiles(ft, own, radius, px / span, pz / span) : windowTiles(ft[0], ft[1], radius);
        if (landing && !wtiles.some(t => t[0] === landing![0] && t[1] === landing![1])) wtiles.unshift(landing);
        let corridor: Set<number> | null = null;
        if (capped) {
            const ct = corridorTiles(own, fx / span, fz / span, M.vx, M.vz, this._fullLatencyS, mo.capTiles, mo.capAheadTiles);
            corridor = new Set(ct.map(t => pack(t[0], t[1])));
            wtiles = [...ct, ...wtiles.filter(t => !corridor!.has(pack(t[0], t[1])))];   // the corridor dispatches first, in path order
        }
        this._corridorN = corridor ? corridor.size : 0;
        // P19 (standInFirst): while moving, a window tile with nothing on screen yet takes its stand-in first (no sync preview)
        const shown = S19.standInFirst && moving && tier && M.speed > 0.05 ? this._stream.shownChunks() : null;
        let standIns = 0;
        for (const [tx, tz] of wtiles) {
            active.add(pack(tx, tz));
            if (farMass) { keys.push(hlodOn ? hlodKey(tx, tz, 'mid') : tileKey(tx, tz, true, false, true)); continue; }   // P17: zoomed far out, the window is mid HLOD
            const isLanding = !!landing && landing[0] === tx && landing[1] === tz;
            const inCorridor = !!corridor && corridor.has(pack(tx, tz));
            if (tx === 0 && tz === 0) {   // the original centre city — re-attached, never rebuilt
                // P19: a parked centre is not restored mid-fly (its stand-in shows); a resident one stays
                const res = this._centreResident();
                if (corridor ? (inCorridor || res) : fastWindowTier(fast, mo.fast, res, isLanding) === 'full') centreWanted = true;
                else if (tier) { keys.push(stand(0, 0)); standIns++; }
                continue;
            }
            const fk = tileKey(tx, tz, false, lite);
            const isFull = this._stream.isFull(fk);
            const wantFull = corridor ? (inCorridor || isFull) : fastWindowTier(fast, mo.fast, isFull, isLanding) === 'full';
            if (wantFull && shown && !isFull && !this._stream.isInflight(fk) && !this._stream.has(fk) && !shown.has(`${tx},${tz}`) && this._streamSrc.canPreviewKey(fk)) {
                keys.push(stand(tx, tz)); continue;   // standInFirst: the stand-in lands (worker) → the next reconcile asks for the full tile, held over it
            }
            if (wantFull || !tier) keys.push(fk);
            else { keys.push(stand(tx, tz)); standIns++; }
        }
        this._fastStandIns = standIns;
        this._setCentreResident(centreWanted);
        // The centre is coming back (sliced re-attach, hidden until whole): keep a cheap stand-in until it is.
        if (centreWanted && !this._centreResident()) keys.unshift(tier === 'h' ? hlodKey(0, 0, 'mid') : tileKey(0, 0, true, false, tier === 'm'));
        this._syncSkylineRing(p, ft, tier === 'h');   // P19: the optional impostor ring past the HLOD skyline
        if (tier === 'h') this._hlodOutsideKeys(p, cam, span, ft, active, keys);
        else if (tier) {
            for (const t of this._scanVisibleTiles(p, cam, span, true)) {
                if (active.has(t.id)) continue;
                keys.push(tileKey(t.tx, t.tz, true, false, tier === 'm'));
            }
        } else this._prevVisTiles = new Set();
        return keys;
    }

    // ── Step 3: the world-extent BACKDROP follows the window (performance-plan §P13 "Step 3") ─────────────────────
    // The apron, void grid and border glow are built around the origin's tile extent; far from the origin the camera
    // flew past the ring. When the window's focus tile changes they are rebuilt around it in the WORLD worker (the
    // selective-group job, layers moved by whole tiles before the drape, so they sit on the terrain there) and swapped
    // in one frame. Off (WorldManager.STEP3.backdropFollowsWindow = false), follow off or a regen = back at the origin.
    private static readonly BACKDROP = ['World Apron', 'World Void Grid', 'World Border Glow'];
    private _backdropAt: [number, number] = [0, 0];
    private _backdropTok = 0;
    private _followBackdrop(cx: number, cz: number): void {
        if (!WorldManager.STEP3.backdropFollowsWindow) { cx = 0; cz = 0; }
        if (cx === this._backdropAt[0] && cz === this._backdropAt[1]) return;
        const graph = this._graph, p = this._params;
        if (!graph || !p || p.worldMode !== 'tiled') return;
        this._backdropAt = [cx, cz];
        const tok = ++this._backdropTok;
        const half = tiledWorldExtent(p);
        // the backdrop is built AT THE ORIGIN (its own extent square) and moved by the window offset before the drape
        const g2 = { ...graph, params: { ...graph.params }, border: [[half, half], [-half, half], [-half, -half], [half, -half]] as [number, number][],
            bounds: { min: [-half, -half] as [number, number], max: [half, half] as [number, number] } };
        const req = { graph: g2, names: [...WorldManager.BACKDROP], parkedTrain: !this._trafficOn, activeRegions: null, chunk: null,
            contact: null, runBoxes: false, offset: [cx, cz] as [number, number] };
        const swap = (groups: TileLayerGroup[]): void => {
            if (tok !== this._backdropTok || this._graph !== graph) return;
            this._enqueueReassembly(groups, (staged) => {
                if (tok !== this._backdropTok || this._graph !== graph) { for (const g of staged) this.scene3d.removeFlatColorMeshGroup(g, true); return; }
                // P16 (deferredEviction): the old backdrop leaves silently, with ONE host notification after the swap (one
                // per group was a scene-graph event each: ~25 ms of listeners in the swap frame)
                const quiet = STREAM_HITCH.deferredEviction;
                this._removeGroupsByName(WorldManager.BACKDROP, quiet);
                for (const g of staged) { for (const ch of g.children) (ch as Mesh3D).visible = true; this._groups.push(g); }
                if (quiet) this._notifyTiles();
                // Step 3b scopedBackdropLod: the zoom tiers + draw distances for JUST these groups (as a streamed tile
                // gets them); an epoch bump made the next LOD frame re-walk + re-stamp the whole world (~15-25 ms).
                if (WorldManager.STEP3B.scopedBackdropLod) for (const g of staged) this._applyLodToGroup(g);
                else this._sceneEpoch++;
                this._dressGroups(staged);   // the current style + glow on the new backdrop only (a whole-world re-dress was ~100+ ms)
                this.scene3d.requestRender3D();
            }, /*staged*/ true);
        };
        if (this._workersEnabled && typeof requestAnimationFrame !== 'undefined') {
            this._ensureTilePool().buildGroups(req, 'backdrop', 'auto', /*quiet*/ true).then(({ groups }) => swap(groups)).catch(() => { /* superseded / cancelled */ });
        } else swap(buildSelectedGroups(req));
    }
    /** Step 3: the backdrop's current centre (city-local XZ; [0, 0] = around the origin). */
    getBackdropCentre(): [number, number] { return [this._backdropAt[0], this._backdropAt[1]]; }

    /** P10.D: what is OUTSIDE the active window — 'none' (nothing), 'flat' (the flat map; massing once zoomed far out,
     *  default) or 'massing' (massing at every zoom). Live (no regen); the stream re-syncs next frame. */
    setStreamOutsideTiles(mode: OutsideTiles): void {
        if (mode !== 'none' && mode !== 'flat' && mode !== 'massing' && mode !== 'hlod') return;
        this._outsideTiles = mode;
        if (mode !== 'hlod') this._hlodRestoreFar();
        this._lastVisibleSig = ''; this._lastViewSig = ''; this._lastCoarseSig = '';
        this.scene3d.requestRender3D();
    }
    get streamOutsideTiles(): OutsideTiles { return this._outsideTiles; }

    // ── P17 HLOD: merged distant tiles + the endless skyline (performance-plan P17; hlod-select.ts, world/tile-hlod.ts) ──
    // Outside mode 'hlod': every frustum-visible tile outside the window out to the SKYLINE distance (eye-centred, up to
    // `maxTiles`) streams as MID ("|h", merged shells in colour buckets) or FAR ("|f", the 2-draw silhouette) by its
    // eye distance (hysteretic; past the fog's Far under the fog horizon always FAR). Both are cheap worker builds that
    // retire to their own byte-capped LRU. Tier swaps that involve an HLOD tile DISSOLVE (flags2 bit 5): a new HLOD
    // tile fades in over the held old tier, then the old one fades out (HLOD) or goes (full / flat / massing).
    private _hlod: HlodSettings = { ...HLOD_DEFAULTS };
    private readonly _hlodLevel = new Map<number, HlodLevel>();   // packed tile → its level last reconcile (the hysteresis)
    private _hlodFarSaved: number | null = null;                  // the camera's sceneRadius before the skyline raised it
    /** P17 settings (`{ midTiles, skylineTiles, maxTiles, fade, fadeMs }`; session state) → the merged settings. */
    setStreamHlod(patch?: Partial<HlodSettings> | null): HlodSettings {
        if (patch) {
            this._hlod = sanitizeHlod(this._hlod, patch);
            this._lastVisibleSig = ''; this._lastViewSig = ''; this._lastCoarseSig = '';
            this.scene3d.requestRender3D();
        }
        return { ...this._hlod };
    }
    get streamHlod(): HlodSettings { return { ...this._hlod }; }
    /** The fog's Far while the fog horizon is active (Hard edge + linear fog), else 0 (hlodLevelFor's fog rule). */
    private _hlodFogFar(): number {
        const r3 = (this.scene3d as unknown as { renderer3D?: { fogHorizonActive?: boolean; fogConfig?: { far?: number } } }).renderer3D;
        return r3?.fogHorizonActive && r3.fogConfig?.far ? r3.fogConfig.far : 0;
    }
    /** The outside tiles in HLOD mode: frustum-visible tiles within the skyline distance of the focus tile, minus the
     *  window, each MID or FAR by the eye's distance to its box. Also keeps the far plane past the skyline. */
    private _hlodOutsideKeys(p: LayoutParams, cam: Camera3D, span: number, ft: readonly [number, number], active: Set<number>, keys: string[]): void {
        const H = this._hlod, R = p.radius, ct = this._cityTransform, gy = ct.y + (p.groundY ?? 0);
        const eye = cam.position as unknown as ArrayLike<number>;
        const midDist = H.midTiles * span, fogFar = this._hlodFogFar();
        const next = new Map<number, HlodLevel>();
        // P19 (motionWindow): while moving, the outside tiles queue nearest to the PREDICTED eye first (the ones ahead),
        // not nearest to the eye (the frustum's near sides, which the camera is leaving)
        const M = this._motion, ahead = WorldManager.STREAM19.motionWindow && M.speed > 0.05;
        const [au, av] = ahead ? M.lead() : [0, 0];
        const pex = eye[0] + au * span, pez = eye[2] + av * span;
        const out: Array<{ k: string; d: number }> = [];
        for (const t of this._scanVisibleTiles(p, cam, span, true, { radius: H.skylineTiles, cap: H.maxTiles, centre: ft })) {
            if (active.has(t.id)) continue;
            const wx = t.tx * span + ct.x, wz = t.tz * span + ct.z;
            const d = pointBoxDistance(eye[0], eye[1], eye[2], wx - R, gy, wz - R, wx + R, gy + R * 0.9, wz + R);
            const lv = hlodLevelFor(d, this._hlodLevel.get(t.id) ?? null, midDist, fogFar);
            next.set(t.id, lv);
            out.push({ k: hlodKey(t.tx, t.tz, lv), d: ahead ? pointBoxDistance(pex, eye[1], pez, wx - R, gy, wz - R, wx + R, gy + R * 0.9, wz + R) : 0 });
        }
        if (ahead) out.sort((a, b) => a.d - b.d);
        for (const o of out) keys.push(o.k);
        this._hlodLevel.clear();
        for (const [k, v] of next) this._hlodLevel.set(k, v);
        // The skyline must not be far-clipped: autoFar's plane is |eye - target| + 2 × sceneRadius (grow-only here; the
        // value it had is restored when HLOD goes off).
        const want = H.ring ? (H.skylineTiles + H.ringDepth + 0.5) * span * 0.72 : (H.skylineTiles + 1.5) * span * 0.6;   // (P19: the ring's far corners too)
        if (cam.autoFar && cam.sceneRadius < want) {
            if (this._hlodFarSaved === null) this._hlodFarSaved = cam.sceneRadius;
            cam.sceneRadius = want;
        }
    }
    private _hlodRestoreFar(): void {
        if (this._hlodFarSaved === null) return;
        const cam = this.scene3d.getCamera();
        cam.sceneRadius = this._hlodFarSaved;
        this._hlodFarSaved = null;
    }

    // ── P19 the skyline IMPOSTOR RING (optional, setStreamHlod({ ring: true }); world/skyline-ring.ts) ──
    // A band of cheap stand-in buildings past the HLOD skyline, world-anchored per tile, built in the world worker around
    // the window's focus tile and swapped in one frame (like the backdrop) when the focus tile changes. 4 draws.
    private _ringAt = '';
    private _ringTok = 0;
    private _ringGroups: MeshGroup3D[] = [];
    private _syncSkylineRing(p: LayoutParams, ft: readonly [number, number], hlodOn: boolean): void {
        const H = this._hlod;
        const sig = hlodOn && H.ring ? `${ft[0]},${ft[1]}|${H.skylineTiles}|${H.ringDepth}|${p.seed}|${p.palette ?? ''}|${p.nightMode ? 1 : 0}` : '';
        if (sig === this._ringAt) return;
        this._ringAt = sig;
        const tok = ++this._ringTok;
        if (!sig) { this._dropRing(); return; }
        const graph = this._graph;
        const job: RingJob = { params: { ...p }, centre: [ft[0], ft[1]], inner: H.skylineTiles, depth: H.ringDepth };
        const swap = (groups: TileLayerGroup[]): void => {
            if (tok !== this._ringTok || this._graph !== graph) return;
            this._enqueueReassembly(groups, (staged) => {
                if (tok !== this._ringTok || this._graph !== graph) { for (const g of staged) this.scene3d.removeFlatColorMeshGroup(g, true); return; }
                this._dropRing(true);
                for (const g of staged) { for (const ch of g.children) (ch as Mesh3D).visible = true; this._groups.push(g); this._applyLodToGroup(g); }
                this._ringGroups = staged;
                this._dressGroups(staged);
                this._notifyTiles();
                this.scene3d.requestRender3D();
            }, /*staged*/ true);
        };
        if (this._workersEnabled && typeof requestAnimationFrame !== 'undefined' && this._ensureTilePool().available) {
            this._tilePool!.buildRing(job).then(swap).catch(() => { /* superseded / cancelled */ });
        } else swap(buildRingGroups(job));
    }
    private _dropRing(quiet = false): void {
        if (!this._ringGroups.length) return;
        const doomed = new Set(this._ringGroups);
        for (const g of this._ringGroups) this.scene3d.removeFlatColorMeshGroup(g, /*silent*/ true);
        this._groups = this._groups.filter(g => !doomed.has(g));
        this._ringGroups = [];
        if (!quiet) { this._notifyTiles(); this.scene3d.requestRender3D(); }
    }

    // ── P17 HLOD tier-swap dissolves ──
    private _streamSrc!: CityStreamSource;
    /** Running dissolves: `dir` 'in' raises the groups' coverage 0 → 1, 'out' lowers it 1 → 0 and then disposes them
     *  (through the stream source, under `key`, as the stream would have). `t0` may lie in the future (a queued
     *  phase: the old tier fades out once the new one is whole). */
    //  P19: `steps` (an old full / flat tier's dissolve) quantises the coverage to that many levels, `skip` = mesh ids that
    //  stay whole (the array-group sources: their copies would need a group repack per step).
    private _hlodFades: Array<{ groups: MeshGroup3D[]; dir: 'in' | 'out'; t0: number; dur: number; key?: string; preview?: boolean; steps?: number; skip?: Set<string> }> = [];
    private static _now(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
    private _setHlodFade(groups: readonly MeshGroup3D[], v: number, skip?: Set<string>): void {
        for (const g of groups) for (const ch of g.children) {
            const m = ch as Mesh3D;
            if (typeof m.hlodFade !== 'number' || m.hlodFade === v) continue;
            if (skip && v >= 0 && skip.has(m.id)) continue;
            m.hlodFade = v;
            m.materialDirty = true;
        }
    }
    /** P19: the ids of the array-group sources among `groups`' children (they stay whole in an old tier's dissolve: the
     *  instanced copies take the source's fade bit at a group repack, and repacking every group of a full tile per
     *  dissolve step would cost more than the fade is worth). */
    private static _arraySources(groups: readonly MeshGroup3D[]): Set<string> {
        const s = new Set<string>();
        for (const g of groups) for (const ch of g.children) { const id = (ch as { sourceId?: string }).sourceId; if (typeof id === 'string') s.add(id); }
        return s;
    }
    /** An HLOD tile's groups just landed (built, or re-attached from the LRU): start its fade-in (coverage 0 now). */
    private _hlodLanded(groups: MeshGroup3D[], hlod?: HlodLevel | null): MeshGroup3D[] {
        if (!hlod || !groups.length) return groups;
        if (!this._hlod.fade || !(this._hlod.fadeMs > 0) || typeof requestAnimationFrame === 'undefined') { this._setHlodFade(groups, -1); return groups; }
        this._hlodFades = this._hlodFades.filter(f => !f.groups.some(g => groups.includes(g)));
        this._setHlodFade(groups, 0);
        this._hlodFades.push({ groups, dir: 'in', t0: WorldManager._now(), dur: this._hlod.fadeMs });
        this.scene3d.requestRender3D();
        return groups;
    }
    /** StreamSource.crossFade: `next` replaced the held `prev` of the same chunk. True = we dispose `prev` later. */
    private _crossFadeTile(prevKey: string, prev: MeshGroup3D[], prevPreview: boolean, nextKey: string, next: MeshGroup3D[]): boolean {
        const prevH = isHlodKey(prevKey) && !prevPreview, nextH = isHlodKey(nextKey);
        // P19 dissolveOldTiers: every tier swap dissolves its old tier (full ↔ flat / massing too, not only HLOD swaps)
        const old = WorldManager.STREAM19.dissolveOldTiers;
        if (!(prevH || nextH || old) || !this._hlod.fade || !(this._hlod.fadeMs > 0) || typeof requestAnimationFrame === 'undefined') return false;
        const now = WorldManager._now();
        // the new HLOD tier is fading in (started when it landed): the old one stays whole until then
        const fin = nextH ? this._hlodFades.find(f => f.dir === 'in' && f.groups === next) : undefined;
        const after = fin ? Math.max(now, fin.t0 + fin.dur) : now;
        // an HLOD old tier dissolves away smoothly; a full / flat / massing / preview one dissolves in OLD_TIER_FADE_STEPS
        // coverage steps (P19; it used to go at once once the HLOD was whole), its array-group sources whole until it goes
        if (prevH) this._hlodFades.push({ groups: prev, dir: 'out', t0: after, dur: this._hlod.fadeMs, key: prevKey, preview: prevPreview });
        else if (old) this._hlodFades.push({ groups: prev, dir: 'out', t0: after, dur: this._hlod.fadeMs, key: prevKey, preview: prevPreview, steps: Math.max(1, WorldManager.OLD_TIER_FADE_STEPS | 0), skip: WorldManager._arraySources(prev) });
        else this._hlodFades.push({ groups: prev, dir: 'out', t0: after, dur: 0, key: prevKey, preview: prevPreview });
        this.scene3d.requestRender3D();
        return true;
    }
    /** Per frame: advance the dissolves; true while any runs (keeps the on-demand loop rendering). */
    private readonly _hlodFadeCb = (): boolean => {
        if (!this._hlodFades.length) return false;
        const now = WorldManager._now();
        const keep: WorldManager['_hlodFades'] = [];
        let done: WorldManager['_hlodFades'] | null = null;
        for (const f of this._hlodFades) {
            const t = now - f.t0;
            if (t < 0) { keep.push(f); continue; }
            const c = hlodFadeCoverage(t, f.dur);
            if (c >= 1) { (done ??= []).push(f); continue; }
            const v = f.dir === 'in' ? c : 1 - c;
            this._setHlodFade(f.groups, f.steps ? oldTierFadeLevel(v, f.steps) : v, f.skip);
            keep.push(f);
        }
        this._hlodFades = keep;
        let disposed = false;
        if (done) for (const f of done) {
            if (f.dir === 'in') this._setHlodFade(f.groups, -1);
            else { this._setHlodFade(f.groups, -1); this._streamSrc.dispose(f.key ?? '', f.groups, f.preview); disposed = true; }   // (whole again for its LRU stay; it leaves the scene this frame)
        }
        // the old tier left AFTER the reconcile's idle compaction was scheduled (it fires 350 ms after the reconcile, the
        // fade-out ends ~450+ ms after the landing): re-arm it, or the pool kept a swapped-out full window's dead space
        // (~850 MB at the far pose) until the next camera move
        if (disposed) this._scheduleIdleCompact();
        this.scene3d.requestRender3D();
        return true;
    };
    /** Finish every dissolve at once (a stream clear / regen): fade-ins end whole, fade-outs are disposed unkeyed (so
     *  nothing from the old world enters an LRU). */
    private _flushHlodFades(): void {
        const fades = this._hlodFades;
        this._hlodFades = [];
        for (const f of fades) {
            if (f.dir === 'in') this._setHlodFade(f.groups, -1);
            else this._disposeTileGroups(f.groups);
        }
    }
    /** P17 diagnostics: live mid / far HLOD tiles, running dissolves, the HLOD LRU. */
    getHlodStats(): { mid: number; far: number; fades: number; cached: number; cacheMB: number; settings: HlodSettings } {
        let mid = 0, far = 0;
        for (const [k, isFull] of this._stream.liveEntries()) { if (!isFull) continue; const h = parseKey(k).hlod; if (h === 'mid') mid++; else if (h === 'far') far++; }
        return { mid, far, fades: this._hlodFades.length, cached: this._hlodRetired.size, cacheMB: Math.round(this._hlodRetired.bytes / 1048576 * 10) / 10, settings: { ...this._hlod } };
    }

    // ── P10.D centre residency ─────────────────────────────────────────────────────────────────────────────────────
    private _centreParked: { groups: MeshGroup3D[]; graph: WorldGraph | null } | null = null;
    private _centreRestore: { groups: MeshGroup3D[]; i: number; graph: WorldGraph | null; warm?: MeshGroup3D | null; tries?: number } | null = null;
    /** P10.D8: bytes of geometry one warm call uploads (tile reassembly jobs + the centre restore). */
    static WARM_SLICE = 8 << 20;
    private _centreRaf = 0;
    // Centre groups that stay attached while the centre is parked: the world-extent backdrop (CENTRE_KEEP) and the
    // movers' own groups (traffic is off in tiled worlds; if it is forced on, _setMoversHidden pauses + hides it).
    private static readonly CENTRE_STAY = /World Traffic|World Visit Doors|Cloud/;
    private _centreResident(): boolean { return !this._centreParked && !this._centreRestore; }
    private _setCentreResident(want: boolean): void {
        if (want) { if (this._centreParked) this._startCentreRestore(); return; }
        if (this._centreRestore) {   // left again mid-restore → take the part already re-attached back off
            const r = this._centreRestore;
            this._centreRestore = null;
            if (this._centreRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._centreRaf);
            this._centreRaf = 0;
            const back = new Set(r.groups.slice(0, r.i));
            for (const g of back) { this.scene3d.removeFlatColorMeshGroup(g, true); g.visible = true; }
            this._groups = this._groups.filter(g => !back.has(g));
            this._centreParked = { groups: r.groups, graph: r.graph };
            this._tileEpoch++; this._notifyTiles();
            return;
        }
        if (!this._centreParked) this._parkCentre();
    }
    private _parkCentre(): void {
        const keep: MeshGroup3D[] = [], park: MeshGroup3D[] = [];
        for (const g of this._groups) {
            const n = g.name ?? '';
            if (this._tileGroups.has(g) || WorldManager.CENTRE_KEEP.test(n) || WorldManager.CENTRE_STAY.test(n)) keep.push(g); else park.push(g);
        }
        if (!park.length) return;
        this._crowd.onGroupsRemoved(park);   // P12: the lazily built crowd cells are rebuilt on demand
        for (const g of park) this.scene3d.removeFlatColorMeshGroup(g, /*silent*/ true);   // evicts its GPU geometry
        this._groups = keep;
        this._centreParked = { groups: park, graph: this._graph };
        this._tileEpoch++; this._notifyTiles();
        this.scene3d.requestRender3D();
        this._scheduleIdleCompact();
    }
    private _startCentreRestore(): void {
        const pk = this._centreParked!;
        this._centreParked = null;
        if (pk.graph !== this._graph) return;   // the world was rebuilt meanwhile — the new centre is already attached
        this._centreRestore = { groups: pk.groups, i: 0, graph: pk.graph };
        if (typeof requestAnimationFrame === 'undefined') { this._restoreCentreNow(); return; }
        if (this._centreRaf) return;
        const step = (): void => {
            this._centreRaf = 0;
            if (this._centreRestoreStep(4)) this._centreRaf = requestAnimationFrame(step);
            this.scene3d.requestRender3D();
        };
        this._centreRaf = requestAnimationFrame(step);
    }
    /** Re-attach the parked centre at once (follow off / the eye window switched off). */
    private _restoreCentreNow(): void {
        if (this._centreRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._centreRaf);
        this._centreRaf = 0;
        if (this._centreParked) {
            const pk = this._centreParked; this._centreParked = null;
            if (pk.graph !== this._graph) return;
            this._centreRestore = { groups: pk.groups, i: 0, graph: pk.graph };
        }
        while (this._centreRestoreStep(Infinity)) { /* drain */ }
    }
    /** Re-attach parked centre groups for up to `budgetMs` (each one hidden + its geometry warmed); true while more
     *  remain. The last step reveals them all at once and drops the stand-in tile on the next reconcile. */
    private _centreRestoreStep(budgetMs: number): boolean {
        const r = this._centreRestore;
        if (!r) return false;
        const t0 = performance.now();
        const parent = this._ensureCityContainer();
        // P10.D8: each group's geometry uploads in WARM_SLICE pieces (one big group used to be one ~100 ms writeBuffer);
        // hidden groups are not drawn, so nothing else would upload them — the restore finishes each before the reveal.
        const slice = budgetMs === Infinity || !WorldManager.P10.budgetedWarm ? Infinity : WorldManager.WARM_SLICE;
        while (r.i < r.groups.length || r.warm) {
            if (r.warm) {
                const done = this.scene3d.warmGroupGeometry3D(r.warm, slice) || (r.tries = (r.tries ?? 0) + 1) > 64;   // (64: an overflowing pool never stalls the restore)
                if (done) { r.warm = null; r.tries = 0; }
                if (!done || performance.now() - t0 > budgetMs) break;
                continue;
            }
            const g = r.groups[r.i++];
            g.visible = false;   // hidden until the whole centre is back (the stand-in tile shows meanwhile)
            this.scene3d.reattachFlatColorMeshGroup(g, parent, /*silent*/ true);
            this._applyLodToGroup(g);   // the zoom tiers may have moved while it was parked
            this._groups.push(g);
            r.warm = g;
        }
        if (r.i < r.groups.length || r.warm) return true;
        for (const g of r.groups) g.visible = true;
        this._centreRestore = null;
        if (WorldManager.STEP3.refreshReattached) this._redressGroups(r.groups);   // step 3: dressed now, at the world's current glow
        else this._lastGlowNight = -1;   // re-dress the night glow over the re-attached meshes (on the next cycle tick)
        this._tileEpoch++; this._notifyTiles();
        this._lastVisibleSig = ''; this._lastViewSig = ''; this._lastCoarseSig = '';   // drop the stand-in next frame
        this.scene3d.requestRender3D();
        return false;
    }
    /** The world is being rebuilt / cleared: forget a parked centre (its groups are not in the scene) and stop a
     *  restore (its re-attached part is in _groups — the caller removes it with the rest). */
    private _dropCentreParking(): void {
        if (this._centreRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._centreRaf);
        this._centreRaf = 0;
        if (this._centreRestore) for (const g of this._centreRestore.groups) g.visible = true;
        this._centreParked = null;
        this._centreRestore = null;
        this._focusTile = null; this._ownTile = null; this._motion.reset();   // P19: a regen / clear restarts the motion estimate
        this._backdropAt = [0, 0]; this._backdropTok++;   // step 3: a regen / clear rebuilds the backdrop at the origin
        this._ringAt = ''; this._ringTok++; this._ringGroups = [];   // P19: the ring goes with the world's groups (rebuilt by the next window sync)
    }

    /** The tiles in the camera view (frustum test of each tile's box, T7.5), ranked by camera distance, capped at
     *  `_maxLiveTiles` — with the membership hysteresis. `withCentre` = include (0,0) (the P10.D window streams it). */
    private _scanVisibleTiles(p: LayoutParams, cam: Camera3D, span: number, withCentre: boolean, opt?: { radius: number; cap: number; centre: readonly [number, number] }): Array<{ tx: number; tz: number; rank: number; id: number }> {
        const vp = cam.getViewProjectionMatrix() as Float32Array;
        const ctx = this._cityTransform.x, cty = this._cityTransform.y, ctz = this._cityTransform.z;
        const r = p.radius;
        // centre the candidate scan on the orbit look-at tile (P17 HLOD: on the window's focus tile, out to the skyline)
        const cxT = opt ? opt.centre[0] : Math.round((cam.target[0] - ctx) / span);
        const czT = opt ? opt.centre[1] : Math.round((cam.target[2] - ctz) / span);
        const R = opt ? opt.radius : this._maxRenderTiles;
        const pack = (tx: number, tz: number): number => (tx + 8192) * 16384 + (tz + 8192);
        const vis: Array<{ tx: number; tz: number; rank: number; id: number }> = [];
        for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
            const tx = cxT + dx, tz = czT + dz;
            if (!withCentre && tx === 0 && tz === 0) continue;   // centre city — not streamed (legacy)
            const id = pack(tx, tz);
            const margin = this._prevVisTiles.has(id) ? 0.5 : 0.2;   // sticky membership (see hysteresis note)
            const rank = this._tileScreenRank(vp, tx * span + ctx, cty, tz * span + ctz, r, margin);
            if (rank >= 0) vis.push({ tx, tz, rank, id });
        }
        // FULL detail goes to the tiles nearest the SCREEN CENTRE (where you're looking), not nearest the pivot —
        // in an angled/orbit view the pivot sits low on screen, which is why the centre used to read as flat.
        vis.sort((a, b) => a.rank - b.rank);
        const cap = opt ? opt.cap : this._maxLiveTiles;
        if (vis.length > cap) vis.length = cap;   // hard cap (maxLiveChunks safety net)
        this._prevVisTiles = new Set(vis.map(t => t.id));
        return vis;
    }

    /** A tile's ground footprint (a `2r` square at world (wx,wy,wz)) projected to the screen: returns its squared
     *  NDC-centre distance (0 = dead centre of the view) if it's IN the viewport, else −1 (culled). Used both to cull
     *  and to RANK prominence — central tiles get full detail, peripheral ones stay flat proxies. `margin` widens
     *  the in-view test (callers pass a wider one for already-resident tiles — membership hysteresis). */
    private _tileScreenRank(m: Float32Array, wx: number, wy: number, wz: number, r: number, MARGIN = 0.2): number {
        // ★ T7.5 CAMERA-AWARE (view-cull.ts): the tile is a 3D BOX (footprint × tall-building height) tested against
        // the FRUSTUM, ranked by the CAMERA's distance to it. The old test projected only the flat ground footprint's
        // corners — at street level, looking up at the buildings put the ground below the screen, so the tile you
        // stood in (and the centre city) was culled; ranking by NDC-centre also starved the nearest tile of detail.
        const gy = wy + (this._params?.groundY ?? 0);
        return tileViewRank(m, this.scene3d.getCamera().position as unknown as ArrayLike<number>, wx, gy - r * 0.05, wz, r, r * 0.9, MARGIN, 2 * r, this._planeScratch);
    }
    private readonly _planeScratch = new Float64Array(20);

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
        this._focusTile = null; this._ownTile = null; this._motion.reset();
        if (!on) this._followBackdrop(0, 0);   // step 3: the origin grid → the backdrop back around the origin
        if (!on) { this._ringAt = ''; this._ringTok++; this._dropRing(); }   // P19: the ring follows the window only
        if (!on) {
            this._restoreCentreNow();   // P10.D: the origin diorama grid has the centre city in it
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
    getStreamStats(): {
        follow: boolean; live: number; full: number; lite: number; flat: number; massing: number; previews: number;
        window: string; windowTiles: number; focusTile: [number, number] | null; centre: 'resident' | 'parked' | 'restoring'; outside: OutsideTiles; eyeWindow: boolean;
        pending: number; building: boolean; maxDist: number; workers: boolean; cached: number; cacheMB: number; proxyCached: number; proxyCacheMB: number;
        worstJobMs: number; worstJob: string; worstJobTotalMs: number; slicedJobs: number;
        hlodMid: number; hlodFar: number; hlodCached: number; hlodCacheMB: number;
    } {
        // P10.D: ACTUAL resident tiers (`full` used to report the constant full-tile budget, 9, whatever was live).
        // The centre city counts as one FULL tile while it is resident (it is the (0,0) tile of the world).
        const p = this._params;
        const fullWorld = p?.tileDetail === 'full';
        let full = 0, lite = 0, flat = 0, massing = 0, previews = 0;
        for (const [k, isFull] of this._stream.liveEntries()) {
            if (!isFull) { previews++; continue; }
            if (isHlodKey(k)) continue;   // P17: counted as hlodMid / hlodFar
            if (k.endsWith('|m')) massing++;
            else if (k.endsWith('|p') || !fullWorld) flat++;
            else if (k.endsWith('|l')) lite++;
            else full++;
        }
        const centreResident = this._centreResident();
        if (p?.worldMode === 'tiled' && centreResident && (fullWorld || p.tileDetail === 'focus')) full++;
        const r = Math.max(0, Math.min(3, (p?.tileRadius ?? 0) | 0)), n = 2 * r + 1;
        return {
            follow: this._streamFollow, live: this._stream.liveCount + (centreResident ? 1 : 0), full, lite, flat, massing, previews,
            window: `${n}×${n}`, windowTiles: n * n, focusTile: this._focusTile ? [this._focusTile[0], this._focusTile[1]] : null,
            centre: this._centreRestore ? 'restoring' : this._centreParked ? 'parked' : 'resident', outside: this._outsideTiles,
            eyeWindow: !!p && this._eyeWindowOn(p),
            pending: this._stream.pending, building: this._stream.building, maxDist: this._maxRenderTiles, workers: (this._workersEnabled && this._tilePool?.available) ?? false,
            cached: this._tileRetired.size, cacheMB: Math.round(this._tileRetired.bytes / 1048576),
            proxyCached: this._proxyRetired.size, proxyCacheMB: Math.round(this._proxyRetired.bytes / 1048576),
            ...((): { hlodMid: number; hlodFar: number; hlodCached: number; hlodCacheMB: number } => { const h = this.getHlodStats(); return { hlodMid: h.mid, hlodFar: h.far, hlodCached: h.cached, hlodCacheMB: h.cacheMB }; })(),
            worstJobMs: Math.round(this._worstJobMs * 10) / 10, worstJob: this._worstJobName,
            worstJobTotalMs: Math.round(this._worstJobTotalMs * 10) / 10, slicedJobs: this._slicedJobs,   // step 3b: a job's slices summed; jobs run in slices
        };
    }

    private _log(g: WorldGraph): WorldGraph {
        // eslint-disable-next-line no-console
        if (WORLD_VERBOSE) console.log('[world]', { lots: g.lots.length, blocks: g.blocks.length, roads: g.roads.length, border: g.params.border, pattern: g.params.pattern, seed: g.params.seed, radius: g.params.radius });
        return g;
    }

    /** Phase 1 — generate the layout graph + drop its flat top-down preview map in. Resets any existing world. */
    generateLayout(params: Partial<LayoutParams> = {}): WorldGraph {
        params = this._withAdverts(params);
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
            widenToTiledExtent(graph);   // shared with the worker centre build (P5.W2)
            this._reframeAfterTiles = this._autoFrame;   // frame the WHOLE world once the async tiles finish (not just the centre)
            this._syncNeighborTiles(graph.params, false);
        }
        this._add('World Apron', buildApron(graph));            // nature ring beyond the border (draped on terrain)
        this._add('World Void Grid', buildVoidGrid(graph));     // cyberspace grid/rings past the border (flat + unwarped)
        this._add('World Border Glow', buildBorderGlow(graph)); // emissive edge outline (hugs the warped city edge)
        this._graph = graph;
        this._params = graph.params;
        if (!this._pendingCityEnter) this._previewGraph = null;   // a sync build superseded a first async build (P5.W1)
        // Params-only persistence: stamp the regenerate-from params onto the City container (it serializes them
        // in its lightweight save marker — a few hundred bytes — instead of the baked geometry).
        this._stampWorldParams();
        // Non-tiled frames now; tiled frames AFTER its async tiles finish (see _onTilesSettled) so it fits the whole world.
        if (this._autoFrame && !tiled) this.scene3d.frameAllMeshes(1.3);   // auto-frame (suppressed during live slider updates)
        this._redressGlow();     // re-dress fresh meshes (time-of-day glow, or the baseline — never the flat build default)
        return graph;
    }

    /** Stamp the CURRENT city's regenerate-from params (+ transform + lighting) onto the City container's lightweight
     *  save marker. Call after ANY path that swaps `_graph`/`_params` OR changes lighting — otherwise save→reload
     *  rebuilds a STALE city / stale lighting. (The async/worker regen path and the live lighting setters used to
     *  skip this, so a seed/border change through the worker, or a dusk/sun edit, didn't survive a reload.) */
    private _stampWorldParams(): void {
        if (!this._cityContainer || !this._graph) return;
        this._cityContainer.worldParams = { params: WorldManager._stripAdverts(this._graph.params), transform: this._cityTransform, lighting: { timeOfDay: this._timeOfDay, override: this._overrideGlobalLighting, sunAzimuth: this._sunAzimuth, sky: this._skyKeys,
                grade: this._gradeKeys, shadowTints: this._shadowTints, lampColor: this._lampColor, skyLighting: this._skyLighting, reflections: this._reflections, heightFog: this._heightFog, ssao: this._ssaoOn, outlines: this._outlinesCfg,
                groundFinish: this._groundFinish, paving: this._paving, buildingMute: this._buildingMute, paintedClouds: this._paintedClouds, shadowSoftness: this._shadowSoft, sunWarmth: this._sunWarmth, scenePreset: this._scenePreset,
                shadowQuality: { cascades: this._shadowCascades, nearMetres: this._shadowNearM },
                groundContact: { on: this._groundContact, strength: this._groundContactStrength },
                moverShadows: { on: this._moverShadows.on, strength: this._moverShadows.strength },   // visual-polish #16 (absent on an older save = off)
                keyFill: this._keyFill, aerialHaze: this._aerialHazeAmt, ...(this._coolFill > 0 ? { coolFill: this._coolFill } : {}), ...(this._windowGlow !== 1 ? { windowGlow: this._windowGlow } : {}),
                ...(this._skyDome ? { skyDome: this._skyDome } : {}),   // visual-polish #9 (opt-in: absent = the legacy flat sky)
                ...(this._nightSpill > 0 ? { nightSpill: this._nightSpill } : {}), ...(this._wetSheen > 0 ? { wetSheen: this._wetSheen } : {}), ...(this._playerLight > 0 ? { playerLight: this._playerLight } : {}) },   // visual-polish #5 / #7c (opt-in: absent = off)
            ...(!isEmptyStyle(this._style) ? { style: this._style } : {}),
            ...(() => { const d = cityLodSettingsDiff(this._lodCfgNow()); return d ? { lod: d } : {}; })(),   // LOD settings (opt-in: absent = defaults)
            signalTiming: this._traffic.timing };   // E3: traffic-signal phase timing (seconds)
    }

    // ── ADVERTS (docs/ui/garp.md §Adverts) ─────────────────────────────────────────────────────────
    // The user's signage images reach world-gen as `params.adverts` (plain metadata — the tile Worker gets it with
    // the params). The GARP signage library (ShapeManager) is the ONE source of truth: every full build pulls the
    // current catalog through the provider, and the save marker strips it (the library persists in garp.json).
    private _advertsProvider: (() => AdvertCatalog | null) | null = null;
    /** Wire the catalog source (ShapeManager → its GARP signage library). */
    setAdvertsProvider(fn: (() => AdvertCatalog | null) | null): void { this._advertsProvider = fn; }
    private _withAdverts<T extends Partial<LayoutParams>>(p: T): T {
        const cat = this._advertsProvider?.() ?? null;
        const q = { ...p };
        if (cat && cat.entries.length) q.adverts = cat; else delete q.adverts;
        return q;
    }
    private static _stripAdverts(p: LayoutParams): LayoutParams {
        if (!('adverts' in p)) return p;
        const q = { ...p }; delete q.adverts; return q;
    }
    /** Rebuild the city so a signage-library change (image added / removed / Lit toggled / share) shows. No-op
     *  without a city. Async (the old city stays until the swap) when rAF exists, else a sync rebuild. */
    refreshAdverts(): void {
        if (!this._graph || !this._params) return;
        if (this._canAsyncFull()) { this._startAsyncFull({ ...this._params }); return; }   // P5.W2: tiled too
        this._regenNoFrame();
    }

    /** Regenerate the city from a saved doc's City marker (params-only persistence). The host calls this AFTER
     *  loading a document: if a lightweight "City" marker was restored (empty, `worldParams` set), rebuild the
     *  whole city from those params into it. Returns false (no-op) if there's no saved world. */
    /** A saved city's params with every field added after it was saved pinned to its LEGACY value (the marker stores the
     *  full params, so an absent field means the save predates it): adScreens (visual-polish #6), districtPalette +
     *  roofVariety (#11), trafficDensity (#16). Pure; exported for tests via the class. */
    static _pinLegacyParams(p: Partial<LayoutParams>): Partial<LayoutParams> {
        const out: Partial<LayoutParams> = { ...p };
        if (out.adScreens === undefined) out.adScreens = false;
        if (out.districtPalette === undefined) out.districtPalette = false;
        if (out.roofVariety === undefined) out.roofVariety = false;
        if (out.roofEquipment === undefined) out.roofEquipment = 'classic';   // visual-polish #11 tail
        if (out.trafficDensity === undefined) out.trafficDensity = 1;
        return out;
    }
    restoreFromSave(): boolean {
        const c = this.scene3d.findExistingCityContainer();
        const wp = (c as unknown as { worldParams?: { params?: Partial<LayoutParams>; transform?: Partial<{ x: number; y: number; z: number; rx: number; ry: number; rz: number }>; lighting?: { timeOfDay?: number | null; override?: boolean; sunAzimuth?: number; sky?: Partial<Record<TimeGradePhase, SkyKey>> } } } | null)?.worldParams;
        if (!wp || !wp.params) return false;
        if (wp.transform) this._cityTransform = { ...this._cityTransform, ...wp.transform };
        { const st = (wp as { signalTiming?: { green?: number; yellow?: number; allRed?: number } }).signalTiming;
          if (st && typeof st === 'object') this._traffic.setSignalTiming(st); }
        this._style = sanitizeObjectStyle((wp as { style?: unknown }).style);   // the city's saved look (the regen re-applies it)
        this._setLodCfgForLoad(sanitizeCityLodSettings((wp as { lod?: unknown }).lod));   // LOD settings (absent = the defaults)
        // Rebuild the city from its params. NON-TILED cities go through the ASYNC worker regen so a document load
        // doesn't freeze the main thread on the ~500 ms city build (World Streets alone is ~270 ms): the whole city
        // (layout + every group + drape) generates OFF-THREAD, the main thread only reassembles time-sliced, and the
        // city reveals itself via _finishAsync when ready (progressive reveal). That build runs AFTER this load
        // returns (rAF/worker), so it never interleaves with the restore's _isRestoring window, and the params-only
        // City marker means a mid-build autosave still serializes the right thing. TILED worlds stay on the sync path
        // (they need _syncNeighborTiles, which the async path doesn't drive); headless has no rAF, so _startAsyncFull
        // builds synchronously anyway. See docs/specs/god-objects-and-perf.md (async restore).
        // P5.W2: TILED worlds go async too now (tiled-aware worker centre build; the swap re-streams the neighbours).
        // visual-polish #6: a city saved before the ad-screen field existed keeps its legacy 'waves' LED screens (the
        // marker stores the full params, so absent = an old save; new cities save adScreens: true).
        // visual-polish #11 / #16: likewise the district palette + roof variety (absent = the muted B4 look) and the traffic
        // density (absent = the original count, not the new 1.3 default).
        this._startAsyncFull(WorldManager._pinLegacyParams(wp.params), 'load');
        // set AFTER (_startAsyncFull → _abortAsync would clear it); only while the build is still running — headless
        // (no rAF) it already finished inside the call, and a stale flag would swallow the NEXT build's lighting.
        if (this._inflightFullParams()) this._suppressNextFinishLighting = true;
        // Restore the city's saved lighting VALUES — applied the next time City mode is entered (not on load, so a
        // reopened doc doesn't stomp the host's global lighting; enterCityMode picks these up).
        if (wp.lighting) {
            if (typeof wp.lighting.timeOfDay === 'number') this._timeOfDay = wp.lighting.timeOfDay;
            if (typeof wp.lighting.override === 'boolean') this._overrideGlobalLighting = wp.lighting.override;
            if (typeof wp.lighting.sunAzimuth === 'number') this._sunAzimuth = wp.lighting.sunAzimuth;
            // city-quality P1: the saved LOOK (grade keys / shadow tints / lamp colour / sky lighting / reflections).
            const lk = wp.lighting as { grade?: Record<TimeGradePhase, Partial<TimeGradeKey>>; shadowTints?: Record<TimeGradePhase, [number, number, number]>; lampColor?: [number, number, number]; skyLighting?: boolean; reflections?: boolean; heightFog?: number; ssao?: boolean; outlines?: { color: [number, number, number, number]; threshold: number } | null };
            this._gradeKeys = JSON.parse(JSON.stringify(DEFAULT_TIME_GRADE)) as Record<TimeGradePhase, TimeGradeKey>;
            if (lk.grade) for (const k of Object.keys(this._gradeKeys) as TimeGradePhase[]) if (lk.grade[k]) Object.assign(this._gradeKeys[k], lk.grade[k]);
            this._shadowTints = JSON.parse(JSON.stringify(SHADOW_TINTS));
            if (lk.shadowTints) for (const k of Object.keys(this._shadowTints) as TimeGradePhase[]) { const v = lk.shadowTints[k]; if (Array.isArray(v) && v.length === 3) this._shadowTints[k] = [v[0], v[1], v[2]]; }
            this._lampColor = Array.isArray(lk.lampColor) && lk.lampColor.length === 3 ? [lk.lampColor[0], lk.lampColor[1], lk.lampColor[2]] : [1.0, 0.85, 0.55];
            this._skyLighting = !!lk.skyLighting;
            this._reflections = !!lk.reflections;
            this._heightFog = typeof lk.heightFog === 'number' && isFinite(lk.heightFog) ? Math.max(0, lk.heightFog) : 0;
            this._ssaoOn = !!lk.ssao;   // applied on city enter (never stomps the host outside City mode)
            {   // polish-round-3 T1: the clean surface look + scene preset (absent -> the legacy weathered look)
                const cl = wp.lighting as { groundFinish?: string; paving?: string; buildingMute?: number; paintedClouds?: boolean; shadowSoftness?: number; sunWarmth?: number; scenePreset?: string | null };
                this._groundFinish = cl.groundFinish === 'clean' ? 'clean' : 'weathered';
                this._paving = cl.paving === 'tiles' ? 'tiles' : 'slabs';
                this._buildingMute = typeof cl.buildingMute === 'number' && isFinite(cl.buildingMute) ? Math.max(0, Math.min(1, cl.buildingMute)) : 0;
                this._paintedClouds = !!cl.paintedClouds;
                this._shadowSoft = typeof cl.shadowSoftness === 'number' && isFinite(cl.shadowSoftness) ? Math.max(0.5, Math.min(4, cl.shadowSoftness)) : 1.3;
                this._sunWarmth = typeof cl.sunWarmth === 'number' && isFinite(cl.sunWarmth) ? Math.max(0, Math.min(1, cl.sunWarmth)) : 0;
                this._scenePreset = typeof cl.scenePreset === 'string' && cityScenePreset(cl.scenePreset) ? cl.scenePreset : null;
                // persona-polish A2: cascaded-shadow quality (absent = the default: 2 cascades, 24 m near box).
                const sq = (wp.lighting as { shadowQuality?: { cascades?: number; nearMetres?: number } }).shadowQuality;
                this._shadowCascades = WorldManager._cleanCascades(sq?.cascades);
                this._shadowNearM = WorldManager._cleanNearM(sq?.nearMetres);
                // persona-polish A3: contact-shadow blobs (absent = on at 0.55).
                const gc = (wp.lighting as { groundContact?: { on?: boolean; strength?: number } }).groundContact;
                this._groundContact = gc?.on !== false;
                this._groundContactStrength = typeof gc?.strength === 'number' && isFinite(gc.strength) ? Math.max(0, Math.min(1, gc.strength)) : 0.55;
                // visual-polish #16: moving contact blobs (absent = a city saved before them: off, so it reloads unchanged).
                const ms = (wp.lighting as { moverShadows?: { on?: boolean; strength?: number } }).moverShadows;
                this._moverShadows.set(!!ms && ms.on !== false, typeof ms?.strength === 'number' && isFinite(ms.strength) ? ms.strength : MOVER_SHADOW_DEFAULTS.strength);
                // persona-polish A4 / A5 look fields (absent = 0 = the original lighting, so older cities look unchanged).
                const lf = wp.lighting as { keyFill?: number; aerialHaze?: number };
                this._keyFill = typeof lf.keyFill === 'number' && isFinite(lf.keyFill) ? Math.max(0, Math.min(1, lf.keyFill)) : 0;
                this._aerialHazeAmt = typeof lf.aerialHaze === 'number' && isFinite(lf.aerialHaze) ? Math.max(0, Math.min(1, lf.aerialHaze)) : 0;
                const cfv = (wp.lighting as { coolFill?: number }).coolFill;   // visual-polish #4 (absent = 0, the warm fill)
                this._coolFill = typeof cfv === 'number' && isFinite(cfv) ? Math.max(0, Math.min(1, cfv)) : 0;
                this._windowGlow = WorldManager._cleanWindowGlow((wp.lighting as { windowGlow?: number }).windowGlow);   // visual-polish #8 (absent = 1)
                this._skyDome = cleanSkyDome((wp.lighting as { skyDome?: unknown }).skyDome);   // visual-polish #9 (absent = the legacy flat sky)
                {   // visual-polish #5 / #7c (absent = 0 = off: a city saved before keeps its pools, roads and Play lighting)
                    const nl = wp.lighting as { nightSpill?: number; wetSheen?: number; playerLight?: number };
                    this._nightSpill = WorldManager._cleanRange(nl.nightSpill, 1.5);
                    this._wetSheen = WorldManager._cleanRange(nl.wetSheen, 1);
                    this._playerLight = WorldManager._cleanRange(nl.playerLight, 2);
                }
                this._lastGlowNight = -1;
            }
            this._outlinesCfg = WorldManager._copyOutlines(lk.outlines);
            // Restore any authored sky palette (reset to defaults first so a doc without overrides reads clean).
            if (wp.lighting.sky) {
                this._skyKeys = JSON.parse(JSON.stringify(DEFAULT_SKY)) as Record<TimeGradePhase, SkyKey>;
                for (const p of Object.keys(this._skyKeys) as TimeGradePhase[]) {
                    const v = wp.lighting.sky[p];
                    if (v?.top && v?.bottom) this._skyKeys[p] = { top: [v.top[0], v.top[1], v.top[2]], bottom: [v.bottom[0], v.bottom[1], v.bottom[2]] };
                }
            }
        }
        return true;
    }

    /** Content signature of a tiled world — everything that changes a TILE's geometry EXCEPT tileRadius. When this
     *  is unchanged, cached tiles are reused (only the ring that appeared/disappeared rebuilds). */
    private _tileSigOf(p: LayoutParams): string {
        // Exclude tileRadius (grid size — handled separately) + params that DON'T change BAKED tile geometry: the
        // movers (clouds/traffic) and post (fog). Tweaking those must NOT invalidate every tile's cache and rebuild
        // it. (nightMode/weather/pedestrianDensity DO bake into geometry, so they stay in the signature.)
        const { tileRadius, clouds, cloudDensity, paintedClouds, domeClouds, traffic, fog, ...rest } = p;   // eslint-disable-line @typescript-eslint/no-unused-vars
        return JSON.stringify(rest);
    }

    /** Reconcile the streamed neighbour-tile set to `tileRadius` (via the StreamManager): drop tiles that fell out
     *  of range or whose content signature changed, and QUEUE the newcomers for an async build. `keepCache=false`
     *  (a full rebuild) clears the whole cache first. Caching (#2) + async (#3) now live in the StreamManager;
     *  WHICH tiles + HOW to build one live in the CityStreamSource (constructed in the ctor). */
    private _syncNeighborTiles(p: LayoutParams, keepCache: boolean): void {
        const sig = this._tileSigOf(p);
        if (!keepCache || sig !== this._tileSig) {
            this._flushHlodFades(); this._stream.clear();   // NOTE: runs disposals first (which may retire tiles) — so purge retired AFTER
            this._tileRetired.clear();   // params changed → every retired tile is from the OLD world
            this._proxyRetired.clear(); this._hlodRetired.clear();
            this._propGeo.clear();   // P20: the shared prop canonicals of the old world
        }
        this._tileSig = sig;
        this._setCentreHidden(false);   // regen/sync baseline: centre shown (the next _streamCb re-hides if off-screen)
        this._streamSyncNow(p);   // window + detail for the current focus/zoom budget (all-full at origin when follow is off)
    }

    /** CityStreamSource hook: build ONE neighbour tile — flat map (focus/flat) or a full 3D city (full) — and
     *  return its mesh groups. `proxy` (a far tile, Phase 3) forces the cheap flat-map build regardless of
     *  `tileDetail`, so distant tiles cost almost nothing. The StreamManager owns the live cache; the groups also
     *  join `_groups` (so they render / clear / bound like any other world group). */
    private _buildTile(p: LayoutParams, tx: number, tz: number, proxy = false, massing = false, hlod: HlodLevel | null = null): MeshGroup3D[] {
        const full = !proxy && !hlod && p.tileDetail === 'full';
        if (hlod) {   // P17: the HLOD LRU, else the build
            const hit = this._takeRetiredHlod(hlodKey(tx, tz, hlod));
            if (hit) return hit;
            return this._assembleTile(buildTileLayerGroups(p, tx, tz, false, this._tileBuildOpts(false, hlod)), false);
        }
        if (full) {
            // `p` !== the host params object ⇒ the source passed its LITE variant ("|l" tier) — separate LRU key.
            const retired = this._takeRetired(tx, tz, p !== this._tileParamsForBuild);
            if (retired) return retired;
        } else if (WorldManager.P10.proxyCache) {
            const hit = this._takeRetiredProxy(this._cheapTileKey(p, tx, tz, proxy, massing));
            if (hit) return hit;
        }
        return this._assembleTile(buildTileLayerGroups(p, tx, tz, full, this._tileBuildOpts(massing && !full)), full);
    }

    // ── performance-plan P10: streaming fixes, each with an A/B switch (console: salsaWorld.p10(false)) ─────────
    //  tileFrame / seedDedup     — tile content: railway + landmarks in the tile's own frame; no mirrored twin cities
    //  tileContactInWorker       — contact blobs built in the tile build over whole groups (not per reassembly job)
    //  lazyElevation             — flat proxies skip the kerb-lift elevation they never sample
    //  idleTileBounds            — the City gizmo bounds walk (~110-160 ms) runs once the stream is idle, not per drain
    //  coalesceTileNotify        — tile add / remove: a quiet structure bump now, ONE host notification when it settles
    //  cancelStaleTiles          — a tile that leaves the window mid-build is cancelled (worker job + queued reassembly)
    //  previewLite               — lite tiles show the flat proxy while their worker build runs
    //  previewKeyFix             — a dropped preview retires as the flat proxy it is (it was cached as the FULL tile)
    //  proxyCache                — flat / massing tiles retire to a small LRU (pan-back re-attaches, no rebuild)
    //  farMassing                — the zoomed-out MASSING tier (see _visibleTileKeys)
    //  eyeWindow                 — P10.D: Tile radius = the active full window, centred under the eye; the centre streams too
    //  cheapInWorker             — P10.D5: flat / massing tiles are built in the worker pool (was ~18 ms each on the main thread)
    //  terminateCancelled        — P10.D6: a full tile cancelled mid-build kills + respawns its worker (no stale 2-4 s build)
    //  reserveCheapWorkers       — P10.D6: full builds use at most workers − 2 slots; cheap tiles have their own 2-4 slots
    //  heldAsPreview             — P10.D7: a flat tile promoted to full stays as its own stand-in (no second flat build)
    //  budgetedWarm              — P10.D8: tile / centre geometry pre-uploads in WARM_SLICE pieces (no ~100 ms writeBuffer frames)
    //  compactWhileMoving        — P10.D4: a pool compaction deferred > 2 s by continuous motion is requested anyway
    static readonly P10 = {
        tileFrame: true, seedDedup: true, tileContactInWorker: true, lazyElevation: true, idleTileBounds: true,
        coalesceTileNotify: true, cancelStaleTiles: true, previewLite: true, previewKeyFix: true, proxyCache: true, farMassing: true,
        eyeWindow: true, cheapInWorker: true, terminateCancelled: true, reserveCheapWorkers: true, heldAsPreview: true, budgetedWarm: true,
        compactWhileMoving: true,
    };
    // ── Engine-roadmap step 3 (performance-plan §P13 "Step 3"; sm.setStep3Options3D): world-side A/B switches ──────────
    //  incrementalTileBounds — the City gizmo bounds from cached per-geometry boxes, in time slices (was one 132 ms walk)
    //  runBoxes              — full tiles / the centre carry collision-cell run boxes, built in the worker
    //  overlaysFogCulled     — road paint / wear / gutters / storefronts are fog class 'overlay' (culled past Far, no fade)
    //  backdropFollowsWindow — the apron / void grid / border glow are rebuilt around the window's focus tile
    //  refreshReattached     — a re-attached tile / restored centre re-dresses its night glow + render style at once
    //  orthoViewCentre       — under ortho the window centres on the view centre (the target), not the far-off eye
    static readonly STEP3 = { incrementalTileBounds: true, runBoxes: true, overlaysFogCulled: true, backdropFollowsWindow: true, refreshReattached: true, orthoViewCentre: true };
    /** Re-stamp the fog classes / draw distances next frame (a STEP3 classification switch changed). */
    restampLod(): void { this._distLodKey = ''; this._sceneEpoch++; this.scene3d.requestRender3D(); }
    /** Set the P10 switches (true / false = all; an object = those keys) and return them. Streaming re-syncs next frame. */
    setP10Switches(on?: boolean | Partial<typeof WorldManager.P10>): typeof WorldManager.P10 {
        if (on !== undefined) {
            const S = WorldManager.P10 as Record<string, boolean>;
            if (typeof on === 'boolean') for (const k of Object.keys(S)) S[k] = on;
            else for (const [k, v] of Object.entries(on)) if (k in S && typeof v === 'boolean') S[k] = v;
            CityStreamSource.previewLite = WorldManager.P10.previewLite;
            CityStreamSource.previewKeyFix = WorldManager.P10.previewKeyFix;
            StreamManager.heldAsPreview = WorldManager.P10.heldAsPreview;
            this._lastVisibleSig = ''; this._lastViewSig = ''; this._lastCoarseSig = '';
            this.scene3d.requestRender3D();
        }
        return { ...WorldManager.P10 };
    }
    private _tileBuildOpts(massing: boolean, hlod: HlodLevel | null = null): TileBuildOptions {
        const S = WorldManager.P10;
        return { tileFrame: S.tileFrame, seedDedup: S.seedDedup, lazyElevation: S.lazyElevation, massing, ...(hlod ? { hlod } : {}),
            contact: S.tileContactInWorker ? { opacity: this._groundContactStrength } : null, runBoxes: WorldManager.STEP3.runBoxes,
            packInstances: WorldManager.STEP3B.packInstances, propInstancing: WorldManager.P20.propInstancing, splitParts: WorldManager.P20.splitParts,
            drapeMemo: WorldManager.P20.drapeMemo };
    }
    // ── P20 lighter tiles (performance-plan §P20; sm.world.setLighterTiles / salsaWorld.p20): world-side A/B switches ──
    //  propInstancing — full tiles turn repeated street props into canonical geometry + instance transforms (world/
    //                   prop-instancing.ts; exact to ~1 mm); build-side: applies to tiles built after the change
    //  internProps    — an instanced prop's canonical geometry is shared by every tile (one JS object per content key;
    //                   the GPU shares one allocation through the key either way)
    //  splitParts     — with P19 messageParts, a big group comes back as several worker messages (≤ 48 layers / 6 MB
    //                   each, world-jobs splitLayers) instead of one 40-50 MB / ~300-layer message
    //  slotOnWorkerDone — a full tile frees its worker slot when the worker result arrives, not when its main-thread
    //                   reassembly ends: the next wave of a window's tiles starts building ~2-3 s earlier (a 3×3 window
    //                   is 9 builds over 6 full-class slots, so it is two waves)
    //  drapeMemo      — the tile drape evaluates height / gradient / warp once per distinct vertex (x, z) (drape-memo.ts:
    //                   identical output; build-side)
    //  budgetNewSlots — the sliced reassembly attaches at most NEW_SLOTS_PER_FRAME new meshes a frame (the renderer writes
    //                   each one's instance slot the next frame: a burst of attached groups was one unbudgeted write);
    //                   the first group of a frame always attaches
    static readonly P20 = { propInstancing: true, internProps: true, splitParts: true, slotOnWorkerDone: true, drapeMemo: true, budgetNewSlots: true };
    /** P20 budgetNewSlots: new meshes (instance slots) attached a frame by the sliced reassembly. */
    static NEW_SLOTS_PER_FRAME = 600;
    private _newSlotFrame = -1;
    private _newSlotsThisFrame = 0;
    /** Diagnostics: frames a ready group waited for the new-slot budget. */
    private _newSlotWaits = 0;
    /** P20: set the world-side switches (true / false = all; an object = those keys) and the renderer-side ones
     *  (Renderer3D.P20: splitSlotWrites, cheapCompaction); returns both. Build-side switches apply to new tiles. */
    setLighterTiles(on?: boolean | Partial<typeof WorldManager.P20 & typeof Renderer3DP20>): typeof WorldManager.P20 & typeof Renderer3DP20 {
        if (on !== undefined) {
            const S = WorldManager.P20 as Record<string, boolean>, R = Renderer3DP20 as Record<string, boolean>;
            if (typeof on === 'boolean') { for (const k of Object.keys(S)) S[k] = on; for (const k of Object.keys(R)) R[k] = on; }
            else for (const [k, v] of Object.entries(on)) { if (typeof v !== 'boolean') continue; if (k in S) S[k] = v; else if (k in R) R[k] = v; }
            if (!WorldManager.P20.internProps) this._propGeo.clear();
            this.scene3d.requestRender3D();
        }
        return { ...WorldManager.P20, ...Renderer3DP20 };
    }
    /** P22 tile landing (performance-plan §P22): set the world-side switches (WorldManager.P22) and the renderer-side
     *  ones (tile-landing.ts P22_RENDER: packedVertices, propCull) — true / false = all, an object = those keys; returns
     *  both. A packedVertices flip re-places the geometry pool (the next frame rebuilds it in the new format). */
    setTileLanding(on?: boolean | Partial<typeof WorldManager.P22 & typeof Renderer3DP22>): typeof WorldManager.P22 & typeof Renderer3DP22 {
        if (on !== undefined) {
            const S = WorldManager.P22 as Record<string, boolean>, R = Renderer3DP22 as Record<string, boolean>;
            const pk0 = Renderer3DP22.packedVertices;
            if (typeof on === 'boolean') { for (const k of Object.keys(S)) S[k] = on; for (const k of Object.keys(R)) R[k] = on; }
            else for (const [k, v] of Object.entries(on)) { if (typeof v !== 'boolean') continue; if (k in S) S[k] = v; else if (k in R) R[k] = v; }
            if (!WorldManager.P22.landingLedger) TILE_LANDING.active = false;
            if (pk0 !== Renderer3DP22.packedVertices) this.scene3d.repackGeometryPool3D();
            this.scene3d.requestRender3D();
        }
        return { ...WorldManager.P22, ...Renderer3DP22 };
    }
    /** P20 diagnostics: shared prop canonicals held, frames a ready group waited for the new-slot budget. */
    getLighterTilesStats(): { propGeometries: number; newSlotWaits: number } {
        return { propGeometries: this._propGeo.size, newSlotWaits: this._newSlotWaits };
    }
    /** P20 internProps: content key → the one canonical geometry every tile's copies use (bounded; cleared on regen). */
    private readonly _propGeo = new Map<string, LayoutPreviewLayer['geometry']>();
    private _internPropLayers(layers: readonly LayoutPreviewLayer[]): void {
        if (!WorldManager.P20.internProps) return;
        for (const L of layers) {
            if (!L.propInst || !L.instanceKey) continue;
            const g = this._propGeo.get(L.instanceKey);
            if (g) L.geometry = g;
            else { if (this._propGeo.size >= 8192) this._propGeo.clear(); this._propGeo.set(L.instanceKey, L.geometry); }
        }
    }
    /** The stream key of a cheap (non-full) tile build — what `_disposeTileGroups` retires it under. */
    private _cheapTileKey(p: LayoutParams, tx: number, tz: number, proxy: boolean, massing: boolean): string {
        return massing ? `${tx},${tz}|m` : proxy && p.tileDetail === 'full' ? `${tx},${tz}|p` : `${tx},${tz}`;
    }
    // P10 proxyCache: flat / massing tiles are ~10-20 ms to build + reassemble (5× the pre-P9 cost) — a pan back over
    // them used to rebuild every one. Byte-capped LRU like the full-tile one, much smaller (a flat tile is ~1-2 MB).
    private static readonly PROXY_RETIRE_CAP = 64 * 1024 * 1024;
    private static readonly PROXY_RETIRE_COUNT = 96;
    private readonly _proxyRetired = new ByteLru<MeshGroup3D[]>(WorldManager.PROXY_RETIRE_CAP, WorldManager.PROXY_RETIRE_COUNT);
    // P17: HLOD tiles (mid ~1-3 MB, far ~0.3-0.7 MB) retire to their own LRU, so a skyline of 100+ far tiles never
    // pushes the flat / massing tiles out (and the bound is explicit: HLOD_RETIRE_CAP bytes, HLOD_RETIRE_COUNT tiles).
    static HLOD_RETIRE_CAP = 96 * 1024 * 1024;
    static HLOD_RETIRE_COUNT = 192;
    /** P17 A/B: HLOD tiles reassemble ahead of the full-tile jobs (see _tileGroupPrio). false = the old prio 3. */
    static HLOD_REASSEMBLY_FIRST = true;
    private readonly _hlodRetired = new ByteLru<MeshGroup3D[]>(WorldManager.HLOD_RETIRE_CAP, WorldManager.HLOD_RETIRE_COUNT);
    private _takeRetiredHlod(key: string): MeshGroup3D[] | null {
        const hit = this._hlodRetired.take(key);
        if (!hit) return null;
        this._reattachTile(hit);
        return hit;
    }
    private _takeRetiredProxy(key: string): MeshGroup3D[] | null {
        const hit = this._proxyRetired.take(key);
        if (!hit) return null;
        this._reattachTile(hit);
        return hit;
    }
    /** Re-attach a retired tile's groups (shared by both LRUs). */
    private _reattachTile(groups: MeshGroup3D[]): void {
        this._redressGroups(groups);   // step 3: the current glow / style, not the ones it left with
        const parent = this._ensureCityContainer();
        for (const g of groups) {
            this.scene3d.reattachFlatColorMeshGroup(g, parent, /*silent*/ true);
            this._groups.push(g);
            this._tileGroups.add(g);
            this._applyLodToGroup(g);   // scoped — no epoch bump (a bump = a full 5-tier tree walk next frame)
            // P10.D8: a re-attached full tile (~200 MB) used to upload in ONE call; budgeted, the render-time append
            // (GEOM_APPEND_BUDGET per frame) finishes it over the next frames.
            this.scene3d.warmGroupGeometry3D(g, WorldManager.P10.budgetedWarm ? WorldManager.WARM_SLICE / 4 : Infinity);
        }
        this._tileEpoch++;
        this._notifyTiles();   // ONE host notification for the whole re-attached tile
    }
    // P10 coalesceTileNotify: every tile add / remove fired the host's scene-graph event (Frogmarks outliner + Angular
    // change detection + the connector walk, ~5-10 ms each) — a pan streams dozens. Now: the QUIET structure bump at
    // once (mesh caches + render list see the tile this frame), and one host event 250 ms after the last change.
    private _tileNotifyTimer: ReturnType<typeof setTimeout> | null = null;
    private _notifyTiles(): void {
        if (!WorldManager.P10.coalesceTileNotify || typeof setTimeout === 'undefined' || typeof requestAnimationFrame === 'undefined') { this.scene3d.notifySceneGraphChanged3D(); return; }
        this.scene3d.notifySceneStructureChanged3D();
        if (this._tileNotifyTimer) clearTimeout(this._tileNotifyTimer);
        this._tileNotifyTimer = setTimeout(() => { this._tileNotifyTimer = null; this.scene3d.notifySceneGraphChanged3D(); }, 250);
    }
    // P10 cancelStaleTiles: per-key dispatch tokens (a cancel drops it → a result that lands after the cancel is
    // dropped before reassembly) + the key's queued reassembly ctx (a cancel drops its remaining jobs).
    private readonly _tileBuildTok = new Map<string, number>();
    private _tileBuildSeq = 0;
    private readonly _tileReassembly = new Map<string, ReassembleCtx>();
    private _cancelTileBuild(key: string): boolean {
        if (!WorldManager.P10.cancelStaleTiles) return false;
        this._tileBuildTok.delete(key);
        const ctx = this._tileReassembly.get(key);
        if (ctx) {
            this._tileReassembly.delete(key);
            for (let i = this._reassembleQueue.length - 1; i >= 0; i--) if (this._reassembleQueue[i].ctx === ctx) this._reassembleQueue.splice(i, 1);
            this._dropSlice(ctx);   // step 3b: a group being wrapped in slices (detached) goes too
            if (ctx.out.length) this._disposeTileGroups(ctx.out);   // the part already assembled (no key → not retired)
            ctx.remaining = 0;
            ctx.resolve([]);   // settles the build promise; the stream drops it (its in-flight token is gone)
        }
        this._tilePool?.cancelTile(key);
        return true;
    }
    // P10 idleTileBounds: the City gizmo's aggregate bounds walk (_cacheCityBounds, a whole-tree walk of ~10-15 k
    // meshes) ran on EVERY stream drain — a zoomed-out pan drains after each proxy, so it was the largest main-thread
    // cost of a pan (~1.6 s in 4 s). Now once, 400 ms after the stream last went idle.
    private _tileBoundsTimer: ReturnType<typeof setTimeout> | null = null;
    private _scheduleTileBounds(): void {
        if (this._tileBoundsTimer) clearTimeout(this._tileBoundsTimer);
        this._boundsJob = null;   // a newer settle supersedes a walk still in slices
        this._tileBoundsTimer = setTimeout(() => {
            this._tileBoundsTimer = null;
            if (this._stream.pending || this._reassembleQueue.length || this._slice) { this._scheduleTileBounds(); return; }
            if (WorldManager.STEP3.incrementalTileBounds) this._startBoundsJob();
            else this._cacheCityBounds();
        }, 400);
    }
    // Step 3 incrementalTileBounds (group-bounds.ts): the same box from cached per-geometry boxes — only the geometry
    // that arrived since the last walk is scanned — in BOUNDS_SLICE_MS slices, one per macrotask. The walk restarts
    // when the scene structure changes between slices (the box must describe ONE scene state, as the one-shot walk did).
    private _boundsJob: { job: GroupBoundsJob; ver: number; container: MeshGroup3D } | null = null;
    static BOUNDS_SLICE_MS = 3;
    private _startBoundsJob(): void {
        const c = this._cityContainer;
        if (!c) return;
        const st = { job: new GroupBoundsJob(c, WorldManager._boundsExclude), ver: this.scene3d.sceneStructureVersion3D(), container: c };
        this._boundsJob = st;
        const run = (): void => {
            if (this._boundsJob !== st || this._cityContainer !== st.container) return;   // superseded / cleared
            if (this.scene3d.sceneStructureVersion3D() !== st.ver) { this._startBoundsJob(); return; }
            if (!st.job.step(WorldManager.BOUNDS_SLICE_MS)) { setTimeout(run, 0); return; }
            this._boundsJob = null;
            st.container.cachedBounds = st.job.result();
        };
        run();
    }
    private static readonly _boundsExclude = (n: string): boolean => /World Traffic|World Visit Doors|World Void Grid|World Border Glow|World Apron|World Skyline Ring/.test(n);

    /** Reassemble a tile's flat layer-groups (from `_buildTile` OR the Worker pool) into scene MeshGroup3Ds: drape +
     *  make meshes + track into `_groups`, and WARM the geometry (pre-upload) so a full tile's reveal render pays
     *  only the instance repack, not the geometry upload. Shared by the sync and async (worker) build paths. */
    private _assembleTile(groups: TileLayerGroup[], full: boolean): MeshGroup3D[] {
        const out: MeshGroup3D[] = [];
        for (const { name, layers } of groups) this._addTracked(name, layers, out);
        if (full) for (const g of out) this.scene3d.warmGroupGeometry3D(g);
        if (out.length) { this._tileEpoch++; this._notifyTiles(); }   // ONE host notification per tile (adds were silent)
        return out;
    }

    /** Lazily spawn the Worker pool (first full-tile stream OR first async centre regen needs it). */
    private _ensureTilePool(): TileWorkerPool {
        return (this._tilePool ??= new TileWorkerPool());
    }

    /** CityStreamSource hook (Phase 4): generate a FULL tile's geometry in a Worker (off the main thread), then wrap
     *  + upload it on the main thread. If the worker rejects (crash), fall back to a synchronous main-thread build so
     *  the tile still appears. The StreamManager discards the result if the tile left the window while building. */
    /** P10.D5: a CHEAP tile (flat proxy / massing) through the worker pool — null = build it synchronously instead
     *  (switch off, no live pool, or a retired copy re-attaches at once). */
    private _buildCheapTileAsync(p: LayoutParams, tx: number, tz: number, massing: boolean, key: string, hlod: HlodLevel | null = null): Promise<MeshGroup3D[]> | null {
        if (!WorldManager.P10.cheapInWorker || !this._workersEnabled || typeof requestAnimationFrame === 'undefined') return null;
        if (WorldManager.P10.proxyCache && this._proxyRetired.has(key)) return null;
        if (hlod && this._hlodRetired.has(key)) return null;   // P17: a cached HLOD tile re-attaches at once
        if (!this._ensureTilePool().available) return null;
        return this._buildTileAsync(p, tx, tz, key, false, massing, hlod);
    }

    private async _buildTileAsync(p: LayoutParams, tx: number, tz: number, key?: string, full = true, massing = false, hlod: HlodLevel | null = null): Promise<MeshGroup3D[]> {
        if (full) {
            const retired = this._takeRetired(tx, tz, p !== this._tileParamsForBuild);   // LRU hit → re-attach (lite tier keys separately)
            if (retired) return retired;
        }
        const ck = WorldManager.P10.cancelStaleTiles ? key : undefined;   // P10 cancelStaleTiles: cancellable by stream key
        const t0 = WorldManager._now();   // P19: the full-tile latency (dispatch → reassembled) the adaptive fast threshold uses
        const tok = ++this._tileBuildSeq;
        if (ck !== undefined) this._tileBuildTok.set(ck, tok);
        const cancelled = (): boolean => ck !== undefined && this._tileBuildTok.get(ck) !== tok;
        let groups: TileLayerGroup[];
        try {
            // P10.D5/D6: cheap tiles jump the pool queue (tens of ms each); a cancelled FULL build recycles its worker.
            groups = await this._ensureTilePool().build(p, tx, tz, full ? 'visible' : 'interactive', this._tileBuildOpts(massing && !full, full ? null : hlod), ck, full,
                full && ck !== undefined && WorldManager.P10.terminateCancelled, full && WorldManager.STREAM19.messageParts,   // P19: a full tile comes back a group per message
                full && WorldManager.P22.splitTile);   // P22: a full tile builds on two workers (tile-build TILE_HALF_OF)
        } catch (err) {
            if (!this._tileParamsForBuild) throw new Error('world cleared');   // cleared meanwhile (see below)
            // P10: a CANCELLED build (the tile left the window) must not fall back to a seconds-long main-thread build.
            if ((err as Error)?.name === 'JobCancelledError' || cancelled()) throw err;
            if (ck !== undefined) this._tileBuildTok.delete(ck);   // P19: settled (see below)
            return this._buildTile(p, tx, tz, !full, massing && !full, full ? null : hlod);   // worker failed → main-thread fallback (still correct)
        }
        if (cancelled()) throw new Error('tile build cancelled');   // landed after the cancel — skip the reassembly
        // P19: the dispatch is settled — a later cancel goes through the reassembly ctx. The token map used to keep every
        // key ever built (a fly adds ~20-40 a second).
        if (ck !== undefined) this._tileBuildTok.delete(ck);
        // clear() ran while the worker built (it nulls _tileParamsForBuild): reassembling would re-create an orphan
        // City container in the (new / empty) scene — drop the result instead (bug-hunt 2026-10-01). THROW (not []): an
        // empty result would be cached as a completed build (see CityStreamSource.build).
        if (!this._tileParamsForBuild) throw new Error('world cleared');
        if (!groups.length) return [];
        // PROGRESSIVE, TIME-SLICED reassembly: each of a tile's GROUPS (drape + make meshes + upload) is a separate
        // queued job, processed within a per-frame budget in PRIORITY order — ground/roads → buildings → signage →
        // foliage/props. So a streaming tile appears structure-first and decoration fills in, the cost never spikes a
        // frame (workers finish in parallel; this drip-feeds the main-thread work), and proxy-first already shows the
        // flat tile underneath. The tile's Promise resolves when all its groups are assembled.
        return new Promise<MeshGroup3D[]>(resolve => {
            let ctx: ReassembleCtx | null = null;
            const done = (m: MeshGroup3D[]): void => {
                if (ck !== undefined && ctx && this._tileReassembly.get(ck) === ctx) this._tileReassembly.delete(ck);
                if (full && m.length) this._noteFullLatency(WorldManager._now() - t0);   // P19: landed (a cancel resolves [])
                resolve(m);
            };
            // P22 nearFirst: a full tile's jobs rank by its distance from the window focus (ground / roads stay first)
            const ft = this._focusTile, near = full && WorldManager.P22.nearFirst && ft ? Math.max(Math.abs(tx - ft[0]), Math.abs(tz - ft[1])) : -1;
            ctx = this._enqueueReassembly(groups, done, false, near);
            if (ctx && ck !== undefined) this._tileReassembly.set(ck, ctx);
        });
    }

    /** Queue a worker build's layer-groups for time-sliced reassembly (shared by streamed TILES and the CENTRE
     *  worker regen). Returns the ctx (null when there was nothing to queue — `resolve([])` already fired).
     *  `staged` = centre regen: groups assemble HIDDEN via _addStaged and process in BUILD ORDER (per-job index
     *  prio → FIFO), not the tile reveal order; the swap makes them visible. */
    private _enqueueReassembly(groups: TileLayerGroup[], resolve: (m: MeshGroup3D[]) => void, staged = false, near = -1): ReassembleCtx | null {
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
        // W_LAYER (Round 5): every layer is at least one Mesh3D spawn (~50µs ≈ 2.5k vertex floats of wrap+upload) —
        // chunking turns one city-wide layer into up to 100 small cell layers, which vertex-weight alone packed into
        // one job (measured: worst job 8.8 → 16.5 ms "World Streets").
        const W_INST = 6000, W_LAYER = 2500, JOB_BUDGET = 300_000;
        const weight = (L: LayoutPreviewLayer): number => L.geometry.vertices.length + layerInstanceCount(L) * W_INST + W_LAYER;
        const jobs: Array<{ name: string; layers: LayoutPreviewLayer[]; prio: number }> = [];
        for (const g of groups) {
            const cls = this._tileGroupPrio(g.name);
            // P22 nearFirst (near ≥ 0): every tile's ground (class 0) first, then tile by tile from the focus out
            const prio = near >= 0 && cls > 0 ? 1 + near * 4 + cls : cls;
            let cur: LayoutPreviewLayer[] = [], curW = 0;
            const flush = (): void => { if (cur.length) { jobs.push({ name: g.name, layers: cur, prio }); cur = []; curW = 0; } };
            for (const L of g.layers) {
                const w = weight(L);
                const ni = layerInstanceCount(L);
                if (w > JOB_BUDGET && ni > 32) {
                    flush();   // one huge instanced layer → its own jobs, instance list sliced to the budget
                    const per = Math.max(16, Math.floor(ni * JOB_BUDGET / w));
                    for (let i = 0; i < ni; i += per) {
                        const pk = L.instPacked;   // step 3b: a packed list slices packed (unpacked by its job's slice)
                        jobs.push({ name: g.name, layers: [pk ? { ...L, instPacked: slicePacked(pk, i, i + per) } : { ...L, instances: L.instances!.slice(i, i + per) }], prio });
                    }
                    continue;
                }
                if (curW + w > JOB_BUDGET) flush();
                cur.push(L); curW += w;
            }
            flush();
        }
        if (!jobs.length) { resolve([]); return null; }
        // Centre regen assembles in exact BUILD ORDER (deterministic group order in the container = the sync
        // path's), not the tile reveal order — per-job index as prio keeps the min-prio pick FIFO.
        if (staged) jobs.forEach((j, i) => { j.prio = i; });
        const ctx: ReassembleCtx = { out: [], remaining: jobs.length, resolve, staged };
        for (const j of jobs) this._reassembleQueue.push({ name: j.name, layers: j.layers, prio: j.prio, ctx });
        this._pumpReassemble();
        return ctx;
    }

    /** Reveal order for a tile's groups (lower = sooner): ground/roads → buildings → signage → foliage/props. */
    private _tileGroupPrio(name: string): number {
        // P17: an HLOD tile (one small group) goes before EVERY full-tile job. At prio 3 it queued behind the full
        // window's tiles (hundreds of jobs each, re-filled every second of a fly), so the skyline's builds sat finished
        // but unassembled, held the cheap in-flight slots, and the far tiles drained away (live 120 -> 7).
        if (WorldManager.HLOD_REASSEMBLY_FIRST && name.endsWith(' HLOD')) return -1;
        if (/Layout|Water|Road Paint|Terraces/.test(name)) return 0;
        if (/Streets|Landmarks|Shotengai|Railway|Skyway/.test(name)) return 1;
        if (/Signals|Signage|Awnings/.test(name)) return 2;
        return 3;   // Biome (foliage) · Furniture · Pedestrians — decoration last
    }

    // ── P22 tile landing (performance-plan §P22) ─────────────────────────────────────────────────────────────────────
    /** A/B switches (all on; `salsaWorld.p22(...)` / `sm.world.setTileLanding(...)`):
     *  · landingBudget — while the camera is still or slow (motion state 'slow') and full-tile jobs wait, the sliced
     *    reassembly gets LANDING_BUDGET_MS a frame instead of 3 / 6 ms. The landing was bound by that budget: a full
     *    tile is ~150-250 ms of main-thread wrap / attach work, drip-fed at 3 ms a frame behind ~25-40 ms frames.
     *  · nearFirst — a full tile's reassembly jobs rank by the tile's distance from the window focus after the
     *    ground / road class (every tile's ground first, then the focus tile whole, then the ring), so the tile under
     *    the camera lands first instead of every tile finishing together at the end.
     *  · splitTile — a full tile builds as TWO worker jobs (tile-build TILE_HALF_OF: World Streets and the groups that
     *    read its lot stamps / the flat map, water, road paint, foliage, signals, road signs), merged back in build
     *    order: the same groups, byte for byte. A 9-tile window was two waves of whole-tile builds over 6-8 workers.
     *  · landingSlots — while landing (see _landing) the full class keeps all its worker slots: the P17 HLOD backlog
     *    (CityStreamSource.fullCapFor) no longer borrows two of them, so the window's builds start together.
     *  · landingLedger — while landing the renderer's per-frame write ledger is TILE_LANDING.writeBytes (16 MB) instead
     *    of 8 MB (tile-landing.ts), so a landed tile's geometry is resident in half the frames. */
    static readonly P22 = { landingBudget: true, nearFirst: true, splitTile: true, landingSlots: true, landingLedger: true };
    /** The landing reassembly budget per frame (ms); see P22.landingBudget. */
    static LANDING_BUDGET_MS = 10;
    /** Landing = the camera is still or slow (motion state 'slow', not Play) while full-tile work is queued or being
     *  reassembled (`queuedFull`: the caller already knows it). */
    private _landing(queuedFull?: boolean): boolean {
        if (this._motion.state !== 'slow' || this._playerFocus()) return false;
        if (queuedFull) return true;
        if (this._slice && !this._slice.job.ctx.staged) return true;
        for (const j of this._reassembleQueue) if (j.prio >= 0 && !j.ctx.staged) return true;
        return false;
    }
    /** The reassembly pump's budget this frame (ms). */
    private _reassemblyBudgetMs(): number {
        const base = this._stream.queued ? 3 : 6;
        const landing = this._landing();
        TILE_LANDING.active = landing && WorldManager.P22.landingLedger;   // P22 landingLedger (read by the renderer's upload ledger)
        if (!WorldManager.P22.landingBudget || !landing) return base;
        return Math.max(base, WorldManager.LANDING_BUDGET_MS);
    }
    private readonly _reassembleQueue: ReassembleJob[] = [];
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
            // P22 landingBudget: a still / slow camera landing full tiles gets LANDING_BUDGET_MS (see _reassemblyBudgetMs).
            const budget = this._reassemblyBudgetMs(), deadline = t0 + budget;
            this._sliceFrame++;
            do { if (!this._reassembleOne(deadline)) break; } while ((this._reassembleQueue.length || this._slice) && performance.now() < deadline);
            this.scene3d.requestRender3D();
            this._reassembleRaf = this._reassembleQueue.length || this._slice ? requestAnimationFrame(step) : 0;
            if (!this._reassembleRaf) TILE_LANDING.active = false;   // P22: the landing's write boost ends with its last job
        };
        this._reassembleRaf = requestAnimationFrame(step);
    }

    /** Assemble ONE queued group — the lowest-priority pending (ground before buildings before foliage, across all
     *  in-flight tiles). Warms + resolves the tile's Promise once its last group lands. */
    private _reassembleOne(deadline = Infinity): boolean {
        // P17: a queued HLOD tile (prio -1, one small group: ~0.4 ms) never waits for the sliced job — a full-tile group
        // can hold the slice for up to REASSEMBLY_WARM_FRAMES frames while its upload drips in — and assembles ONE-SHOT.
        let hi = -1;
        if (this._slice && WorldManager.HLOD_REASSEMBLY_FIRST) { for (let i = 0; i < this._reassembleQueue.length; i++) if (this._reassembleQueue[i].prio < 0) { hi = i; break; } }
        if (this._slice && hi < 0) return this._reassembleSlice(deadline);   // step 3b: the job being wrapped in slices goes first
        if (!this._reassembleQueue.length) return false;
        let bi = hi;
        if (bi < 0) { bi = 0; for (let i = 1; i < this._reassembleQueue.length; i++) if (this._reassembleQueue[i].prio < this._reassembleQueue[bi].prio) bi = i; }
        const job = this._reassembleQueue.splice(bi, 1)[0];
        if (!job.ctx.staged && WorldManager.STEP3B.slicedReassembly && !(job.prio < 0)) { this._startSlice(job); return this._reassembleSlice(deadline); }
        for (const L of job.layers) unpackLayerInstances(L);   // (step 3b packInstances with the slicing off: whole job now)
        const jt0 = performance.now();
        const nBefore = job.ctx.out.length;
        if (job.ctx.staged) {
            // CENTRE worker regen: stage HIDDEN (no tile tracking / LOD apply — the swap bumps _sceneEpoch),
            // mirroring _asyncStep's staging. preDraped → the height/warp fns are unused.
            this._addStaged(job.name, job.layers, this._heightFn, this._smoothFn, this._warpInto, job.ctx.out, /*silent*/ true, /*preDraped*/ true);
            if (job.ctx.out.length > nBefore) {
                const g = job.ctx.out[job.ctx.out.length - 1];
                for (const ch of g.children) (ch as Mesh3D).visible = false;   // hidden until the swap
                this.scene3d.warmGroupGeometry3D(g);   // pre-upload while hidden → the reveal is a visibility flip
            }
        } else {
            this._addTracked(job.name, job.layers, job.ctx.out);   // layers arrive pre-draped from the worker
            // WARM (pre-upload geometry) per job, not per tile — batching all warms at tile completion landed the
            // whole tile's writeBuffer bytes on ONE frame, the opposite of the drip-feed intent.
            // P10.D8: budgeted — a job's 18 MB crowd layer was one ~60-180 ms frame; the rest lands via the render append.
            if (job.ctx.out.length > nBefore) this.scene3d.warmGroupGeometry3D(job.ctx.out[job.ctx.out.length - 1], WorldManager.P10.budgetedWarm ? WorldManager.WARM_SLICE : Infinity);
        }
        // The budget check runs BETWEEN jobs — one heavy group (drape + mesh construction) can still blow a frame.
        // Track the worst job so `streamStats()` can prove/disprove that in the field.
        const jMs = performance.now() - jt0;
        if (jMs > this._worstJobMs) { this._worstJobMs = jMs; this._worstJobName = job.name; }
        if (jMs > this._worstJobTotalMs) this._worstJobTotalMs = jMs;
        this._finishJob(job);
        return true;
    }
    private _finishJob(job: ReassembleJob): void {
        if (--job.ctx.remaining === 0) {
            // Staged (centre) completion stays SILENT — the swap notifies once after the reveal.
            if (!job.ctx.staged) this._notifyTiles();   // ONE host notification per tile (the group adds were silent; warms happened per job)
            job.ctx.resolve(job.ctx.out);
        }
    }

    // ── Step 3b: SLICED reassembly (performance-plan §P13 "Step 3b"; WorldManager.STEP3B.slicedReassembly) ──────────
    // One tile job (a group chunk) used to run in one go: wrap every layer into meshes, attach, LOD, crowd register,
    // warm its geometry — 20-50 ms for a heavy group (the budget was only checked BETWEEN jobs). Now a job is a small
    // state machine run inside the pump's per-frame budget, a few meshes at a time:
    //   wrap   — the group is built DETACHED (scene3d begin / addFlatColorLayer3D), REASSEMBLY_CHECK_UNITS meshes
    //            between clock checks;
    //   warm   — its geometry pre-uploads in REASSEMBLY_WARM_BYTES pieces (still detached: nothing draws it);
    //   attach — one step: attach + crowd register + scoped LOD + tracking, exactly the one-shot tail.
    // The group enters the scene only complete, with its geometry resident, so no frame shows part of it; until then
    // the tile's stand-in (the flat preview, or the groups already attached) shows, as before. Same meshes, same order.
    static readonly STEP3B = { slicedReassembly: true, packInstances: true, scopedBackdropLod: true };
    /** Meshes wrapped between two clock checks. */
    static REASSEMBLY_CHECK_UNITS = 8;
    /** Tests: at most this many mesh units per slice (Infinity = time only). */
    static REASSEMBLY_SLICE_UNITS = Infinity;
    /** Bytes of geometry one warm call of a slice uploads (= Renderer3D.UPLOAD_GEOM_SLICE: a geometry up to that size
     *  goes in one write; a bigger one is written by the renderer one 4 MB slice a frame). */
    static REASSEMBLY_WARM_BYTES = 4 << 20;
    /** Frames in a row whose first warm call made no geometry resident before the group attaches anyway (a geometry
     *  over 4 MB lands one slice a frame, so it becomes resident only at its last slice: 8 frames ≈ 32 MB). */
    static REASSEMBLY_WARM_STALL = 8;
    /** Frames a group waits for its warm before it attaches anyway (an over-full pool must never hold a tile back;
     *  the render-time append uploads the rest, as before step 3b). */
    static REASSEMBLY_WARM_FRAMES = 120;
    private _slice: SliceJob | null = null;
    private _sliceFrame = 0;
    private _slicedJobs = 0;
    private _worstJobTotalMs = 0;

    private _startSlice(job: ReassembleJob): void {
        // = _addTracked → _addStaged(preDraped, chunk=false) → _addCrowdAware, split at its mesh-spawn loop
        let layers = job.layers;
        let crowd: LayoutPreviewLayer[] | null = null;
        if (layers.length) {
            if (!isContactDone(layers)) { for (const L of layers) unpackLayerInstances(L); layers = this._withContactShadows(layers); }
            for (const L of layers) if (L.crowdAux || L.crowdInst) (crowd ??= []).push(L);
            if (crowd) {
                for (const L of crowd) if (L.crowdInst && L.instanceKey) L.geometry = this._crowd.intern(L.instanceKey, L.geometry);
                layers = layers.filter(L => !L.crowdAux);
            }
            this._internPropLayers(layers);   // P20: every tile's copies of a prop variant share one canonical geometry
        }
        this._slice = { job, layers, crowd, group: job.layers.length ? this.scene3d.beginFlatColorMeshGroup3D(job.name) : null,
            li: 0, ui: 0, phase: 0, warmFrame: -1, warmFrames: 0, stall: 0, ms: 0 };
        this._slicedJobs++;
    }

    /** Run the current sliced job until `deadline` (at least one unit of work). False = it waits for the next frame. */
    private _reassembleSlice(deadline: number): boolean {
        const S = this._slice!, t0 = performance.now();
        try {
            const g = S.group;
            if (!g) { this._slice = null; this._finishJob(S.job); return true; }   // an empty job (no group, as _addTracked)
            if (S.phase === 0) {
                const cap = WorldManager.REASSEMBLY_SLICE_UNITS, every = WorldManager.REASSEMBLY_CHECK_UNITS;
                let units = 0;
                while (S.li < S.layers.length) {
                    const L = S.layers[S.li];
                    if (L.instPacked) unpackLayerInstances(L);   // step 3b packInstances: this layer's objects, now
                    const total = this.scene3d.flatColorLayerUnits3D(L as FlatColorLayer3D);
                    const n = Math.max(1, Math.min(total - S.ui, every, cap - units));
                    S.ui = this.scene3d.addFlatColorLayer3D(g, L as FlatColorLayer3D, S.ui, n);
                    units += n;
                    if (S.ui >= total) { S.li++; S.ui = 0; }
                    if (units >= cap || performance.now() >= deadline) break;
                }
                if (S.li < S.layers.length) return true;
                S.phase = 1;
                if (units >= cap || performance.now() >= deadline) return true;
            }
            if (S.phase === 1) {
                // Headless (no frames) / budgetedWarm off: one warm call, as the one-shot path, then attach.
                if (typeof requestAnimationFrame === 'undefined' || !WorldManager.P10.budgetedWarm) {
                    this.scene3d.warmGroupGeometry3D(g, WorldManager.P10.budgetedWarm ? WorldManager.WARM_SLICE : Infinity);
                    S.phase = 2;
                } else {
                    const first = S.warmFrame !== this._sliceFrame;
                    if (first) { S.warmFrame = this._sliceFrame; S.warmFrames++; }
                    let done = false, calls = 0;
                    for (;;) {
                        const before = this._unwarmed(S, g);
                        done = this.scene3d.warmGroupGeometry3D(g, WorldManager.REASSEMBLY_WARM_BYTES);
                        const moved = this._unwarmed(S, g) !== before;
                        // a frame's FIRST call that lands nothing: REASSEMBLY_WARM_STALL such frames in a row and the
                        // group attaches (the render-time append finishes it, as before step 3b)
                        if (first && calls === 0) S.stall = moved ? 0 : S.stall + 1;
                        calls++;
                        if (done || !moved || performance.now() >= deadline) break;
                    }
                    // not resident yet: wait for the next frame (false = no more work THIS frame: its upload budget
                    // is spent), up to REASSEMBLY_WARM_FRAMES frames
                    if (!done && S.stall < WorldManager.REASSEMBLY_WARM_STALL && S.warmFrames < WorldManager.REASSEMBLY_WARM_FRAMES) return performance.now() >= deadline;
                    S.phase = 2;
                    if (performance.now() >= deadline) return true;
                }
            }
            // P20 budgetNewSlots: the renderer writes every NEWLY attached mesh's instance slot in its next frame — bound how
            // many a frame brings (the first group of a frame always goes; a bigger one waits for the next frame)
            if (WorldManager.P20.budgetNewSlots) {
                const n = g.children.length;
                if (this._newSlotFrame !== this._sliceFrame) { this._newSlotFrame = this._sliceFrame; this._newSlotsThisFrame = 0; }
                if (this._newSlotsThisFrame > 0 && this._newSlotsThisFrame + n > WorldManager.NEW_SLOTS_PER_FRAME) { this._newSlotWaits++; return false; }
                this._newSlotsThisFrame += n;
            }
            // attach: the one-shot tail (_addCrowdAware's attach + register, _addTracked's tracking + scoped LOD)
            this.scene3d.attachFlatColorMeshGroup3D(g, this._ensureCityContainer(), /*silent*/ true);
            if (S.crowd) this._crowd.register(g, S.crowd);
            this._groups.push(g);
            S.job.ctx.out.push(g);
            this._tileGroups.add(g);
            this._applyLodToGroup(g);
            this._slice = null;
            this._finishJob(S.job);
            return true;
        } finally {
            const ms = performance.now() - t0;
            S.ms += ms;
            if (ms > this._worstJobMs) { this._worstJobMs = ms; this._worstJobName = S.job.name; }
            if (S.ms > this._worstJobTotalMs) this._worstJobTotalMs = S.ms;
        }
    }
    /** Meshes of the sliced group whose geometry is not resident yet (the list shrinks as they land: O(left)). */
    private _unwarmed(S: SliceJob, g: MeshGroup3D): number {
        let p = S.unwarmed;
        if (!p) { p = S.unwarmed = []; for (const ch of g.children) { const m = ch as Mesh3D; if (m.geometry?.vertices?.length) p.push(m); } }
        let k = 0;
        for (let i = 0; i < p.length; i++) if (!this.scene3d.hasMeshGeometry3D(p[i])) p[k++] = p[i];
        p.length = k;
        return k;
    }
    /** Drop the sliced job (of `ctx`, or any): its detached group's meshes leave the picker / renderer caches. */
    private _dropSlice(ctx?: ReassembleCtx): void {
        const S = this._slice;
        if (!S || (ctx && S.job.ctx !== ctx)) return;
        this._slice = null;
        if (S.group) this.scene3d.removeFlatColorMeshGroup(S.group, /*silent*/ true);
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
        this._crowd.onGroupsRemoved(groups);   // P12: the lazily built crowd cells go first (rebuilt on demand; not cached)
        const doomed = new Set(groups);
        for (const g of groups) {
            this.scene3d.removeFlatColorMeshGroup(g, /*silent*/ true);
            this._tileGroups.delete(g);
        }
        this._groups = this._groups.filter(g => !doomed.has(g));   // ONE O(N) pass (was indexOf+splice per group = O(groups×N))
        if (groups.length) { this._tileEpoch++; this._notifyTiles(); }   // ONE host notification per disposed tile
        if (key === undefined || !groups.length) return;
        // Cheap tiles (flat proxies "|p", massing "|m", every tile of a flat / focus world) → the small proxy LRU (P10).
        // Full and LITE ("|l") tiles → the full-tile LRU (both are expensive 3D builds worth caching).
        this._hlodFades = this._hlodFades.filter(f => !f.groups.some(g => doomed.has(g)));   // P17: a disposed tile's dissolve ends
        this._setHlodFade(groups, -1);   // P19: any tier (not only HLOD) may be mid-dissolve: it comes back whole
        const hl = isHlodKey(key);
        const cheap = hl || key.endsWith('|p') || key.endsWith('|m') || this._params?.tileDetail !== 'full';
        if (cheap && !WorldManager.P10.proxyCache) return;
        let bytes = 0;
        for (const g of groups) for (const ch of g.children) {
            const geo = (ch as { geometry?: { vertices: Float32Array; indices?: Uint32Array } }).geometry;
            if (geo) bytes += geo.vertices.byteLength + (geo.indices ? geo.indices.byteLength : 0);
        }
        if (hl) { this._setHlodFade(groups, -1); this._hlodRetired.put(key, groups, bytes); return; }   // P17: whole when it comes back (its fade-in restarts)
        if (cheap) {
            this._proxyRetired.put(key, groups, bytes);
            return;
        }
        this._tileRetired.put(key, groups, bytes);   // byte + count capped LRU (oldest evicted first)
    }

    /** Take a retired tile out of the LRU and RE-ATTACH its groups to the scene — the cache-hit rebuild path.
     *  Geometry is already draped and positioned; the only remaining cost is the GPU re-upload (spread by
     *  warmGeometry) + incremental instance slots. LOD tier states may have moved while the tile was away, so
     *  each group's children are reconciled against the CURRENT tier states. */
    private _takeRetired(tx: number, tz: number, lite = false): MeshGroup3D[] | null {
        const key = lite ? `${tx},${tz}|l` : `${tx},${tz}`;   // matches the stream key the dispose path stored under
        const hit = this._tileRetired.take(key);
        if (!hit) return null;
        this._reattachTile(hit);
        return hit;
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
        if (this._distTiers.length || this._distLodKey) { assignDrawDistances([root], this._distTiers, WorldManager.fogClassify()); this._stampLodExtras([root]); this._noteStamped([root]); }   // R6.1 distance LOD for the (re-)attached tile
    }

    /** CityStreamSource hook: the async tile build drained — recache the gizmo bounds (now that all tiles exist)
     *  and frame the whole world if this was a fresh build. */
    private _onTilesSettled(): void {
        if (WorldManager.P10.idleTileBounds && typeof setTimeout !== 'undefined') this._scheduleTileBounds();
        else this._cacheCityBounds();
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
        // chunk=false: a streamed TILE is already its own spatial cell (one tile's groups cull as a unit) — splitting
        // it again measured +73% meshes / 2x renderer CPU on a 3x3 'full' world for no GPU win (Round 5).
        this._addStaged(name, layers, this._heightFn, this._smoothFn, this._warpInto, this._groups, /*silent*/ true, /*preDraped*/ true, /*chunk*/ false);
        if (this._groups.length > before) {
            const g = this._groups[this._groups.length - 1];
            out.push(g);
            this._tileGroups.add(g);   // tile-owned (vs centre) — drives the centre-hide + retire cache
            // P17: an HLOD tile arrives invisible (coverage 0); its fade-in starts when the whole tile has landed
            if (name.endsWith(' HLOD') && this._hlod.fade && this._hlod.fadeMs > 0 && typeof requestAnimationFrame !== 'undefined') this._setHlodFade([g], 0);
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
        this._backdropAt = [0, 0]; this._backdropTok++;   // step 3: rebuilt at the origin; the next window sync re-follows
        if (this.scene3d.shadowsEnabled) this.scene3d.setShadowHalfExtent3D(Math.max(15, half * 1.6));
        this._stampWorldParams();
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
        this._add('World Road Signs', buildRoadSigns(graph, this._regionFilter()).layers);   // regulatory poles + warning-diamond GARP
        this._add('World Signage', buildSignage(graph, this._regionFilter()));
        this._add('World Awnings', buildAwnings(graph, this._regionFilter()));
        this._add('World Furniture', buildFurniture(graph, this._regionFilter()));
        this._add('World Railway', [...buildRailway(graph, !this._trafficOn), ...buildLocalLine(graph, !this._trafficOn)]);   // parked trains only when traffic is off (+ the R3.2 local line)
        this._add('World Skyway', buildSkyway(graph));                       // cyber: the sky-train's glowing guideway
        this._add('World Sky', buildSky(graph));                             // stars + moon (shown at night by the cycle)
        for (const ch of this._groups[this._groups.length - 1].children) (ch as Mesh3D).visible = false;   // hidden until the cycle reveals them
        this._add('World Pedestrians', buildPedestrians(graph, this._regionFilter()));
        this._addTextSigns(graph);
        // Traffic follows the param + City mode: auto-runs while the tool is open (the panel toggle turns it off).
        if (graph.params.traffic === false) this.stopTraffic();
        else if (this._trafficOn || this._cityMode) this.startTraffic();   // respawn after regen / start on toggle-on
        this._redressGlow();
        if (this._hasStyle()) this._applyRenderStyle();
        return graph;
    }

    /** The canonical build order after the layout groups — generateWorld, DRAFT builds and the ASYNC
     *  time-sliced regen all walk this list through {@link _buildGroup}. Sourced from the shared
     *  DRESSING_ORDER (build-order.ts) so the four build-order lists can never drift (audit B2). */
    private static readonly BUILD_ORDER: readonly string[] = DRESSING_ORDER;
    /** Groups SKIPPED by a DRAFT build (the fast preview during a slider drag) — dressing that reads fine
     *  missing for half a second. Draft also skips text signs and the traffic respawn. */
    private static readonly DRAFT_SKIP = new Set([
        'World Road Signs', 'World Signage', 'World Awnings', 'World Furniture', 'World Pedestrians', 'World Sky', 'World Skyway',
    ]);

    /** Build all phases at once. `draft` = the reduced drag-preview build (see updateCity). */
    generateWorld(params: Partial<LayoutParams> = {}, draft = false): WorldGraph {
        // Perf diagnostic: time generateLayout vs each group build (logged below via debugLog) — tells us whether the
        // load freeze is in the layout graph or the group loop. Timing is cheap; only the log is gated.
        const _wnow = (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
        const _wsteps: [string, number][] = [];
        let _wmark = _wnow();
        const _wlap = (n: string): void => { const x = _wnow(); _wsteps.push([n, x - _wmark]); _wmark = x; };
        const graph = this.generateLayout(params); _wlap('generateLayout');
        // Flat tiled overview: skip ALL the 3D dressing — the centre stays a flat map like its neighbours (a cheap
        // top-down view of the whole world). generateLayout already added every tile's flat map.
        const flatOnly = graph.params.worldMode === 'tiled' && graph.params.tileDetail === 'flat';
        for (const name of WorldManager.BUILD_ORDER) {
            if (flatOnly) break;
            if (draft && WorldManager.DRAFT_SKIP.has(name)) continue;
            this._add(name, this._buildGroup(name, graph)); _wlap(name);
            if (name === 'World Sky') for (const ch of this._groups[this._groups.length - 1].children) (ch as Mesh3D).visible = false;   // hidden until the cycle reveals them
        }
        if (!draft) { this._addTextSigns(graph); _wlap('textSigns'); }
        // Traffic follows the param + City mode: auto-runs while the tool is open (the panel toggle turns it off).
        if (graph.params.traffic === false) this.stopTraffic();
        else if (!draft && (this._trafficOn || this._cityMode)) this.startTraffic();   // respawn after regen / start on toggle-on
        this._redressGlow();
        if (this._hasStyle()) this._applyRenderStyle();
        if (!draft) this._cacheCityBounds();   // gizmo box (skip draft — the full build follows)
        if (!draft) this._flushPendingCityEnter();   // P5.W1: a sync build superseded a pending async City-mode entry
        // Perf diagnostic (gated behind debug-log's enableConsoleDebug): generateWorld's per-phase timing —
        // which build groups dominate the city regen. See docs/specs/god-objects-and-perf.md (async-restore).
        const _wtot = _wsteps.reduce((s, [, m]) => s + m, 0);
        debugLog(`[Salsa][load] generateWorld breakdown${draft ? ' (draft)' : ''} — TOTAL ${Math.round(_wtot)}ms, workers=${this._workersEnabled}/${this._tilePool ? 'spawned' : 'lazy'}:\n` +
            _wsteps.filter(([, m]) => m >= 0.5).sort((a, b) => b[1] - a[1]).map(([n, m]) => `    ${Math.round(m)}ms  ${n}`).join('\n'));
        return graph;
    }

    // ── City Tool MODE ───────────────────────────────────────────────────────────────────────────
    /** Enter City mode (alt+drag orbit + focus workspace). Only ONE city ever exists — re-opening the tool goes back
     *  to editing it. Called with EXPLICIT params → (re)generate the city; called with NO args → RESUME orbit on the
     *  existing city WITHOUT regenerating (falls back to generating a default city if none exists yet). Frogmarks calls
     *  this when the City Tool opens; slider changes then call {@link updateCity}. */
    // ── City lighting scope (docs/TODO.md · memory project_lighting_shadows) ──────────────────────────
    // There is ONE global set of renderer lighting uniforms; the city's day/night dressing writes them directly.
    // To stop the city from PERMANENTLY stomping the host's global scene lighting, snapshot the global lighting on
    // city-enter and restore it on exit (mirrors the post-FX save/restore in setCinematicGrade). `overrideGlobal
    // Lighting` (the host toggle) gates whether the city applies its OWN day/night look at all — off = inherit global.
    private _preCityLighting: ReturnType<Scene3DManager['getGlobalScene3DSettings']> | null = null;
    private _overrideGlobalLighting = true;
    /** Whether the city drives its own day/night lighting (true) or inherits the global scene lighting (false). */
    get overrideGlobalLighting(): boolean { return this._overrideGlobalLighting; }

    /** Snapshot the global lighting so the city can restore it on exit (idempotent — captured once per city session). */
    private _snapshotGlobalLighting(): void {
        if (!this._preCityLighting) this._preCityLighting = this.scene3d.getGlobalScene3DSettings();
    }
    /** Restore the pre-city global lighting (sun/ambient/sky/fog/shadows). Post-FX is handled by setCinematicGrade. */
    private _restoreGlobalLighting(): void {
        if (!this._preCityLighting) return;
        const s = this._preCityLighting;
        // Hard fog edge: the fog is the user's (set while in the city) — keep it rather than the pre-city snapshot.
        const fog = this._fogLocked() ? { ...this.scene3d.getFog3D() } : s.fog;
        this.scene3d.restoreGlobalScene3DSettings({ lighting: s.lighting, bg: s.bg, fog, shadows: s.shadows, shadowTint: s.shadowTint ?? null, heightFog: s.heightFog ?? [0, 0, 1, 0.05], aerialHaze: s.aerialHaze ?? [0, 20, 0.6, 0.5],
            // city-quality P4/P5: the city's sky lighting + wet reflections + look outlines/SSAO are city-scoped too
            ibl: s.ibl, sky: s.sky, iblSpecular: s.iblSpecular, reflections: s.reflections, ssao: s.ssao, edgeOutlines: s.edgeOutlines ?? null });
        this._lastSkyBucket = ''; this._ssrByCity = false;
        this._preCityLighting = null;
    }
    /** The DOCUMENT's own base look while a city session holds the global uniforms (bug-hunt 2026-10-01 D-P1): a save
     *  made in City mode must persist the pre-city lighting / post stack / cascades, not the city's day/night dressing
     *  (the city look itself is saved in the city's worldParams marker). Returns `gs` with the city-scoped keys swapped
     *  for the snapshots taken on city-enter — exactly the keys {@link _restoreGlobalLighting} / setCinematicGrade(false)
     *  / the cascade restore hand back on exit. Outside a city session `gs` comes back unchanged. */
    overlayPreCityState<T extends ReturnType<Scene3DManager['getGlobalScene3DSettings']>>(gs: T): T {
        const out: T = { ...gs };
        const s = this._preCityLighting;
        if (s) {
            out.lighting = s.lighting; out.bg = s.bg;
            if (!this._fogLocked()) out.fog = s.fog;   // hard fog edge: the live fog is the user's own → save it as is
            out.shadows = { ...s.shadows };
            out.shadowTint = s.shadowTint ?? null;
            out.heightFog = s.heightFog ?? [0, 0, 1, 0.05];
            out.aerialHaze = s.aerialHaze ?? [0, 20, 0.6, 0.5];
            out.ibl = s.ibl; out.sky = s.sky; out.iblSpecular = s.iblSpecular; out.reflections = s.reflections;
            out.ssao = s.ssao; out.edgeOutlines = s.edgeOutlines ?? null;
        }
        if (this._cityMode && this._preCityCascades) out.shadows = { ...out.shadows, cascades: this._preCityCascades };
        if (this._cityMode && this._gradeOn && this._prePostFX) {
            const pre = this._prePostFX;
            out.postProcess = JSON.parse(JSON.stringify({ ...pre, bloom: { wide: 0, chromaGate: 0, ...pre.bloom } })) as PostProcessConfig;
        }
        return out;
    }

    enterCityMode(params?: Partial<LayoutParams>): WorldGraph {
        if (this._overrideGlobalLighting) this._snapshotGlobalLighting();   // ★ before any city lighting write
        this._cityMode = true;                     // set BEFORE the build so the wrapper is created at IDENTITY (edit upright)
        if (params === undefined && this.hasWorld && this._graph) {   // resume: the city + its meshes already exist — just re-enter orbit
            this._enterCityModeTail(this._graph);
            return this._graph;
        }
        // performance-plan P5.W1: the (re)generation is NON-BLOCKING when a frame loop exists — the whole city builds
        // in the 'world' worker (or time-sliced on the main thread), reassembles hidden, and reveals in one swap; the
        // City-mode setup below (workspace + framing, shadows, lighting, traffic, edit pulse) is DEFERRED to that
        // swap (_finishAsync → _flushPendingCityEnter) so nothing half-applies over an empty scene. Callers get a
        // cheap LAYOUT-ONLY graph (~2-4 ms: regions / lots / roads — the worker's build reproduces it exactly).
        // Headless (no rAF) keeps the classic synchronous build (tests).
        const inflight = this._inflightFullParams();
        if (inflight && (params === undefined || WorldManager._sameParams(params, inflight))) {   // join the running build (doc load / re-open)
            this._pendingCityEnter = true;
            this._applyCityTransform();
            return (this._previewGraph ??= this._layoutPreview(inflight));
        }
        if (this._canAsyncFull()) {
            const p = { ...(params ?? {}) };
            this._targetParams = p;              // merge base for an updateCity issued while this build is in flight
            this._applyCityTransform();          // an existing (regenerating) city goes upright now
            this._startAsyncFull(p, this.hasWorld ? 'edit' : 'load');   // 'load' = nothing visible until the reveal ("Building city…")
            this._pendingCityEnter = true;       // AFTER _startAsyncFull (a headless forced run finishes inside it)
            this._previewGraph = this._layoutPreview(p);
            if (!this._inflightFullParams()) this._flushPendingCityEnter();   // forced-sync test path: the build already landed
            return this._graph && !this._inflightFullParams() ? this._graph : this._previewGraph;
        }
        const graph = this.generateWorld(params ?? {});    // (re)generate from params, or a default city if none exists
        this._enterCityModeTail(graph);
        return graph;
    }

    /** Same build request? Key-order-insensitive deep compare, ignoring `adverts` (re-attached from the library at
     *  dispatch, so the in-flight copy carries it and the caller's doesn't). */
    private static _sameParams(a: Partial<LayoutParams>, b: Partial<LayoutParams>): boolean {
        const canon = (p: Partial<LayoutParams>): string => {
            const o = p as Record<string, unknown>;
            return JSON.stringify(Object.keys(o).filter(k => k !== 'adverts' && o[k] !== undefined).sort().map(k => [k, o[k]]));
        };
        return canon(a) === canon(b);
    }
    /** True when a full city (re)build may run asynchronously (worker / time-sliced) instead of synchronously. */
    private _canAsyncFull(): boolean { return this._forceAsyncFull || typeof requestAnimationFrame !== 'undefined'; }
    /** Test hook: route full builds through the async machinery headless (it then completes synchronously). */
    _forceAsyncFull = false;
    /** The params of the in-flight async FULL build (worker or main-thread staging), or null when none is running. */
    private _inflightFullParams(): Partial<LayoutParams> | null { return this._asyncW?.merged ?? this._async?.merged ?? null; }
    /** City-mode entry waiting for an async build to land (see enterCityMode). */
    private _pendingCityEnter = false;
    /** Layout-only graph handed out while the first build is in flight (regions for the host's district list). */
    private _previewGraph: WorldGraph | null = null;
    /** The cheap layout graph for `p` — the same overrides generateLayout applies (tiled centre = grid/square). */
    private _layoutPreview(p: Partial<LayoutParams>): WorldGraph {
        const q = this._withAdverts(p);
        return generateCityLayout(q.worldMode === 'tiled' ? { ...q, pattern: 'grid', border: 'square', terraces: false, shotengai: false } : q);
    }
    /** Run a deferred City-mode entry now that the city exists (no-op unless one is pending and the mode is still on). */
    private _flushPendingCityEnter(): void {
        if (!this._pendingCityEnter) return;
        this._pendingCityEnter = false;
        this._previewGraph = null;
        if (this._cityMode && this._graph) this._enterCityModeTail(this._graph, /*deferTraffic*/ true);
    }
    /** Spawn the movers AFTER the reveal frame (P5.W1), time-sliced (P5.W4): the mover specs + the routing net come
     *  precomputed from the worker centre build (WorldTraffic.preload in the swap), so the main thread only creates the
     *  mover meshes — hidden, a few per frame under the reassembly budget — and reveals them in one step
     *  (WorldTraffic.startSliced). Without a precompute it computes them in its first slice (the old cost). A second
     *  call while one is in flight joins it. Headless: immediately (start()). */
    private _spawnTrafficSoon(graph: WorldGraph): void {
        if (this._graph !== graph || !this._trafficOn) return;
        const done = (): void => {
            if (this._timeOfDay == null) this._redressGlow();         // (start() only re-dresses with a time of day)
            this.scene3d.requestRender3D();
        };
        if (!this.trafficOffThread && typeof requestAnimationFrame !== 'undefined') {
            // A/B: the pre-P5.W4 spawn — the road net on the next frame, then computeTraffic + every mesh in one go.
            requestAnimationFrame(() => {
                if (this._graph !== graph || !this._trafficOn) return;
                roadNet(graph);
                requestAnimationFrame(() => { if (this._graph === graph && this._trafficOn && !this._traffic.movers.length) { this._traffic.start(); done(); } });
            });
            return;
        }
        this._traffic.startSliced(() => this._sliceBudgetMs(), done);
    }
    /** P5.W4 A/B switch (console: salsaWorld.manager.trafficOffThread = false): false = no traffic precompute in the
     *  centre build and the old one-shot spawn two frames after the reveal. */
    trafficOffThread = true;
    /** Per-frame budget of a main-thread time-sliced job — the reassembly queue's (3 ms while the stream pump or the
     *  reassembly itself is busy, so the two stay ≤ ~8 ms/frame together; else 6 ms). */
    _sliceBudgetMs(): number { return this._stream.queued || this._reassembleQueue.length || this._slice ? 3 : 6; }
    /** Should a full build also precompute the traffic (P5.W4)? Only when the swap will spawn movers. */
    private _wantTrafficPrecompute(merged: Partial<LayoutParams>): boolean {
        return this.trafficOffThread && wantsTraffic(merged) && (this._trafficOn || this._cityMode);
    }

    /** The City-mode setup that follows a (re)build or a resume: workspace + framing, shadows, lighting, traffic. */
    private _enterCityModeTail(graph: WorldGraph, deferTraffic = false): void {
        this._pendingCityEnter = false;
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
        this.scene3d.setShadowSoftness(this._shadowSoft);   // city-quality L3: 1.3 = graphic edges; the clean look (T1.2) softens it
        this._preCityCascades ??= this.scene3d.shadowCascades3D;   // persona-polish A2: the host's own cascades, handed back on exit
        this._applyShadowCascades();
        // The city's OWN day/night look (sun/ambient/sky/grade) — only when overriding global lighting. On resume,
        // this re-applies the city lighting the previous exit handed back to the host. Default to a NOON sky.
        if (this._overrideGlobalLighting) {
            this.setCinematicGrade(true);   // bloom/grade/vignette keyed to the day cycle (host config restored on exit)
            this.setTimeOfDay(this._timeOfDay ?? 0.5);
            // The city's own SSAO + ink outlines (city exit handed the host its settings back, switching them off).
            if (this._ssaoOn) this.setSSAO(true, true);
            if (this._outlinesCfg) { this._enableCityOutlines(this._outlinesCfg); this._lookOutlines = true; }
        }
        // The city is ALIVE by default: moving cars/train/walkers unless the traffic param is off. Tiled worlds
        // skip auto-traffic (a moving sim across many tiles stutters); the user can turn it on knowingly.
        if (!tiled && graph.params.traffic !== false) {
            if (deferTraffic) { this._trafficOn = true; this._spawnTrafficSoon(graph); } else this.startTraffic();
        }
        this.setEditPulse(true);   // live "cyberspace stage" breath on the border glow while the tool is open
    }

    /** Leave City mode (keeps the city in the scene; call {@link clear} to remove it). */
    exitCityMode(): void {
        if (this._pendingCityEnter) {
            // P5.W1: left before the first build landed — the workspace / lighting / traffic setup never ran, so there is
            // nothing to hand back except the lighting snapshot. The build keeps going and lands as a placed city.
            this._pendingCityEnter = false;
            this._previewGraph = null;
            this._restoreGlobalLighting();   // undo any city lighting a host setter wrote meanwhile (else a no-op restore)
            this._cityMode = false;
            this._applyCityTransform();
            return;
        }
        // Not in City mode → nothing to hand back. Without this a stray call (host double-exit) wiped the HOST's point
        // lights, shadow interval/softness and post stack (bug-hunt 2026-10-01).
        if (!this._cityMode) return;
        this.clearLandmarkHover();   // drop any hover outline + card
        this.scene3d.exitCityMode3D();
        this.scene3d.setShadowUpdateInterval(1);   // back to every-frame shadows for normal editing
        this.scene3d.setShadowSoftness(1);
        this.scene3d.setPointLights3D([]);         // lamp lights off outside the city
        this.scene3d.setCandidatePointLights3D([]);   // ★ the night lamp POOL uses the candidate channel — clear it too,
        this._lastLampBucket = -1; this._lampGraph = null;   // else warm lamp pools leak onto the host illustration
        this.scene3d.setPlayerLight3D(null);       // visual-polish #7c: the city's Play player light is city-scoped too
        this.setCinematicGrade(false);            // hand the post stack back to the host's own settings
        this._restoreGlobalLighting();             // ★ hand the sun/ambient/sky/fog/shadows back to the host too
        if (this._preCityCascades) { this.scene3d.setShadowCascades3D(this._preCityCascades); this._preCityCascades = null; }   // A2
        if (this._preCityFarMapSize !== null) { this.scene3d.setShadowMapSize3D(this._preCityFarMapSize); this._preCityFarMapSize = null; }   // P14
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
    /** Build groups whose supports carry text-sign PLATES (rasterized in the separate 'World Sign Text' group). A
     *  selective regen that rebuilds any of these must also rebuild the plates, or they float over a removed support. */
    private static readonly SIGN_SUPPORT_GROUPS = new Set(['World Signals', 'World Road Signs', 'World Streets', 'World Landmarks', 'World Shotengai']);
    private static readonly PARAM_TIER: Partial<Record<keyof LayoutParams, readonly string[]>> = {
        sidewalks: ['World Layout'],
        roadPaint: ['World Road Paint'],
        trafficLights: ['World Signals', 'traffic'],   // (city-quality E3) routed cars read the signals → respawn them too
        signage: ['World Signage'],
        awnings: ['World Awnings'],
        streetFurniture: ['World Furniture'], powerLines: ['World Furniture'], parkedCars: ['World Furniture'],
        bicycles: ['World Furniture'], frontageDressing: ['World Furniture'], lanterns: ['World Furniture', 'World Shotengai'],
        cornerStyle: ['World Streets'], roofStyle: ['World Streets'], facadeDetail: ['World Streets'], rooftops: ['World Streets'],
        districtPalette: ['World Streets'], roofVariety: ['World Streets'],   // visual-polish #11 (facade + roof colours)
        roofEquipment: ['World Streets'],   // visual-polish #11 tail (clustered roof plant)
        trafficDensity: ['traffic'],   // visual-polish #16 (respawn the movers)
        streetTrees: ['World Biome'],
        pedestrians: ['World Pedestrians'],
        // railway / stations / metroEntrances are FULL-regen params (not listed): the shared street plan reserves the viaduct
        // piers, station stairs and metro kiosks, and it is memoised per graph — only a fresh graph re-plans it.
        traffic: ['traffic'], clouds: ['traffic'], cloudDensity: ['traffic'], paintedClouds: ['traffic'], domeClouds: ['traffic'],
        weather: ['traffic', 'lighting', 'World Pedestrians'],   // (city-quality E15) the static crowd bakes its rain umbrellas
        fog: ['lighting'],
        voidGrid: ['World Void Grid'], voidExtent: ['World Void Grid'], voidGridSpacing: ['World Void Grid'], voidLineWidth: ['World Void Grid'],
        borderGlow: ['World Border Glow'], borderGlowHeight: ['World Border Glow'],
        terrainApron: ['World Apron'], apronRadius: ['World Apron'], natureDensity: ['World Apron'],
        edgeWear: ['World Layout', 'World Terraces'],   // E2: kerbs (World Layout) + stairs / copings (World Terraces)
        pedestrianStyle: ['crowdStyle'],   // the crowd's shading — a live material pass (no rebuild)
    };

    /** Re-run ONE group's builder on the existing graph (selective regen). */
    private _buildGroup(name: string, graph: WorldGraph): LayoutPreviewLayer[] {
        // ONE switch for every build path (main-thread sync, centre worker, selective worker) — centre-build.ts.
        return buildGroupFor(name, graph, this._regionFilter(), !this._trafficOn);
    }

    private _removeGroupsByName(names: readonly string[], silent = false): void {
        for (const g of [...this._groups]) {
            if (!names.includes(g.name ?? '')) continue;
            this.scene3d.removeFlatColorMeshGroup(g, silent);
            const i = this._groups.indexOf(g);
            if (i >= 0) this._groups.splice(i, 1);
        }
    }

    // ── SELECTIVE regens in the WORKER (performance-plan P3.2) ──────────────────────────────────────────────
    // A non-topology toggle (weather → the crowd's umbrellas, pedestrians, furniture, signage, roof style, …) used to
    // rebuild + drape its groups SYNCHRONOUSLY (pedestrians ≈ 0.45 s build + ~12 M vertex floats of drape → 1.1 s
    // frozen in the field). Now: the shared 'world' lane rebuilds them on a CLONE of the graph (the selective builders
    // only read it — world-jobs.test.ts), pre-draped + chunked; the old groups stay live while the result reassembles
    // HIDDEN through the time-sliced queue, then one swap reveals it and re-runs the dressing. Headless (no rAF) and
    // tiled worlds keep the synchronous path. A newer regen of the same groups supersedes (cancels) the older one.
    /** Test hook: force the async path headless (the service then runs the job on its main-thread fallback). */
    _forceAsyncSelective = false;
    private readonly _selective = new Map<string, SelectiveState>();
    private _canAsyncSelective(graph: WorldGraph): boolean {
        if (graph.params.worldMode === 'tiled') return false;   // tiled centre env differs (see updateCity) — keep sync
        if (this._forceAsyncSelective) return true;
        return this._workersEnabled && typeof requestAnimationFrame !== 'undefined';
    }
    private _startSelectiveWorker(names: string[], graph: WorldGraph): void {
        // bug-hunt 2026-10-01 D-W1: ABSORB every in-flight selective whose group set intersects this one (to a fixpoint)
        // and cancel it — keyed by the exact name set alone, `lanterns` (Furniture + Shotengai) then `streetFurniture`
        // (Furniture) both ran and the older, larger one could land LAST with Furniture built from stale params. The
        // merged request rebuilds the union with the current params, so the older request's other groups still land.
        const all = new Set(names);
        for (let grew = true; grew;) {
            grew = false;
            for (const st of this._selective.values()) {
                if (st.names.some(n => all.has(n)) && st.names.some(n => !all.has(n))) { for (const n of st.names) all.add(n); grew = true; }
            }
        }
        names = [...all];
        const key = [...names].sort().join('|');
        for (const [k, st] of [...this._selective]) {
            if (k === key || !st.names.some(n => all.has(n))) continue;
            this._dropSelective(k);
            this._tilePool?.cancelSelective(k);   // a different key → the service's same-key supersede won't cancel it
        }
        this._dropSelective(key);   // supersede: the service cancels the old job by key; drop its staged reassembly here
        const st: SelectiveState = { names, graph, ctx: null, patch: [] };
        this._selective.set(key, st);
        // Snapshot params NOW (the graph's arrays aren't touched by selective edits; params are mutated in place by the
        // next slider) — the payload is cloned at dispatch, which may be later if the lane is busy.
        const req = { graph: { ...graph, params: { ...graph.params } }, names,
            parkedTrain: !this._trafficOn, activeRegions: this._activeRegions ? [...this._activeRegions] : null,
            chunk: this._chunkOpts(graph.params.radius), contact: { opacity: this._groundContactStrength }, runBoxes: WorldManager.STEP3.runBoxes };
        this._ensureTilePool().buildGroups(req, key)
            .then(({ groups, patch }) => {
                if (this._selective.get(key) !== st || this._graph !== graph) return;   // superseded / regenerated meanwhile
                st.patch = patch;   // applied at the SWAP (the old buildings stay consistent with the old graph until then)
                st.ctx = this._enqueueReassembly(groups, staged => this._finishSelective(key, st, staged), /*staged*/ true);
                if (!st.ctx && this._selective.get(key) === st) { /* nothing to build → resolve already swapped (empty) */ }
            })
            .catch((err: unknown) => {
                if (this._selective.get(key) !== st) return;   // cancelled / superseded
                this._selective.delete(key);
                if ((err as Error)?.name === 'JobCancelledError' || this._graph !== graph) return;
                this._removeGroupsByName(names);   // worker failed → the classic synchronous rebuild (still correct)
                for (const name of names) this._add(name, this._buildGroup(name, graph));
                this._afterSelectiveGroups(names, graph);
            });
    }
    /** The one-frame SWAP of a selective regen: drop the old groups, reveal the staged ones, re-dress. */
    private _finishSelective(key: string, st: SelectiveState, staged: MeshGroup3D[]): void {
        if (this._selective.get(key) !== st || this._graph !== st.graph) { if (this._selective.get(key) === st) this._selective.delete(key); for (const g of staged) this.scene3d.removeFlatColorMeshGroup(g, true); return; }
        this._selective.delete(key);
        applyGraphPatch(st.graph, st.patch);   // e.g. World Streets re-derives lot.builtH / doors / buildingMeta (in place)
        this._removeGroupsByName(st.names);
        for (const g of staged) { for (const ch of g.children) (ch as Mesh3D).visible = true; this._groups.push(g); }
        this._sceneEpoch++;
        this._afterSelectiveGroups(st.names, st.graph);
        this.scene3d.notifySceneGraphChanged3D();   // staged adds were silent — one host notification for the swap
    }
    /** The dressing a selective group rebuild needs (shared by the sync path's tail, the worker swap and its fallback). */
    private _afterSelectiveGroups(names: readonly string[], graph: WorldGraph): void {
        // Text-sign PLATES sit on supports in these groups but live in 'World Sign Text' — rebuild them AFTER supports.
        if (names.some(n => WorldManager.SIGN_SUPPORT_GROUPS.has(n))) {
            this._removeGroupsByName(['World Sign Text']);
            this._addTextSigns(graph);
        }
        this._lastGlowNight = -1;              // fresh meshes need re-dressing
        if (this._hasStyle()) this._applyRenderStyle();
        if (this._timeOfDay != null) this._applyTimeOfDay();
        this.scene3d.requestRender3D();
    }
    /** Cancel one (key) or every in-flight selective regen: drop its queued reassembly + hidden staged groups. */
    private _dropSelective(key?: string): void {
        for (const [k, st] of [...this._selective]) {
            if (key !== undefined && k !== key) continue;
            this._selective.delete(k);
            if (st.ctx) {
                for (let i = this._reassembleQueue.length - 1; i >= 0; i--) if (this._reassembleQueue[i].ctx === st.ctx) this._reassembleQueue.splice(i, 1);
                this._dropSlice(st.ctx);
                for (const g of st.ctx.out) this.scene3d.removeFlatColorMeshGroup(g, /*silent*/ true);
            }
        }
        if (key === undefined) this._tilePool?.cancelSelective();
    }
    /** True while a selective regen is building in the worker / reassembling (host "updating…" cue). */
    isUpdatingCity(): boolean { return this._selective.size > 0; }

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
        const pendingFull = !!this._async || !!this._asyncW || !!this._promoteTimer;
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
                const groupNames = [...units].filter(u => u !== 'traffic' && u !== 'lighting' && u !== 'crowdStyle');
                if (units.has('crowdStyle')) { this._applyPedStyle(); this._stampWorldParams(); }
                if (groupNames.length && this._canAsyncSelective(graph)) {
                    // P3.2: rebuild + drape + chunk the groups in the 'world' WORKER; the old groups stay live until the
                    // time-sliced reassembly swaps the new ones in (_finishSelective re-runs the dressing below).
                    this._startSelectiveWorker(groupNames, graph);
                } else if (groupNames.length) {
                    this._removeGroupsByName(groupNames);
                    for (const name of groupNames) this._add(name, this._buildGroup(name, graph));
                    // Text-sign PLATES (STOP / NO PARKING / name plates) sit on supports in these groups but live in
                    // their own 'World Sign Text' group. If a support group rebuilt (e.g. trafficLights off removes the
                    // signal housings), rebuild the plates too or they float over nothing. Rebuild them AFTER supports.
                    if (groupNames.some(n => WorldManager.SIGN_SUPPORT_GROUPS.has(n))) {
                        this._removeGroupsByName(['World Sign Text']);
                        this._addTextSigns(graph);
                    }
                    this._lastGlowNight = -1;              // fresh meshes need re-dressing
                    if (this._hasStyle()) this._applyRenderStyle();
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
        const inflight = this._inflightFullParams();
        if (inflight && WorldManager._sameParams(merged, inflight)) {
            // P5.W1: the running async build already IS this request (Frogmarks openWorldPanel: enterCityMode(p), then
            // updateCity(p) moments later) — keep it instead of restarting a multi-second build from scratch.
            this._targetParams = merged;
            this._lastRegen = { ms: 0, kind: 'full-async (joined in-flight build)' };
            return graph ?? (this._previewGraph ??= this._layoutPreview(merged));
        }
        this._targetParams = merged;
        const firstBuild = !graph && (!!inflight || this._pendingCityEnter);   // superseding the FIRST build (no city yet)
        this._abortAsync();
        if (this._promoteTimer) { clearTimeout(this._promoteTimer); this._promoteTimer = null; }
        const rapid = t0 - this._lastUpdateAt < 350;
        this._lastUpdateAt = t0;

        // TILED worlds: the centre builds async (P5.W2) — the double buffer is only the old world + the new CENTRE (the
        // neighbour tiles re-stream after the swap), never two tile grids. Headless keeps the sync build below.
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
            if ((graph || firstBuild) && this._canAsyncFull()) {
                // P5.W2: the tiled CENTRE builds in the worker too (tiled-aware centre build + time-sliced reassembly);
                // the swap tears down the old tile grid and re-streams the neighbours (_finishAsync).
                this._startAsyncFull(merged, firstBuild ? 'load' : 'edit');
                if (firstBuild) this._previewGraph = this._layoutPreview(merged);
                this._lastRegen = { ms: t0 ? performance.now() - t0 : 0, kind: 'full-tiled-async (building…)' };
                return graph ?? this._previewGraph ?? this._layoutPreview(merged);
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

        if ((graph || firstBuild) && this._canAsyncFull()) {
            // ASYNC: time-sliced staged rebuild; the OLD city stays visible + ticking until the swap. P5.W1: a change
            // while the FIRST build is in flight supersedes it the same way (merged onto its params, still 'load').
            this._startAsyncFull(merged, firstBuild ? 'load' : 'edit');
            if (firstBuild) this._previewGraph = this._layoutPreview(merged);
            this._lastRegen = { ms: t0 ? performance.now() - t0 : 0, kind: 'full-async (building…)' };
            return graph ?? this._previewGraph ?? this._layoutPreview(merged);
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
    /** Retune every live water surface in place (material-only — no regen, no geometry touched). */
    private _tuneWater(p?: Partial<{ deep: [number, number, number]; shallow: [number, number, number];
            waveScale: number; waveSpeed: number; choppy: number; glitter: number }>): unknown {
        const hits: Array<Record<string, unknown>> = [];
        const walk = (node: unknown): void => {
            const n = node as { name?: string; children?: unknown[]; material?: Record<string, unknown>;
                materialDirty?: boolean };
            if (n.material?.waterShade) {
                const m = n.material;
                if (p?.deep) m.waterDeep = p.deep;
                if (p?.shallow) m.waterShallow = p.shallow;
                if (p?.waveScale !== undefined) m.waterWaveScale = p.waveScale;
                if (p?.waveSpeed !== undefined) m.waterWaveSpeed = p.waveSpeed;
                if (p?.choppy !== undefined) m.waterChoppy = p.choppy;
                if (p?.glitter !== undefined) m.waterGlitter = p.glitter;
                n.materialDirty = true;   // material-only change — never gpuDirty (that means GEOMETRY)
                hits.push({ layer: n.name, waveScale: m.waterWaveScale, waveSpeed: m.waterWaveSpeed,
                    choppy: m.waterChoppy, glitter: m.waterGlitter });
            }
            for (const c of n.children ?? []) walk(c);
        };
        walk(this._ensureCityContainer());
        this.scene3d.requestRender3D();
        console.table(hits);
        return hits;
    }

    /**
     * Report the world-Y extent of every mesh under the city container, lowest first.
     *
     * Diagnostic for "there is something under the world". Geometry bounds are precomputed by the drape
     * pass (`geometry.bounds`), so this is a cheap walk — no per-vertex scan. Instanced layers report the
     * extent across ALL their instances, which is the whole point: a single bad transform in a pool of
     * hundreds is invisible in the mesh's own position.
     */
    private _yscan(limit: number): Array<{ name: string; minY: number; maxY: number; n: number }> {
        const rows: Array<{ name: string; minY: number; maxY: number; n: number }> = [];
        const walk = (node: unknown, accY: number): void => {
            const n = node as { name?: string; y?: number; children?: unknown[];
                geometry?: { bounds?: Float32Array }; scaleY?: number;
                arrayParams?: { mode?: string; offsets?: [number, number, number][] } };
            const y = accY + (typeof n.y === 'number' ? n.y : 0);
            const b = n.geometry?.bounds;
            if (b) {
                const sy = typeof n.scaleY === 'number' ? n.scaleY : 1;
                let lo = y + b[1] * sy, hi = y + b[4] * sy, count = 1;
                // An ArrayGroup's offsets are source-relative; widen the extent over every instance.
                const off = n.arrayParams?.offsets;
                if (off?.length) {
                    count += off.length;
                    for (const o of off) { lo = Math.min(lo, y + o[1] + b[1] * sy); hi = Math.max(hi, y + o[1] + b[4] * sy); }
                }
                rows.push({ name: n.name ?? '(unnamed)', minY: lo, maxY: hi, n: count });
            }
            for (const c of n.children ?? []) walk(c, y);
        };
        walk(this._ensureCityContainer(), 0);
        rows.sort((a, b) => a.minY - b.minY);
        const out = rows.slice(0, Math.max(1, limit));
        console.table(out.map(r => ({ layer: r.name, minY: +r.minY.toFixed(3), maxY: +r.maxY.toFixed(3), instances: r.n })));
        return out;
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
        /** P5.W4: the traffic precompute (worker result / the staging queue's traffic steps) for the swap to preload. */
        traffic?: TrafficPrecompute;
    } | null = null;
    /** In-flight WORKER full regen (audit §1.2): generation + drape run in the tile Worker; `ctx` is the staged
     *  time-sliced reassembly once the worker returns (null while the worker is still generating). */
    private _asyncW: { merged: Partial<LayoutParams>; t0: number; ctx: ReassembleCtx | null } | null = null;
    /** One-shot: a document-load async build sets this so {@link _finishAsync} STORES but does NOT APPLY the saved
     *  city lighting — a reopened doc must not stomp the host's global lighting (matches the sync restore path,
     *  where `_timeOfDay` is set AFTER `generateWorld`). Cleared on finish/abort so live edits still apply lighting. */
    private _suppressNextFinishLighting = false;

    /** Fires when the async city build starts (`building:true`) and settles (`building:false`). The city now builds
     *  off-thread and reveals progressively, so a host (Frogmarks) can bind a small non-blocking "Building city…"
     *  indicator to this. `reason` = 'load' (document open, no city visible until reveal) | 'edit' (live regen, the
     *  old city stays visible until the swap). Only real transitions fire — a superseded build stays 'building'. */
    public readonly onCityBuildStateChange = new EventEmitter<{ building: boolean; reason: 'load' | 'edit' }>();
    private _cityBuildActive = false;
    private _cityBuildReason: 'load' | 'edit' = 'edit';
    private _setCityBuildState(building: boolean, reason: 'load' | 'edit'): void {
        if (building === this._cityBuildActive) return;   // ignore no-op transitions (a supersede keeps it 'building')
        this._cityBuildActive = building;
        if (building) this._cityBuildReason = reason;
        this.onCityBuildStateChange.emit({ building, reason: this._cityBuildReason });
    }
    /** True while an async city build is in flight (poll alternative to {@link onCityBuildStateChange}). */
    isBuildingCity(): boolean { return this._cityBuildActive; }

    private _abortAsync(): void {
        this._dropSelective();   // P3.2: a full regen / clear supersedes every in-flight selective (worker) regen
        this._suppressNextFinishLighting = false;   // an aborted load-build must not suppress the next (edit) build's lighting
        this._setCityBuildState(false, this._cityBuildReason);   // aborted/torn-down build → clear the cue (a re-start re-sets it in the same tick)
        if (this._asyncW) {   // worker regen: drop its queued reassembly jobs + any staged (hidden) groups
            const st = this._asyncW;
            this._asyncW = null;   // the .then/.catch handlers check identity → in-flight worker results are discarded
            if (!st.ctx) this._tilePool?.cancelCentre();   // bug-hunt 2026-10-01 D-W3: still building → free the worker too
            if (st.ctx) {
                for (let i = this._reassembleQueue.length - 1; i >= 0; i--) {
                    if (this._reassembleQueue[i].ctx === st.ctx) this._reassembleQueue.splice(i, 1);
                    this._dropSlice(st.ctx);
                }
                for (const g of st.ctx.out) this.scene3d.removeFlatColorMeshGroup(g, /*silent*/ true);
            }
        }
        if (!this._async) return;
        if (this._async.raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._async.raf);
        for (const g of this._async.staged) this.scene3d.removeFlatColorMeshGroup(g);
        this._async = null;
    }

    /** Full async regen — dispatch: generate + drape in a tile WORKER when available (the main thread only
     *  reassembles, time-sliced, then adopts the returned graph); otherwise the classic main-thread staging. */
    private _startAsyncFull(merged: Partial<LayoutParams>, reason: 'load' | 'edit' = 'edit'): void {
        merged = this._withAdverts(merged);
        this._abortAsync();
        this._setCityBuildState(true, reason);   // AFTER _abortAsync (which would reset it); settled in _finishAsync
        const pool = this._workersEnabled && typeof Worker !== 'undefined' ? this._ensureTilePool() : null;
        if (pool && pool.available) { this._startWorkerFull(merged, pool); return; }   // P5.W2: tiled centres too
        this._startAsyncFullMain(merged);
    }

    /** Worker full regen: buildCentreGroups runs OFF-THREAD (layout + every group builder + drape), then the
     *  groups reassemble through the shared time-sliced queue as hidden staged groups, and the swap ADOPTS the
     *  worker's builder-mutated graph (rebuilding heightFn/smoothFn/warpInto from it main-side). Determinism:
     *  same params + same build order + same region filter/parked flag → the same city as the main path. */
    private _startWorkerFull(merged: Partial<LayoutParams>, pool: TileWorkerPool): void {
        const st: NonNullable<WorldManager['_asyncW']> = { merged, t0: typeof performance !== 'undefined' ? performance.now() : 0, ctx: null };
        this._asyncW = st;
        pool.buildCentre(merged, { parkedTrain: !this._trafficOn, activeRegions: this._activeRegions ? [...this._activeRegions] : null,
            chunk: this._chunkOpts(merged.radius ?? this._params?.radius), contact: { opacity: this._groundContactStrength },
            traffic: this._wantTrafficPrecompute(merged), runBoxes: WorldManager.STEP3.runBoxes })   // P5.W4: + the mover specs / routing net, off the main thread   // chunk in the WORKER (Round 5) — reassembly only wraps
            .then(res => {
                if (this._asyncW !== st) return;   // superseded / cleared while the worker ran — nothing staged yet
                const ctx = this._enqueueReassembly(res.groups, staged => {
                    if (this._asyncW !== st) return;   // aborted mid-reassembly (abort already removed the staged groups)
                    this._asyncW = null;
                    const graph = res.graph;   // ADOPT the worker's mutated graph (lot.builtH / doors / variety / landmarks)
                    // tiled: the drape env comes from the centre's UN-widened frame (matches generateLayout's order)
                    const hGraph = res.centreFrame ? { ...graph, border: res.centreFrame.border, bounds: res.centreFrame.bounds } : graph;
                    this._finishAsync({
                        merged: st.merged, graph, t0: st.t0,
                        h: makeElevation(hGraph), s: makeHeightField(graph.params), w: makeDomainWarpInto(graph.params),
                        queue: [], staged, raf: 0, traffic: res.traffic,
                    });
                    this._lastRegen.kind = 'full-async-worker';
                }, /*staged*/ true);
                if (this._asyncW === st && ctx) st.ctx = ctx;
            })
            .catch(() => {
                if (this._asyncW !== st) return;
                this._asyncW = null;
                this._startAsyncFullMain(st.merged);   // worker crashed → main-thread time-sliced fallback (still correct)
            });
    }

    /** Pseudo-step in the main-thread staging queue: widen a tiled centre to the world extent (P5.W2). */
    private static readonly WIDEN_STEP = '__widen-tiled-extent';
    /** Pseudo-steps (P5.W4): the routing net, then the mover specs, on the finished graph — off the reveal frames. */
    private static readonly NET_STEP = '__traffic-net';
    private static readonly TRAFFIC_STEP = '__traffic-specs';
    private _startAsyncFullMain(merged: Partial<LayoutParams>): void {
        // P5.W2: a tiled centre = the generateLayout overrides + a WIDEN step before the extent groups (the env above
        // is taken pre-widen, like the sync build); 'flat' tile detail stops after the extent groups.
        const tiled = merged.worldMode === 'tiled';
        const graph = this._layoutPreview(merged);
        const queue: string[] = [...FULL_BUILD_ORDER];
        if (tiled) {
            queue.splice(queue.indexOf('World Apron'), 0, WorldManager.WIDEN_STEP);
            if (graph.params.tileDetail === 'flat') queue.length = queue.indexOf('World Border Glow') + 1;
        } else if (this._wantTrafficPrecompute(merged)) queue.push(WorldManager.NET_STEP, WorldManager.TRAFFIC_STEP);   // P5.W4
        this._async = {
            merged, graph, t0: typeof performance !== 'undefined' ? performance.now() : 0,
            h: makeElevation(graph), s: makeHeightField(graph.params), w: makeDomainWarpInto(graph.params),
            queue,
            staged: [], raf: 0,
        };
        if (typeof requestAnimationFrame === 'undefined') { while (this._async) this._asyncStep(); return; }
        this._async.raf = requestAnimationFrame(() => this._asyncStep());
    }

    private _asyncStep(): void {
        const st = this._async;
        if (!st) return;
        let ownFrame = false;
        for (let n = 0; n < 2 && st.queue.length; n++) {     // two groups per frame ≈ 5–15 ms slices
            const name = st.queue.shift()!;
            if (name === WorldManager.WIDEN_STEP) { widenToTiledExtent(st.graph); continue; }
            // P5.W4: the traffic precompute on the finished graph — each step in a staging frame of its own (the net is
            // memoized on the graph), and never in the swap frame.
            if (name === WorldManager.NET_STEP || name === WorldManager.TRAFFIC_STEP) {
                if (n > 0) { st.queue.unshift(name); break; }
                if (name === WorldManager.NET_STEP) roadNet(st.graph); else st.traffic = precomputeTraffic(st.graph, false);
                ownFrame = true; break;
            }
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
        if (st.queue.length || ownFrame) {
            if (typeof requestAnimationFrame === 'undefined') return;   // headless: _startAsyncFullMain's loop drives the next step
            st.raf = requestAnimationFrame(() => this._asyncStep()); return;
        }
        this._finishAsync(st);
    }

    /** The one-frame SWAP: drop the old world, adopt the staged one, respawn the sim on the new graph. */
    private _finishAsync(st: NonNullable<WorldManager['_async']>): void {
        this._async = null;
        this._despawnTraffic();                              // old movers reference the old graph
        // P5.W2: streamed neighbour tiles of the OLD world (a tiled world, or a tiled → diorama switch) go through the
        // stream's own disposal first (it owns their cache / pump state), so _groups below is just the old centre.
        if (this._tileGroups.size || this._stream.liveCount || this._stream.pending) {
            this._flushHlodFades(); this._stream.clear();
            this._tileRetired.clear(); this._tileSig = '';
            this._proxyRetired.clear(); this._hlodRetired.clear();
            this._tileGroups.clear();
            this._centreHidden = false;
        }
        this._dropCentreParking();   // P10.D: a parked old centre is not in the scene; the new centre arrives attached
        // SILENT (P5.W4): a non-silent remove fired the host's scene-graph walk (connectors…) per old group — ~30 ms of
        // the swap frame; the swap notifies ONCE below (notifySceneGraphChanged3D) after the new city is in.
        for (const g of this._groups) this.scene3d.removeFlatColorMeshGroup(g, /*silent*/ true);
        this._groups = st.staged;
        this._sceneEpoch++;   // the reveal swaps a fresh set of visible nodes into _groups → LOD must re-hide
        for (const g of this._groups) {
            const sky = g.name === 'World Sky';              // stars stay hidden until the cycle reveals them
            for (const ch of g.children) (ch as Mesh3D).visible = !sky;
        }
        this._graph = st.graph;
        this._params = st.graph.params;
        this._stampWorldParams();   // async/worker regen swapped the graph → re-stamp so save→reload rebuilds THIS city
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
            if (this.scene3d.shadowsEnabled) this.scene3d.setShadowHalfExtent3D(Math.max(15, tiledWorldExtent(st.graph.params) * 1.6));
            // P5.W2: the neighbour tiles stream in AFTER the centre swap (flat proxies first, full tiles via the
            // worker) — the double buffer only ever held the old world + the new centre, never two tile grids.
            this._reframeAfterTiles = this._pendingCityEnter;   // a fresh City-mode entry frames the whole world once tiles land
            this._syncNeighborTiles(st.graph.params, false);
        } else {
            if (st.graph.params.traffic === false) this.stopTraffic();
            else if (this._trafficOn || this._cityMode) {
                if (st.traffic) this._traffic.preload(st.graph, st.traffic);   // P5.W4: precomputed specs + net
                this._trafficOn = true; this._spawnTrafficSoon(st.graph);   // P5.W1: next frame (keeps the swap frame short)
            }
            this.scene3d.setShadowUpdateInterval(3);
        }
        if (!this._suppressNextFinishLighting) this._redressGlow();
        else { this._lastGlowNight = -1; this._applyGlow(0); }   // doc load: baseline glow, but don't stomp host lighting
        this._suppressNextFinishLighting = false;   // one-shot: only a document-load build sets it
        if (this._hasStyle()) this._applyRenderStyle();
        // gizmo box for the newly-revealed city — on the NEXT frame (P3.3: ~20-25 ms tree walk; keeps the swap frame short)
        if (typeof requestAnimationFrame !== 'undefined') { const c = this._cityContainer; requestAnimationFrame(() => { if (this._cityContainer === c) this._cacheCityBounds(); }); }
        else this._cacheCityBounds();
        this._lastRegen = { ms: st.t0 ? performance.now() - st.t0 : 0, kind: 'full-async' };
        // The staged groups were added SILENTLY (no per-group emit, to hide the transient 2N state) — now that
        // the swap is done, tell the host ONCE so the outliner reflects the revealed city.
        this.scene3d.notifySceneGraphChanged3D();
        // P5.W1: a City-mode entry that waited for this build runs its setup NOW, in the reveal frame (workspace +
        // framing on the real city, shadows sized to it, the city lighting, traffic) — no flash of a half-set mode.
        this._flushPendingCityEnter();
        this._previewGraph = null;
        this.scene3d.requestRender3D();
        this._setCityBuildState(false, this._cityBuildReason);   // city is now revealed → clear the "Building city…" cue
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
    get regions(): RegionSeed[] { return (this._previewGraph ?? this._graph)?.regions ?? []; }   // P5.W1: the pending first build's layout
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

    // ── Landmark hover: exact-silhouette outline + an in-canvas info card (docs/specs/hover-outline.md) ─────────
    private _hoverLm: number | null = null;
    private _landmarkCard: Mesh3D | null = null;
    private _landmarkPill: Mesh3D | null = null;   // 3D-only header pill overlay (billboard-child of the card)
    /** Hover a significant building from a viewport (CSS) pointer position — MESH-FREE (footprint point-in-polygon,
     *  the city is non-pickable). On a hit: trace the landmark's EXACT silhouette (hover-outline style) + show the
     *  in-canvas info card above it. Returns the hovered landmark (or null). Wire this to the host's pointermove. */
    hoverLandmarkAtScreen(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): { id: number; type: string; label: string } | null {
        if (!this._graph || !this._cityMode) { this.clearLandmarkHover(); return null; }
        const g = this.scene3d.pickGroundXZ(clientX, clientY, rect, this._params?.groundY ?? 0);
        if (!g) { this.clearLandmarkHover(); return null; }
        this._warpInto(g[0], g[1], this._warpScratch);                       // WARPED render space → layout space (one-step inverse)
        const lx = g[0] - this._warpScratch[0], lz = g[1] - this._warpScratch[1];
        let hit: Landmark | null = null;
        for (const lm of this._graph.landmarks) if (pointInPolygon([lx, lz], lm.footprint)) { hit = lm; break; }
        if (!hit) { this.clearLandmarkHover(); return null; }
        if (hit.id !== this._hoverLm) { this._hoverLm = hit.id; this._showLandmark(hit); }
        return { id: hit.id, type: hit.type, label: LANDMARK_LABEL[hit.type] };
    }

    /** Clear any landmark hover (outline + card). Call on pointer-leave / mode exit. */
    clearLandmarkHover(): void {
        if (this._hoverLm == null) return;
        this._hoverLm = null;
        this.scene3d.outlineLandmark3D(null);
        if (this._landmarkCard) this._startCardAnim(0);   // fade the card out, then hide it at the end
        this.scene3d.requestRender3D();
    }

    private _hoverStyleSet = false;
    private _showLandmark(lm: Landmark): void {
        if (!this._hoverStyleSet) {   // default the hover halo to animated cyan stripes (host can override via setHoverOutlineStyle3D)
            this._hoverStyleSet = true;
            this.scene3d.setHoverOutlineStyle3D({ patternMode: 1, color: [0.28, 0.82, 1.0, 0.95], patternColor: [0.92, 1.0, 1.0], thicknessPx: 10, freq: 34, speed: 0.6, glow: 1.4 });
        }
        this.scene3d.outlineLandmark3D(lm.id);   // exact silhouette (merged-mesh sub-ranges) + keep-alive
        const s = (this._graph?.radius ?? 10) / 10, gy = this._params?.groundY ?? 0;
        this._warpInto(lm.center[0], lm.center[1], this._warpScratch);
        const cx = lm.center[0] + this._warpScratch[0], cz = lm.center[1] + this._warpScratch[1];
        const topY = gy + this._heightFn(lm.center[0], lm.center[1]) + (LANDMARK_H[lm.type] ?? 0.5) * s + 0.62 * s;   // float it well above the roofline
        const cw = 1.7 * s, ch = 0.85 * s;   // 2:1, matches the 512×256 card texture
        const want3D = this._card3D;
        // (Re)build the card mesh when it's missing OR the 2D↔3D primitive changed; otherwise just reposition it.
        if (!this._landmarkCard || this._cardIs3D !== want3D) {
            if (this._landmarkCard) { this.scene3d.removeHtmlTexture3D(this._landmarkCard.id); this.scene3d.deleteMesh(this._landmarkCard.id); }
            // unlit + white diffuse → the texture shows at full brightness regardless of day/night, fog, or PS1 grade.
            // opacity 0 → the intro fades it in (and, in 3D, grows + spins it in). Geometry is baked at cw×ch, so
            // scale is used purely as the grow multiplier (rest = 1) — NOT as the card size (that was a sizing bug).
            const mat = { renderStyle: 'unlit' as const, diffuse: { r: 1, g: 1, b: 1, a: 1 }, opacity: 0 };
            // 3D: a ROUNDED-rect slab whose corner radius (world) matches the card texture's radius (px) so the front
            // face lines up exactly with the rounded card — no square corners, no cream showing through. cw:ch = 512:256.
            const radW = (CARD3D_RADIUS_PX / 512) * cw;
            this._landmarkCard = want3D
                ? this.scene3d.createRoundedSlab(cx, topY, cz, cw, ch, 0.11 * ch, radW, mat)   // extruded rounded card-stock slab
                : this.scene3d.createSprite(cx, topY, cz, cw, ch, mat);                        // flat 2D card
            this._landmarkCard.billboard = true;          // always faces the camera (ortho + perspective)
            this._landmarkCard.alwaysOnTop = true;         // drawn last, in the post-processing-immune overlay pass
            this._landmarkCard.excludeFromDocument = true;
            this._landmarkCard.pickable = false;
            this._cardIs3D = want3D;
            this._cardOpacity = 0;
        } else {
            this._landmarkCard.x = cx; this._landmarkCard.y = topY; this._landmarkCard.z = cz;
            this._landmarkCard.updateLocalMatrix();   // reposition only — size is baked, scale is the grow multiplier
            this._landmarkCard.visible = true;
        }
        // Start the intro only AFTER the card texture is ready — otherwise the first show (new mesh, texture still
        // rasterizing) burns the animation while the card is invisible, so it "pops in" done; a reused card resolves
        // instantly and animates as normal. Guard on the hover id in case the pointer left before the texture landed.
        const showId = lm.id;
        const ready = this.scene3d.setCanvasTexture3D(this._landmarkCard.id, 512, 256, (ctx, w, h) => drawLandmarkCard(ctx, w, h, lm, this._cardStyle, this._cardIs3D));
        this._ensureLandmarkPill(want3D, cw, ch, LANDMARK_LABEL[lm.type] ?? 'BUILDING');   // 3D header pill overlay
        void ready.then(() => { if (this._hoverLm === showId) this._startCardAnim(1); });   // fade in (+ grow & spin-in when 3D)
        this.scene3d.requestRender3D();
    }

    /** Create / update / tear down the 3D header pill — a billboard-CHILD of the card so it faces the camera, spins,
     *  and grows in lockstep while sitting at a fixed offset that lets it stick out above the card's top edge. In 2D
     *  the pill is drawn into the card texture instead, so this removes any pill mesh. */
    private _ensureLandmarkPill(want3D: boolean, cw: number, ch: number, label: string): void {
        if (!want3D) {
            if (this._landmarkPill) { this.scene3d.removeHtmlTexture3D(this._landmarkPill.id); this.scene3d.deleteMesh(this._landmarkPill.id); this._landmarkPill = null; }
            return;
        }
        const name = label.toUpperCase();
        const pillTexW = 360, pillTexH = 104;
        const pillH = 0.19 * ch, pillW = (pillTexW / pillTexH) * pillH;
        if (!this._landmarkPill) {
            this._landmarkPill = this.scene3d.createSprite(0, 0, 0, pillW, pillH, { renderStyle: 'unlit', diffuse: { r: 1, g: 1, b: 1, a: 1 }, opacity: 0 });
            this._landmarkPill.alwaysOnTop = true;         // drawn in the same post-processing-immune overlay pass as the card
            this._landmarkPill.excludeFromDocument = true;
            this._landmarkPill.pickable = false;
        }
        // Ride the card's billboard basis, offset to the top-left and pushed just in front of the card face; the +Y
        // component pokes it above the top edge so it "sticks out" like the 2D pill (parent = the CURRENT card mesh).
        this._landmarkPill.billboardParent = this._landmarkCard;
        this._landmarkPill.billboardOffset = [
            -cw * 0.5 + pillW * 0.5 + cw * 0.045,   // left-aligned near the card's left edge
            ch * 0.5 - pillH * 0.15,                 // near the top → ~35% of the pill overhangs above the card
            (0.11 * ch) * 0.5 + cw * 0.006,          // just in front of the card's front face (avoids z-fighting)
        ];
        this._landmarkPill.visible = true;
        void this.scene3d.setCanvasTexture3D(this._landmarkPill.id, pillTexW, pillTexH, (ctx, w, h) => drawLandmarkPill(ctx, w, h, name));
    }

    private _setPillOpacity(o: number, hideAtZero = false): void {
        if (!this._landmarkPill) return;
        this._landmarkPill.material.opacity = o;   // pushed to the GPU by refreshBillboards (no materialDirty → no repack)
        if (hideAtZero && o <= 0) this._landmarkPill.visible = false;
    }

    // Card intro/outro animation. The card's final alpha = material.opacity × texture alpha, so a cheap FADE is just
    // animating material.opacity + marking the mesh materialDirty (the light per-slot repack, NOT the heavy gpuDirty).
    // The 3D card additionally GROWS (easeOutBack scale pop) and SPINS in (a decaying Y-spin that ends flat-on) — the
    // grow is scale, the spin is Mesh3D.billboardSpinY (applied inside the renderer's billboard basis so it settles to
    // a perfectly face-on, readable billboard). Driven by rAF; each tick requests a frame so it runs even after the
    // hover keep-alive ends. `_card3D` = the toggle; `_cardIs3D` = the primitive the current card mesh was built with.
    private _card3D = false;
    private _cardIs3D = false;
    private _cardOpacity = 0;
    private _cardFadeTarget = 0;
    private _cardFadeRAF: number | null = null;
    private _cardFadeLast = 0;
    private _cardIntroStart = 0;
    private static readonly CARD_FADE_MS = 160;
    private static readonly CARD_GROW_MS = 520;   // easeOutBack scale pop (slower, gentler grow)
    private static readonly CARD_SPIN_MS = 640;   // Y-spin decay
    private static readonly CARD_SPIN_TURNS = 1.0;   // exactly one revolution before settling face-on
    private static _easeOutBack(x: number): number { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }
    private static _easeOutCubic(x: number): number { return 1 - Math.pow(1 - x, 3); }

    // Apply this frame's grow + spin (3D card only) from _cardIntroStart. Uses billboardScale/billboardSpinY (NOT
    // setScale3D) so the update never dirties the mesh into a full instance repack — see _pushCardFrame.
    private _applyCardIntro(): void {
        if (!this._landmarkCard || !this._cardIs3D) return;
        const age = performance.now() - this._cardIntroStart;
        const g = WorldManager._easeOutBack(Math.min(age / WorldManager.CARD_GROW_MS, 1));           // 0 → 1 (overshoot)
        const t = Math.min(age / WorldManager.CARD_SPIN_MS, 1);
        this._landmarkCard.billboardScale = g;
        this._landmarkCard.billboardSpinY = WorldManager.CARD_SPIN_TURNS * Math.PI * 2 * (1 - WorldManager._easeOutCubic(t)); // decays to 0
    }
    private _cardIntroDone(): boolean {
        return !this._cardIs3D || (performance.now() - this._cardIntroStart) >= WorldManager.CARD_SPIN_MS;
    }
    private _settleCard(): void {   // snap to the final rest pose (full scale, no spin)
        if (this._landmarkCard && this._cardIs3D) { this._landmarkCard.billboardScale = 1; this._landmarkCard.billboardSpinY = 0; }
    }
    // Push this frame of the card (+pill) — opacity is set WITHOUT materialDirty and the whole update goes to just
    // their instance slots (refreshBillboards), so animating the card doesn't trigger a full-buffer repack per frame.
    private _pushCardFrame(): void {
        if (this._landmarkCard) this._landmarkCard.material.opacity = this._cardOpacity;
        this._setPillOpacity(this._cardOpacity, this._cardFadeTarget === 0 && Math.abs(this._cardOpacity) < 0.004);
        const anims = this._landmarkPill && this._cardIs3D && this._landmarkPill.visible
            ? [this._landmarkCard!, this._landmarkPill] : (this._landmarkCard ? [this._landmarkCard] : []);
        if (anims.length) this.scene3d.refreshBillboards3D(anims);
    }

    private _startCardAnim(target: number): void {
        this._cardFadeTarget = target;
        if (target === 1 && typeof performance !== 'undefined') this._cardIntroStart = performance.now();
        if (typeof requestAnimationFrame === 'undefined') {   // non-browser (tests): snap, no animation
            this._cardOpacity = target;
            if (this._landmarkCard) {
                this._landmarkCard.material.opacity = target; this._landmarkCard.materialDirty = true;
                if (target === 1) this._settleCard(); else this._landmarkCard.visible = false;
            }
            this._setPillOpacity(target, target === 0);
            return;
        }
        if (this._cardFadeRAF != null) return;   // a run is already active; it will chase the new target + intro start
        this._cardFadeLast = performance.now();
        const tick = () => {
            const now = performance.now();
            const dt = Math.min(64, now - this._cardFadeLast); this._cardFadeLast = now;
            const step = dt / WorldManager.CARD_FADE_MS;
            this._cardOpacity = this._cardOpacity < this._cardFadeTarget
                ? Math.min(this._cardFadeTarget, this._cardOpacity + step)
                : Math.max(this._cardFadeTarget, this._cardOpacity - step);
            if (this._cardFadeTarget === 1) this._applyCardIntro();   // grow + spin while showing (3D only)
            const fadeDone = Math.abs(this._cardOpacity - this._cardFadeTarget) < 0.004;
            if (fadeDone && (this._cardFadeTarget === 0 || this._cardIntroDone())) {
                this._cardOpacity = this._cardFadeTarget;
                if (this._cardFadeTarget === 1) this._settleCard();
                this._pushCardFrame();                                       // final rest frame → GPU slot
                if (this._cardFadeTarget === 0 && this._landmarkCard) this._landmarkCard.visible = false;
                this._cardFadeRAF = null;
                this.scene3d.requestRender3D();
                return;
            }
            this._pushCardFrame();               // opacity + grow/spin → just the card/pill slots (no full repack)
            this.scene3d.requestRender3D();
            this._cardFadeRAF = requestAnimationFrame(tick);
        };
        this._cardFadeRAF = requestAnimationFrame(tick);
    }

    /** Toggle the 3D info card: an extruded card-stock SLAB (real thickness) with a grow + spin-in-and-settle intro.
     *  Off (default) = the flat 2D card. Rebuilds the card mesh as the right primitive; re-shows if one is hovered. */
    setCard3D(on: boolean): void {
        if (on === this._card3D) return;
        this._card3D = on;
        if (this._landmarkCard) {   // drop the current card so the next show rebuilds it as the right primitive
            this.scene3d.removeHtmlTexture3D(this._landmarkCard.id);
            this.scene3d.deleteMesh(this._landmarkCard.id);
            this._landmarkCard = null;
        }
        if (this._landmarkPill) {   // and its header pill overlay (parented to the card that's now gone)
            this.scene3d.removeHtmlTexture3D(this._landmarkPill.id);
            this.scene3d.deleteMesh(this._landmarkPill.id);
            this._landmarkPill = null;
        }
        if (this._hoverLm != null && this._graph) {   // re-show immediately if a landmark is hovered
            const lm = this._graph.landmarks.find(l => l.id === this._hoverLm);
            if (lm) this._showLandmark(lm);
        }
    }
    /** Whether the 3D (extruded slab) info card is enabled. */
    get card3D(): boolean { return this._card3D; }

    // Hover-card visual style. 'playful' = an Animal-Crossing-style bubbly card with an angled header pill.
    private _cardStyle: 'default' | 'playful' = 'playful';
    /** Choose the hover info-card style ('default' = sleek dark, 'playful' = bubbly AC-style). */
    setHoverCardStyle(style: 'default' | 'playful'): void {
        this._cardStyle = style;
        if (this._hoverLm != null && this._graph) { const lm = this._graph.landmarks.find(l => l.id === this._hoverLm); if (lm && this._landmarkCard) void this.scene3d.setCanvasTexture3D(this._landmarkCard.id, 512, 256, (ctx, w, hh) => drawLandmarkCard(ctx, w, hh, lm, this._cardStyle, this._cardIs3D)); }
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
        this._stampWorldParams();   // persist the chosen time (the day-cycle TICKER mutates _timeOfDay directly, not here)
    }

    /** Toggle whether the city drives its OWN day/night lighting (true) or inherits the host's global scene lighting
     *  (false). Flipping it while the City Tool is open takes effect immediately: ON → snapshot global + apply the
     *  city look; OFF → hand the global lighting back. Persisted with the city (worldParams.lighting). */
    setOverrideGlobalLighting(on: boolean): void {
        if (on === this._overrideGlobalLighting) return;
        this._overrideGlobalLighting = on;
        this._stampWorldParams();      // persist the toggle even if we're not currently in city mode
        if (!this._cityMode) return;   // out of city mode there's nothing live to switch
        if (on) {
            this._snapshotGlobalLighting();
            this.setCinematicGrade(true);
            this.setTimeOfDay(this._timeOfDay ?? 0.5);
        } else {
            this.setCinematicGrade(false);     // hand post-FX back
            this._restoreGlobalLighting();     // hand sun/ambient/sky/fog/shadows back
            this.scene3d.requestRender3D();
        }
    }
    /** Current time of day 0..1, or null (untouched — the editor's default lighting). */
    get timeOfDay(): number | null { return this._timeOfDay; }

    /** Rotate the SUN's compass bearing (radians). The daily east→west arc is added on top, so this turns the whole
     *  arc — use it to move shadows onto any side of the city. Live (re-applies the current time of day). Persisted. */
    setSunAzimuth(radians: number): void {
        this._sunAzimuth = radians;
        if (this._timeOfDay != null) this._applyTimeOfDay();
        this._stampWorldParams();   // persist the sun bearing
    }
    /** Current sun bearing (radians). */
    get sunAzimuth(): number { return this._sunAzimuth; }

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
            // Optional bloom keys the host never set (wide glow, A6 chroma gate) are reset explicitly — setPostProcessing
            // merges, so an absent key would otherwise keep the city's value after exit.
            const pre = this._prePostFX;
            this.scene3d.setPostProcessing3D({ ...pre, bloom: { wide: 0, chromaGate: 0, ...pre.bloom } });
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
        this._stampWorldParams();   // grade keys persist with the city (city-quality P1)
    }
    /** The current keyframes (live reference — read for seeding the host UI). */
    get timeGradeKeys(): Record<TimeGradePhase, TimeGradeKey> { return this._gradeKeys; }

    // ── SKY colour keyframes (author your own sky palette across the day) ─────────────────────────
    /** Set ONE sky keyframe (partial merge: pass `top`, `bottom`, or both). The cycle lerps the four phases
     *  (night 0 · dawn 0.25 · noon 0.5 · dusk 0.75) as timeOfDay moves, so this authors the sky across the day. */
    setSkyKey(phase: TimeGradePhase, values: Partial<SkyKey>): void {
        if (values.top)    this._skyKeys[phase].top    = [values.top[0], values.top[1], values.top[2]];
        if (values.bottom) this._skyKeys[phase].bottom = [values.bottom[0], values.bottom[1], values.bottom[2]];
        if (this._timeOfDay != null) this._applyTimeOfDay();
        this._stampWorldParams();
    }
    /** Set SEVERAL sky keyframes at once (an authored day palette). Partial per phase — omit a phase to keep it. */
    setSkyKeyframes(keys: Partial<Record<TimeGradePhase, Partial<SkyKey>>>): void {
        for (const p of Object.keys(keys) as TimeGradePhase[]) {
            const v = keys[p]; if (!v) continue;
            if (v.top)    this._skyKeys[p].top    = [v.top[0], v.top[1], v.top[2]];
            if (v.bottom) this._skyKeys[p].bottom = [v.bottom[0], v.bottom[1], v.bottom[2]];
        }
        if (this._timeOfDay != null) this._applyTimeOfDay();
        this._stampWorldParams();
    }
    /** Restore the built-in night→dawn→noon→dusk sky palette. */
    resetSkyKeys(): void {
        this._skyKeys = JSON.parse(JSON.stringify(DEFAULT_SKY)) as Record<TimeGradePhase, SkyKey>;
        if (this._timeOfDay != null) this._applyTimeOfDay();
        this._stampWorldParams();
    }
    /** The current sky keyframes (live reference — read for seeding the host UI). */
    get skyKeys(): Record<TimeGradePhase, SkyKey> { return this._skyKeys; }

    /** Lerp the four sky keyframes at time-of-day `t` (keys sit at 0 night · 0.25 dawn · 0.5 noon · 0.75 dusk). */

    /** Lerp the four grade keyframes at time-of-day `t` (keys sit at 0 night · 0.25 dawn · 0.5 noon · 0.75 dusk). */
    /** The grade for SUN-driven phase weights (city-quality L8 — agrees with the light, unlike the clock lerp). */
    private _gradeAtWeights(w: Record<TimeGradePhase, number>): TimeGradeKey {
        const out: TimeGradeKey = { bloomThreshold: 0, bloomIntensity: 0, brightness: 0, contrast: 0, saturation: 0, tint: [0, 0, 0], vignette: 0, shadowTint: [0, 0, 0], highlightTint: [0, 0, 0] };
        for (const k of Object.keys(w) as TimeGradePhase[]) {
            const g = this._gradeKeys[k], x = w[k];
            const st = g.shadowTint ?? [1, 1, 1], ht = g.highlightTint ?? [1, 1, 1];
            for (let i = 0; i < 3; i++) { out.shadowTint![i] += st[i] * x; out.highlightTint![i] += ht[i] * x; }
            out.bloomThreshold += g.bloomThreshold * x; out.bloomIntensity += g.bloomIntensity * x;
            out.brightness += g.brightness * x; out.contrast += g.contrast * x; out.saturation += g.saturation * x;
            out.tint[0] += g.tint[0] * x; out.tint[1] += g.tint[1] * x; out.tint[2] += g.tint[2] * x;
            out.vignette += g.vignette * x;
        }
        return out;
    }

    // ── Traffic sim (v1 — a first taste of the src/game tick) ────────────────────────────────────
    /** Start MOVING traffic: cars driving the long road runs (left-hand, both directions), a moving train on
     *  the viaduct (the parked one hides), and strolling walkers. Runs on the shared ticker; regen-safe. */
    // ── Traffic sim — extracted (world-traffic.ts, audit C3); the shared ticker + centre-gate stay HERE. ──
    startTraffic(): void { this._traffic.start(); }
    /** E3: traffic-signal phase timing in seconds (green / yellow / all-red). Persisted with the city. */
    setSignalTiming(t: { green?: number; yellow?: number; allRed?: number }): void { this._traffic.setSignalTiming(t); this._stampWorldParams(); }
    get signalTiming(): { green: number; yellow: number; allRed: number } { return { ...this._traffic.timing }; }
    /** Stop and remove the movers (the static parked train returns on the next regen). */
    stopTraffic(): void { this._traffic.stop(); }
    /** Whether the traffic sim is running. */
    get trafficRunning(): boolean { return this._traffic.on; }
    private _spawnTraffic(): void { this._traffic.spawn(); }
    private _despawnTraffic(): void { this._traffic.despawn(); }
    private _tickTraffic(dt: number): void { this._traffic.tick(dt); }

    private _tickerRaf = 0;
    private _tickerPrev = 0;
    private _tickErrorLogged = false;
    private _liveCrowdErr = false;
    private _moverShadowErr = false;
    private _crowdErr = false;
    public _ensureTicker(): void {
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
                if (this._liveCrowd.active) this._liveCrowd.update(dt);   // Round 7: idle the live near-field crowd
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
            if (!this._cycleOn && !trafficLive && !stormy && this._turntable === 0 && !(this._editPulseOn && this._cityMode) && !this._liveCrowd.active) { this._tickerRaf = 0; return; }   // nothing left to animate
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

    public _allWorldMeshes(): Mesh3D[] {
        const out: Mesh3D[] = [];
        for (const g of this._groups) for (const child of g.children) out.push(child as Mesh3D);
        return out;
    }

    // ── Real TEXT signs (landmark name plates + shotengai arch boards) ───────────────────────────
    // The pure module computes label + placement + quad; here each label is rasterized to a small canvas and
    // bound as the mesh texture. Browser-only (headless builds show the plain plate colour).
    private _addTextSigns(graph: WorldGraph): void {
        // Landmark/shop/street-name plates + the signal street-name plates & STOP lettering + regulatory road-sign
        // plates (NO PARKING / ONE WAY / …) — all rasterized here in one batch.
        const specs = [...computeTextSigns(graph), ...computeSignalTextSigns(graph, this._regionFilter()),
            ...buildRoadSigns(graph, this._regionFilter()).textSigns];
        if (!specs.length) return;
        this._add('World Sign Text', specs.map(sp => sp.layer));
        if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return;
        const group = this._groups[this._groups.length - 1];
        // BATCH all ~75 bitmaps and apply them in ONE go — resolving them one-by-one used to trigger a
        // per-arrival repack for many consecutive frames right after every regen (a visible hitch window).
        // Bitmaps are CACHED by label+colour across regens (STATION / BAKERY / 1ST AVE recur every city),
        // so a typical slider regen rasterizes zero new canvases.
        // P5.W4: the NEW canvases (~35 ms on a session's first city, in the reveal frame) rasterize TIME-SLICED from
        // the next frame on, under the shared slice budget — the plates show their base colour for those few frames,
        // as they already did while createImageBitmap resolved. A newer sign batch (a regen) abandons this one.
        const gen = ++this._signGen;
        const jobs: Promise<{ id: string; bmp: ImageBitmap }>[] = [];
        const raster: Array<() => void> = [];
        specs.forEach((sp, i) => {
            const mesh = group.children[i] as Mesh3D;
            if (!mesh) return;
            const key = sp.label + '|' + sp.layer.color.map(c => c.toFixed(3)).join(',') + (sp.square ? '|sq' : '');
            const cached = this._signBitmaps.get(key);
            if (cached) { jobs.push(Promise.resolve({ id: mesh.id, bmp: cached })); return; }
            jobs.push(new Promise(resolve => raster.push(() => {
                const hit = this._signBitmaps.get(key);   // (an earlier plate of this batch may have made it)
                if (hit) { resolve({ id: mesh.id, bmp: hit }); return; }
                const bmp = this._rasterSign(sp);
                if (!bmp) { resolve({ id: mesh.id, bmp: null as unknown as ImageBitmap }); return; }
                void bmp.then(b => { this._signBitmaps.set(key, b); resolve({ id: mesh.id, bmp: b }); });
            })));
        });
        const apply = (): void => {
            void Promise.all(jobs).then(results => {
                if (gen !== this._signGen) return;   // superseded by a newer batch (its meshes were replaced)
                for (const { id, bmp } of results) if (bmp) void this.scene3d.setMeshTexture(id, bmp);
            });
        };
        if (!raster.length) { apply(); return; }
        if (typeof requestAnimationFrame === 'undefined') { for (const r of raster) r(); apply(); return; }
        let k = 0;
        const step = (): void => {
            if (gen !== this._signGen) return;
            const t0 = performance.now(), budget = this._sliceBudgetMs();
            do raster[k++](); while (k < raster.length && performance.now() - t0 < budget);
            if (k < raster.length) requestAnimationFrame(step); else this.scene3d.requestRender3D();
        };
        apply();
        requestAnimationFrame(step);
    }
    private _signGen = 0;
    /** Rasterize one sign plate (label on its colour) → an ImageBitmap promise (null without a 2D context). */
    private _rasterSign(sp: { label: string; square?: boolean; layer: { color: [number, number, number] } }): Promise<ImageBitmap> | null {
        {
            const cv = document.createElement('canvas');
            // Square signs (STOP + other square plates) rasterize on a SQUARE canvas so the letters aren't stretched
            // tall by the 4:1 default meant for wide street-name plates.
            const W = sp.square ? 144 : 256, H = sp.square ? 144 : 64;
            cv.width = W; cv.height = H;
            const ctx = cv.getContext('2d');
            if (!ctx) return null;
            const [r, g, b] = sp.layer.color;
            ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#f6f1e2';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            let px = sp.square ? 56 : 40;   // shrink-to-fit
            do { ctx.font = `bold ${px}px sans-serif`; px -= 2; } while (px > 12 && ctx.measureText(sp.label).width > W - 20);
            ctx.fillText(sp.label, W / 2, H * 0.54);
            return createImageBitmap(cv);
        }
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
        this.applyLook(pack.look ?? {});   // city-quality P1: the full look (resets what the pack doesn't set)
        if (pack.renderStyle !== undefined && !pack.look?.cityStyle) this.setRenderStyle(pack.renderStyle ?? null);
        if (pack.timeOfDay !== undefined) this.setTimeOfDay(pack.timeOfDay);
        return graph;
    }
    /** The available style pack names (for a panel dropdown). */
    get styleNames(): string[] { return [...CITY_STYLE_NAMES]; }
    /** Style packs with display labels (for a panel's preset buttons). */
    get styles(): { name: string; label: string }[] { return CITY_STYLES.map((s) => ({ name: s.name, label: s.label })); }

    /** Restyle the WHOLE city live: 'cel' / 'cel-hd' (toon), 'sketch', 'ink', 'gouraud' (PS1), or null → default PBR.
     *  (For the full retro pipeline — low res / dither / affine — combine with sm.setRetroPreset('wobble'|'pocket').) */
    setRenderStyle(style: RenderStyle | null): void {
        this.setStyle({ renderStyle: style });
    }
    /** The current world-wide style override, or null (PBR). */
    get renderStyle(): RenderStyle | null { return this._style?.renderStyle ?? null; }

    /** Set (merge) the city's LOOK: render style + toon shadows + rim light. `null` clears a field (back to the
     *  generator's default, applied in place — a full city rebuild is too heavy). Persists in the City marker and
     *  carries to cities generated later. Unlit meshes (labels, info cards) are never restyled. */
    setStyle(patch: ObjectStylePatch): void {
        const cleared = neutralizeClearedFields(this._style, patch);
        const next = mergeObjectStyle(this._style, patch);
        this._style = isEmptyStyle(next) ? undefined : next;
        for (const g of this._groups) applyObjectStyle(g, cleared);   // cleared fields → neutral values
        this._applyRenderStyle();
        this._stampWorldParams();
    }
    /** The city's look ({} = none). */
    getStyle(): ObjectStyle { return { ...(this._style ?? {}) }; }
    /** Document-load reset: forget the previous document's city look (restoreFromSave sets the new one). */
    resetStyleForLoad(): void { this._style = undefined; }

    public _applyRenderStyle(): void {
        for (const g of this._groups) applyObjectStyle(g, this._style);
        this._applyPedStyle();   // the crowd's own style wins over the city's (after it)
        this.scene3d.requestRender3D();
    }

    // ── PEDESTRIAN STYLE (LayoutParams.pedestrianStyle) ──────────────────────────────────────────────────────────
    // The crowd — static people (both twins), walkers, and through them the live near-field rigs (world-live-crowd
    // mirrors its source meshes' materials) — can be shaded apart from the city. 'flat' (default) is the Persona-NPC
    // colour-block look: the build colours are pre-dimmed (PED_SHADE.diffuse) and the GLOW table lifts them; it follows
    // the city's render style. Any other value un-dims the colour, drops the lift and sets that render style on the
    // crowd only. A pure material pass (no regen), re-run after every build / spawn / glow re-dress.
    private static readonly CROWD_RE = /world:ped-|world:traffic-walker/;
    /** Each crowd mesh's BUILD diffuse (the pre-dimmed palette colour), recorded the first time the style touches it. */
    private _pedOrig = new WeakMap<Mesh3D, { r: number; g: number; b: number }>();
    /** The crowd's shading ('flat' when unset — the saved-city default). */
    get pedestrianStyle(): PedestrianStyle { const s = this._params?.pedestrianStyle; return s && PEDESTRIAN_STYLES.includes(s) ? s : 'flat'; }
    /** Set the crowd's shading live: 'flat' | 'default' | 'cel' | 'cel-hd' | 'ink'. Persisted with the city params. */
    setPedestrianStyle(style: PedestrianStyle): void {
        const s: PedestrianStyle = PEDESTRIAN_STYLES.includes(style) ? style : 'flat';
        if (!this._params) return;
        if (s === 'flat') delete this._params.pedestrianStyle; else this._params.pedestrianStyle = s;   // (the same object as graph.params)
        this._applyPedStyle();
        this._stampWorldParams();
    }
    /** One crowd mesh's diffuse + render style for the current pedestrian style (idempotent). */
    private _pedLook(m: Mesh3D, name: string): void {
        const mat = m.material;
        if (!mat || (mat.renderStyle as string) === 'unlit') return;
        const st = this.pedestrianStyle;
        let o = this._pedOrig.get(m);
        if (!o) {
            if (st === 'flat') return;   // never touched → still exactly the build (flat) look
            o = { r: mat.diffuse.r, g: mat.diffuse.g, b: mat.diffuse.b };
            this._pedOrig.set(m, o);
        }
        const k = st === 'flat' || /robot/.test(name) ? 1 : 1 / PED_SHADE.diffuse;   // (the robot walkers were never dimmed)
        mat.diffuse = { r: Math.min(1, o.r * k), g: Math.min(1, o.g * k), b: Math.min(1, o.b * k), a: mat.diffuse.a };
        const want: RenderStyle = st === 'flat' ? (this._style?.renderStyle ?? 'default') : st;
        if (mat.renderStyle !== want) mat.renderStyle = want;
        m.materialDirty = true;
    }
    /** The crowd's (day, night) emissive factors: the flat lift, or the ordinary baseline once it is lit normally. */
    private _pedGlow(name: string): [number, number] {
        return this.pedestrianStyle === 'flat' || /robot/.test(name) ? [PED_SHADE.emissive, PED_SHADE.emissiveNight] : [0.05, 0.03];
    }
    /** Re-dress every crowd mesh for the current pedestrian style (diffuse, render style, emissive). */
    public _applyPedStyle(): void {
        const night = this._lastGlowNight >= 0 ? this._lastGlowNight : 0;
        for (const g of this._groups) for (const child of g.children) {
            const m = child as Mesh3D, name = m.name ?? '';
            if (!m.material || !WorldManager.CROWD_RE.test(name)) continue;
            this._pedLook(m, name);
            const [fd, fn] = this._pedGlow(name), f = fd + (fn - fd) * night, d = m.material.diffuse;
            m.material.emissive = { r: d.r * f, g: d.g * f, b: d.b * f, a: 1 };
            m.materialDirty = true;
        }
        this.scene3d.requestRender3D();
    }

    public _applyTimeOfDay(): void {
        const t = this._timeOfDay;
        if (t == null) return;
        // City lighting writes GLOBAL uniforms → only do it while the City Tool is open AND the city is overriding
        // global lighting. Outside city mode (e.g. a doc-load generateWorld) it must NOT stomp the host's lighting.
        if (!this._cityMode || !this._overrideGlobalLighting) return;
        const weather = this._params?.weather ?? 'clear';
        const rain = weather === 'rain';
        const flash = this._flash;                                  // lightning strobe (storms; set by the ticker)
        // All curves + colours live in src/world/day-night.ts (pure, unit-tested) — this method just APPLIES them.
        const L = computeDayNight(t, { weather, flash, sunAzimuth: this._sunAzimuth, skyKeys: this._skyKeys, sunWarmth: this._sunWarmth, keyFill: this._keyFill, coolFill: this._coolFill });

        this.scene3d.setDirectionalLight(L.sunDir[0], L.sunDir[1], L.sunDir[2], L.sunColor[0], L.sunColor[1], L.sunColor[2], L.sunIntensity);
        this.scene3d.setAmbientLight(L.ambientColor[0], L.ambientColor[1], L.ambientColor[2], L.ambientIntensity);

        // SKY: the City-mode focus background is a day↔dusk↔night gradient, lerped from the four sky keyframes
        // (night/dawn/noon/dusk). Author your own palette across the day via setSkyKey / setSkyKeyframes.
        const top = L.sky.top, bot = L.sky.bottom;
        if (this._skyDomeOn()) {
            // visual-polish #9: the stylised SKY DOME (view-direction gradient + city glow + sun / moon / stars + anime
            // clouds) from the same keys; the gradient colours stay as its compile-time fallback. A backdrop only: the
            // sky lighting below still bakes from the keys alone.
            const p = this._params;
            const sky = skyDomeParams({ t, L, sunAzimuth: this._sunAzimuth, weather, dome: this._skyDome!,
                clouds: this._paintedClouds && (p?.clouds ?? true) && this._domeCloudsLive(), cloudDensity: p?.cloudDensity ?? 0.4, seed: p?.seed ?? 1 });
            this.scene3d.setMeshEditBgMode3D({ mode: 'sky', color1: [top[0], top[1], top[2], 1], color2: [bot[0], bot[1], bot[2], 1], sky });
        } else {
            this.scene3d.setMeshEditBgMode3D({ mode: 'gradient', color1: [top[0], top[1], top[2], 1], color2: [bot[0], bot[1], bot[2], 1] });
        }

        // DISTANCE FOG: haze matched to the horizon colour; camera-relative distances scale with the world
        // extent (a tiled world is several cities wide → push it back). The `fog` param is the panel toggle.
        if (this._fogLocked()) {
            // Hard fog edge: leave the user's fog exactly as set (onFogHardEdgeChanged re-runs this when it's turned off).
        } else if (this._params?.fog === false) {
            this.scene3d.setFog3D({ mode: 'off' });
            this._fogColor = null;
        } else {
            const R = this._params?.worldMode === 'tiled' && this._params ? tiledWorldExtent(this._params) : (this._params?.radius ?? 10);
            this.scene3d.setFog3D({ mode: 'linear', color: [L.fogColor[0], L.fogColor[1], L.fogColor[2]], near: R * L.fogNearMult, far: R * L.fogFarMult, density: 0.1 });
            this._fogColor = [L.fogColor[0], L.fogColor[1], L.fogColor[2]];   // remembered so streaming can re-derive zoom-aware distances (see _streamCb)
        }

        this._applyGlow(L.night);
        this._applyPlayerLight(L.night);   // visual-polish #7c
        {   // city-quality L3: coloured shadows — the look's per-phase hues blended by the sun weights
            const c: [number, number, number] = [0, 0, 0];
            for (const k of Object.keys(L.weights) as TimeGradePhase[]) for (let i = 0; i < 3; i++) c[i] += this._shadowTints[k][i] * L.weights[k];
            this.scene3d.setShadowTint3D(c);
        }
        this._applySkyLighting(L);
        this._applyWetReflections(L.night, weather === 'rain');
        this._applyHeightFog(L, weather);
        this._applyAerialHaze(L, weather);

        // REAL POINT LIGHTS at night: street lamps become actual lights. ★ Send EVERY junction lamp as a
        // CANDIDATE — the renderer keeps only the ~16 nearest the CAMERA each frame, so the fixed GPU light
        // budget follows the view. Rebuild+resend only when the night level crosses a 0.05 bucket or the city
        // graph changes (the fade re-sends ~20× total, not per-frame — mirrors the _lastGlowNight gate).
        {
            const g = this._graph;
            const lampOn = g ? L.lampOn : 0;
            const lampBucket = lampOn > 0 ? Math.round(lampOn / 0.05) : 0;
            if (lampBucket !== this._lastLampBucket || g !== this._lampGraph) {
                this._lastLampBucket = lampBucket;
                this._lampGraph = g;
                if (lampOn > 0 && g) {
                    const s = g.params.radius / 10;
                    const lights: { pos: [number, number, number]; radius: number; color: [number, number, number]; intensity: number }[] = [];
                    for (let i = 0; i < g.intersections.length; i++) {
                        const it = g.intersections[i];
                        if (cellLevelAt(g, it.pos[0], it.pos[1]) < 0) continue;   // no lamp in a canal
                        this._warpInto(it.pos[0], it.pos[1], this._warpScratch);
                        lights.push({
                            pos: [it.pos[0] + this._warpScratch[0], g.params.groundY + this._heightFn(it.pos[0], it.pos[1]) + 0.34 * s, it.pos[1] + this._warpScratch[1]],   // L10: at lamp-head height (~5 m; was 0.2*s ≈ 3 m)
                            radius: 0.85 * s, color: [this._lampColor[0], this._lampColor[1], this._lampColor[2]], intensity: 0.9 * lampOn,
                        });
                    }
                    this.scene3d.setCandidatePointLights3D(lights);
                } else {
                    this.scene3d.setCandidatePointLights3D([]);
                }
            }
        }

        // CINEMATIC GRADE: drive the post stack (bloom / colour grade / vignette) from the four time-of-day
        // keyframes. Lightning flashes momentarily crank the bloom (the sky blows out, like a real strike).
        if (this._gradeOn) {
            const g = this._gradeAtWeights(L.weights);
            this.scene3d.setPostProcessing3D({
                // wide: city-quality P6 — the mip-chain glow, strongest at night (neon + lamps bleed like a lens).
                bloom: { enabled: true, threshold: Math.max(0.05, g.bloomThreshold * (1 - flash * 0.4)), intensity: g.bloomIntensity * (1 + flash * 0.9), wide: 0.3 + 0.7 * L.night,
                    // persona-polish A6: only LIGHTS bloom — near-neutral paint / paving is gated out (fully by day; at
                    // night partly, so white lightboxes and lit windows still glow).
                    chromaGate: 1 - 0.6 * L.night },
                colorGrade: { enabled: true, brightness: g.brightness, contrast: g.contrast, saturation: g.saturation, tint: g.tint, shadowTint: g.shadowTint, highlightTint: g.highlightTint },
                vignette: { enabled: g.vignette > 0.01, intensity: g.vignette, radius: 0.78, softness: 0.5 },
            });
        }
        if (rain) this._ensureTicker();   // storms need the shared clock alive for lightning (idempotent)
    }

    // ── City LOOK (city-quality P1/P4/P5): what a style pack sets beyond layout. Persisted in the City marker. ──
    private _shadowTints: Record<TimeGradePhase, [number, number, number]> = JSON.parse(JSON.stringify(SHADOW_TINTS));
    private _lampColor: [number, number, number] = [1.0, 0.85, 0.55];
    private _skyLighting = false;       // light the city from its own sky (IBL)
    private _reflections = false;       // SSR on wet / night streets
    private _lookOutlines = false;      // did a LOOK turn the screen-space outlines on (so a later look may turn them off)
    private _lookSSAO = false;          // ditto for SSAO
    // The city's OWN outlines / SSAO (persisted in the marker). City exit hands the host its global settings back,
    // which switches both off — city enter re-applies them from these (they were lost on re-enter before).
    private _ssaoOn = false;
    private _outlinesCfg: CityOutlines | null = null;
    private _lastSkyBucket = '';
    private _ssrByCity = false;

    /** Apply a pack LOOK (city-quality P1). Fields the look omits are RESET to the engine defaults, so switching packs
     *  never leaves the previous pack's grade / shadows / outlines behind. Re-applies the time of day + stamps. */
    applyLook(look: CityLook = {}): void {
        this._setLookData(look);
        this._syncCloudParam();
        this._scenePreset = null;   // a raw look / style pack is not a scene preset (applyScenePreset re-sets it)
        this.scene3d.setToonShadows3D({ ...DEFAULT_TOON_SHADOWS, ...(look.toonShadows ?? {}) });
        const cs = look.cityStyle;
        this.setStyle({ renderStyle: cs?.renderStyle ?? null, toonShadow: cs?.toonShadow ?? null, rimLight: cs?.rimLight ?? null });
        // (_setLookData copied look.outlines). visual-polish #8 fix: the E2 edgeWear line had been inserted BETWEEN this
        // if and its else, so a look WITH outlines (persona5, Graphic) enabled the ink and then disabled it at once.
        if (this._outlinesCfg) { this._enableCityOutlines(this._outlinesCfg); this._lookOutlines = true; }
        else if (this._lookOutlines) { this.scene3d.disableOutlines(); this._lookOutlines = false; }
        if (look.edgeWear !== undefined) this.setEdgeWear(look.edgeWear);   // E2: geometry — only when the look names it (never reset by a preset)
        { const vp = this._varietyPatch(look); if (Object.keys(vp).length) this.updateCity(vp); }   // visual-polish #11: geometry, only when named
        this.setSSAO(!!look.ssao, true);
        if (this._cityMode) this.scene3d.setShadowSoftness(this._shadowSoft);
        this._lastSkyBucket = '';
        this._lastLampBucket = -1;   // lamp colour may have changed → resend the candidates
        if (!this._skyLighting) this._clearSkyLighting();
        if (!this._reflections) this._applyWetReflections(0, false);
        this._lastGlowNight = -1;    // the surface look (ground finish / paving / mute / clouds) re-dresses every mesh
        if (this._timeOfDay != null) this._applyTimeOfDay();
        this._redressIfIdle();
        this._stampWorldParams();
    }
    /** The DATA half of applyLook: every look field (absent → the engine / legacy default). No scene writes. */
    private _setLookData(look: CityLook): void {
        this._gradeKeys = JSON.parse(JSON.stringify(DEFAULT_TIME_GRADE)) as Record<TimeGradePhase, TimeGradeKey>;
        for (const k of Object.keys(look.grade ?? {}) as TimeGradePhase[]) Object.assign(this._gradeKeys[k], JSON.parse(JSON.stringify(look.grade![k])));
        this._skyKeys = JSON.parse(JSON.stringify(DEFAULT_SKY)) as Record<TimeGradePhase, SkyKey>;
        for (const k of Object.keys(look.sky ?? {}) as TimeGradePhase[]) {
            const v = look.sky![k]; if (!v) continue;
            if (v.top) this._skyKeys[k].top = [v.top[0], v.top[1], v.top[2]];
            if (v.bottom) this._skyKeys[k].bottom = [v.bottom[0], v.bottom[1], v.bottom[2]];
        }
        this._shadowTints = JSON.parse(JSON.stringify(SHADOW_TINTS));
        for (const k of Object.keys(look.shadowTints ?? {}) as TimeGradePhase[]) { const v = look.shadowTints![k]; if (v) this._shadowTints[k] = [v[0], v[1], v[2]]; }
        this._lampColor = look.lampColor ? [look.lampColor[0], look.lampColor[1], look.lampColor[2]] : [1.0, 0.85, 0.55];
        this._outlinesCfg = WorldManager._copyOutlines(look.outlines);
        this._skyLighting = !!look.skyLighting;
        this._reflections = !!look.reflections;
        this._heightFog = Math.max(0, look.heightFog ?? 0);
        this._groundFinish = look.groundFinish === 'clean' ? 'clean' : 'weathered';
        this._paving = look.paving === 'tiles' ? 'tiles' : 'slabs';
        this._buildingMute = Math.max(0, Math.min(1, look.buildingMute ?? 0));
        this._paintedClouds = !!look.paintedClouds;
        this._shadowSoft = typeof look.shadowSoftness === 'number' && isFinite(look.shadowSoftness) ? Math.max(0.5, Math.min(4, look.shadowSoftness)) : 1.3;
        this._sunWarmth = Math.max(0, Math.min(1, look.sunWarmth ?? 0));
        this._keyFill = Math.max(0, Math.min(1, look.keyFill ?? 0));
        this._aerialHazeAmt = Math.max(0, Math.min(1, look.aerialHaze ?? 0));
        this._coolFill = Math.max(0, Math.min(1, look.coolFill ?? 0));
        this._windowGlow = WorldManager._cleanWindowGlow(look.windowGlow);
        this._skyDome = cleanSkyDome(look.skyDome);   // visual-polish #9 (absent / null = the legacy flat sky)
        this._nightSpill = WorldManager._cleanRange(look.nightSpill, 1.5);   // visual-polish #5 / #7c (absent = off)
        this._wetSheen = WorldManager._cleanRange(look.wetSheen, 1);
        this._playerLight = WorldManager._cleanRange(look.playerLight, 2);
    }
    /** Outside the lit city path (_applyTimeOfDay returns early) fresh surface-look values still re-dress the meshes. */
    private _redressIfIdle(): void {
        if (!(this._timeOfDay != null && this._cityMode && this._overrideGlobalLighting)) this._redressGlow();
    }

    // ── SCENE PRESETS (polish-round-3 T1.1): TIME OF DAY × WEATHER on ONE clean PBR look ──────────────────────
    private _scenePreset: string | null = null;
    /** Apply a scene preset (`CITY_SCENE_PRESETS` in src/world/scene-presets.ts): time of day + weather + cloud cover +
     *  the clean PBR look. Never regenerates the layout (weather / clouds are selective params — they respawn the movers
     *  and re-dress the lights) and never moves the render style off PBR. Persisted with the city. Returns false for an
     *  unknown name. The old style packs stay on {@link applyStyle}. */
    applyScenePreset(name: string, opts?: { graphic?: boolean }): boolean {
        const pr = cityScenePreset(name);
        if (!pr) return false;
        // visual-polish #8: the GRAPHIC modifier layers the toon look (cel-hd + toon shadows + rim + depth-faded ink) on
        // this preset. graphic: false on the 'graphic' preset itself = its plain base (Golden Hour).
        const look = opts?.graphic === true ? withGraphicLook(pr.look) : opts?.graphic === false && pr.name === 'graphic' ? cityScenePreset('golden')!.look : pr.look;
        // visual-polish #1a: every scene preset is a Tokyo look → no cyber void grid / border wall (selective regen of just
        // those two groups, and only when they are on). Loading a saved city never runs this, so it keeps its own value.
        const borders: Partial<LayoutParams> = this._params && (this._params.voidGrid || this._params.borderGlow) ? { voidGrid: false, borderGlow: false } : {};
        // (+ visual-polish #11: the district palette / roof variety ride in the same selective regen, so applyLook below finds them set)
        if (this._graph && this._params) this.updateCity({ weather: pr.weather, cloudDensity: pr.cloudDensity, clouds: true, fog: true, paintedClouds: !!look.paintedClouds, domeClouds: !!look.skyDome && look.skyDome.clouds !== 'cards', ...borders, ...this._varietyPatch(look) });
        this.applyLook(look);
        this._scenePreset = pr.name;
        this.setTimeOfDay(pr.timeOfDay);   // re-lights + stamps (incl. the preset name)
        return true;
    }
    /** visual-polish #8: is the GRAPHIC look on (the cel-hd style + depth-faded ink it composes)? Derived from the
     *  persisted look fields, so it survives a reload. */
    get graphicLook(): boolean { return this._style?.renderStyle === 'cel-hd' && !!this._outlinesCfg?.depthFade; }
    /** visual-polish #8: toggle the GRAPHIC look over the current scene preset (Golden Hour when none is active). */
    setGraphicLook(on: boolean): boolean {
        const base = this._scenePreset && this._scenePreset !== 'graphic' ? this._scenePreset : 'golden';
        return this.applyScenePreset(base, { graphic: !!on });
    }
    /** The active scene preset's name, or null (a style pack / hand-tuned look). Persisted. */
    get scenePreset(): string | null { return this._scenePreset; }
    /** Scene preset names, in panel order. */
    get scenePresetNames(): string[] { return [...CITY_SCENE_PRESET_NAMES]; }
    /** Scene presets with display labels + their time / weather (for the panel's preset buttons). */
    get scenePresets(): { name: string; label: string; timeOfDay: number; weather: string }[] {
        return CITY_SCENE_PRESETS.map((p) => ({ name: p.name, label: p.label, timeOfDay: p.timeOfDay, weather: p.weather }));
    }

    // ── CLEAN SURFACE LOOK (T1.2 / T1.4): live material edits in the glow walk — no regeneration ──
    private _groundFinish: 'weathered' | 'clean' = 'weathered';
    private _paving: 'slabs' | 'tiles' = 'slabs';
    private _buildingMute = 0;
    private _paintedClouds = false;
    private _shadowSoft = 1.3;
    private _sunWarmth = 0;
    /** Road / pavement finish: 'clean' = crack-free asphalt, no grime / wear, quiet slabs; 'weathered' = the worn look. */
    setGroundFinish(f: 'weathered' | 'clean'): void { this._groundFinish = f === 'clean' ? 'clean' : 'weathered'; this._surfaceLookChanged(); }
    get groundFinish(): 'weathered' | 'clean' { return this._groundFinish; }
    /** Pavement surface: 'tiles' = large pale ~50 cm tiles with thin joints; 'slabs' = palette-tinted 1.2 m concrete. */
    setPaving(p: 'slabs' | 'tiles'): void { this._paving = p === 'tiles' ? 'tiles' : 'slabs'; this._surfaceLookChanged(); }
    get paving(): 'slabs' | 'tiles' { return this._paving; }
    /** 0..1 — desaturate building walls / trim / roofs toward warm grey (signs stay saturated). */
    setBuildingMute(v: number): void { this._buildingMute = Math.max(0, Math.min(1, v || 0)); this._surfaceLookChanged(); }
    get buildingMute(): number { return this._buildingMute; }
    /** Painted horizon cloud banks + sun-tinted drifting clouds. */
    setPaintedClouds(on: boolean): void { this._paintedClouds = !!on; this._syncCloudParam(); this._surfaceLookChanged(); }
    /** E1: the drifting clear-weather clouds follow the look (big painted cards vs the legacy puffs) — a selective
     *  movers-only respawn, and only when it actually changes. */
    private _syncCloudParam(): void {
        if (!this._graph || !this._params) return;
        // #9: with the sky dome's anime clouds the drifting painted cards are not spawned at all (LayoutParams.domeClouds)
        const patch: Partial<LayoutParams> = {};
        if ((this._params.paintedClouds ?? false) !== this._paintedClouds) patch.paintedClouds = this._paintedClouds;
        if ((this._params.domeClouds ?? false) !== this._domeCloudsWanted()) patch.domeClouds = this._domeCloudsWanted();
        if (Object.keys(patch).length) this.updateCity(patch);
    }
    get paintedClouds(): boolean { return this._paintedClouds; }

    // ── SKY DOME (visual-polish #9): the stylised view-direction sky backdrop (CityLook.skyDome; null = the legacy flat
    //    screen gradient + blob stars / moon + soft cloud cards). Persisted in the City marker (absent = legacy). ──
    private _skyDome: CitySkyDome | null = null;
    /** Debug A/B switch (GPU cost drives): true draws the legacy gradient while the look keeps its dome. */
    _skyDomeDebugOff = false;
    private _skyDomeOn(): boolean { return !!this._skyDome && !this._skyDomeDebugOff; }
    /** The dome paints the clouds (anime style) — the cloud cards are hidden / not spawned. */
    private _domeCloudsWanted(): boolean { return !!this._skyDome && this._skyDome.clouds !== 'cards'; }
    /** ...and the city's movers agree (LayoutParams.domeClouds — synced by applyLook / setSkyDome / a scene preset; a
     *  freshly generated city keeps its built clouds until then, so the sky never shows two cloud sets at once). */
    private _domeCloudsLive(): boolean { return this._domeCloudsWanted() && this._params?.domeClouds === true; }
    /** The look's sky-dome settings (a copy; null = off). */
    get skyDome(): CitySkyDome | null { return this._skyDome ? JSON.parse(JSON.stringify(this._skyDome)) as CitySkyDome : null; }
    /** Turn the sky dome on with `patch` merged over the current settings (`{}` = on with the defaults), or off (null =
     *  the legacy flat gradient). Fields: stars / moon / cityGlow 0..1, cityGlowColor, moonAzimuthDeg / moonElevationDeg,
     *  clouds 'anime' | 'cards'. Live (no rebuild; a cloud-style change respawns only the movers). Persisted. */
    setSkyDome(patch: CitySkyDome | null): void {
        this._skyDome = patch === null ? null : cleanSkyDome({ ...(this._skyDome ?? {}), ...patch });
        this._scenePreset = null;
        this._syncCloudParam();
        this._lastGlowNight = -1;   // stars / moon / cloud cards flip visibility
        if (this._timeOfDay != null) this._applyTimeOfDay(); else this._redressIfIdle();
        this.scene3d.requestRender3D();
        this._stampWorldParams();
    }
    /** E2 EDGE WEAR (Look control): 'off' | 'subtle' | 'heavy' — chipped + worn arrises on stairs, kerbs and wall
     *  copings, drawn for NEAR chunks only (a clean far twin elsewhere; distance LOD off / ortho = clean). Geometry, so a
     *  change selectively rebuilds 'World Layout' + 'World Terraces'. Persisted with the city params (LayoutParams.edgeWear). */
    setEdgeWear(level: 'off' | 'subtle' | 'heavy'): void {
        const v = level === 'subtle' || level === 'heavy' ? level : 'off';
        if (!this._params) return;
        if ((this._params.edgeWear ?? 'off') === v) return;
        this.updateCity({ edgeWear: v });
        this._stampWorldParams();
    }
    get edgeWear(): 'off' | 'subtle' | 'heavy' { return this._params?.edgeWear ?? 'off'; }
    /** visual-polish #11: the look's district-palette / roof-variety fields that DIFFER from the city's params (empty when
     *  the look names neither, or both already match). */
    private _varietyPatch(look: CityLook): Partial<LayoutParams> {
        const out: Partial<LayoutParams> = {};
        if (!this._params) return out;
        if (look.districtPalette !== undefined && !!this._params.districtPalette !== !!look.districtPalette) out.districtPalette = !!look.districtPalette;
        if (look.roofVariety !== undefined && !!this._params.roofVariety !== !!look.roofVariety) out.roofVariety = !!look.roofVariety;
        if (look.roofEquipment !== undefined) {
            const v = look.roofEquipment === 'clustered' ? 'clustered' : 'classic';
            if ((this._params.roofEquipment ?? 'classic') !== v) out.roofEquipment = v;
        }
        return out;
    }
    /** visual-polish #11 DISTRICT PALETTE (Look control): facades span a real value range (white tile … dark brick,
     *  charcoal cladding) in a hue family per neighbourhood. Geometry: rebuilds 'World Streets'. Persisted with the params. */
    setDistrictPalette(on: boolean): void { if (this._params && !!this._params.districtPalette !== !!on) { this.updateCity({ districtPalette: !!on }); this._stampWorldParams(); } }
    get districtPalette(): boolean { return !!this._params?.districtPalette; }
    /** visual-polish #11 ROOF VARIETY (Look control): per-lot roof finishes + turf roof gardens. Rebuilds 'World Streets'. */
    setRoofVariety(on: boolean): void { if (this._params && !!this._params.roofVariety !== !!on) { this.updateCity({ roofVariety: !!on }); this._stampWorldParams(); } }
    get roofVariety(): boolean { return !!this._params?.roofVariety; }
    /** visual-polish #11 tail ROOF EQUIPMENT (Look control): 'clustered' = one back-edge plant cluster (stair box, a
     *  coloured tank, an AC bank) + a few district extras, most of the deck left clear; 'classic' = the scattered plant.
     *  Rebuilds 'World Streets'. Persisted with the params (saved cities without the field restore as 'classic'). */
    setRoofEquipment(style: 'classic' | 'clustered'): void {
        const v = style === 'clustered' ? 'clustered' : 'classic';
        if (this._params && (this._params.roofEquipment ?? 'classic') !== v) { this.updateCity({ roofEquipment: v }); this._stampWorldParams(); }
    }
    get roofEquipment(): 'classic' | 'clustered' { return this._params?.roofEquipment === 'clustered' ? 'clustered' : 'classic'; }
    /** visual-polish #16 TRAFFIC DENSITY (0..3 × the moving cars + buses; new cities 1.3). Respawns the movers. */
    setTrafficDensity(v: number): void {
        const d = Math.max(0, Math.min(3, Number.isFinite(v) ? v : 1));
        if (this._params && (this._params.trafficDensity ?? 1) !== d) { this.updateCity({ trafficDensity: d }); this._stampWorldParams(); }
    }
    get trafficDensity(): number { return this._params?.trafficDensity ?? 1; }
    /** visual-polish #16 CROWD DENSITY (0.1..20 × the static crowd + walkers; new cities 1.4) — the pedestrianDensity param. */
    setCrowdDensity(v: number): void {
        const d = Math.max(0.1, Math.min(20, Number.isFinite(v) ? v : 1));
        if (this._params && this._params.pedestrianDensity !== d) { this.updateCity({ pedestrianDensity: d }); this._stampWorldParams(); }
    }
    get crowdDensity(): number { return this._params?.pedestrianDensity ?? 1; }
    /** The city's shadow penumbra width (1 = tight … ~2.5 soft). Applied while the City Tool is open. */
    setCityShadowSoftness(v: number): void {
        this._shadowSoft = Math.max(0.5, Math.min(4, v || 1.3));
        if (this._cityMode) this.scene3d.setShadowSoftness(this._shadowSoft);
        this._scenePreset = null;
        this._stampWorldParams();
    }
    get cityShadowSoftness(): number { return this._shadowSoft; }

    // ── CASCADED SHADOWS (persona-polish A2) — a quality setting, not part of a look (presets never change it) ──
    private _shadowCascades: 1 | 2 | 3 = 2;
    private _shadowNearM = 24;
    private _preCityCascades: import('../../renderer/3d/shadow-cascades').ShadowCascadeSettings | null = null;
    private static _cleanCascades(v: unknown): 1 | 2 | 3 { const n = typeof v === 'number' && isFinite(v) ? Math.round(v) : 2; return n <= 1 ? 1 : n >= 3 ? 3 : 2; }
    private static _cleanNearM(v: unknown): number { return typeof v === 'number' && isFinite(v) ? Math.max(8, Math.min(120, v)) : 24; }
    /** City shadow quality: `cascades` 1 (the original single city-wide map) / 2 (default: + a crisp near cascade) / 3
     *  (+ a mid cascade); `nearMetres` = half-width of the near box in real metres (8..120, default 24 — the box sits
     *  ahead of the eye, so it covers ~37 m in front). Persisted with the city; applied while the City Tool is open. */
    setShadowCascades(o: { cascades?: number; nearMetres?: number }): void {
        if (o.cascades !== undefined) this._shadowCascades = WorldManager._cleanCascades(o.cascades);
        if (o.nearMetres !== undefined) this._shadowNearM = WorldManager._cleanNearM(o.nearMetres);
        this._applyShadowCascades();
        this._stampWorldParams();
    }
    get shadowCascades(): { cascades: 1 | 2 | 3; nearMetres: number } { return { cascades: this._shadowCascades, nearMetres: this._shadowNearM }; }
    private _applyShadowCascades(): void {
        if (!this._cityMode || !this._graph) return;
        const mpu = cityMetresPerUnit(this._graph.params.radius);
        // P14 shadow quality preset ('high' = 2048 / every 2nd frame, the pre-P14 values): cascade size + refresh, far map size.
        const q = shadowQualitySpec(this._lodCfg.shadow.quality);
        this.scene3d.setShadowCascades3D({ cascades: this._shadowCascades, nearExtent: this._shadowNearM / mpu, mapSize: q.cascadeMapSize, blend: 0.15, updateInterval: q.cascadeInterval });   // 2: movers at 30 Hz; the player's pose refreshes every frame
        if (this.scene3d.shadowsEnabled && this.scene3d.shadowMapSize3D !== q.farMapSize) { this._preCityFarMapSize ??= this.scene3d.shadowMapSize3D; this.scene3d.setShadowMapSize3D(q.farMapSize); }
    }
    private _preCityFarMapSize: number | null = null;   // P14: the host's far map size, handed back on exit
    /** 0..1 golden-hour warmth: a deeper, brighter gold sun near sunrise / sunset over a lower fill. */
    setSunWarmth(v: number): void { this._sunWarmth = Math.max(0, Math.min(1, v || 0)); this._scenePreset = null; if (this._timeOfDay != null) this._applyTimeOfDay(); this._stampWorldParams(); }
    get sunWarmth(): number { return this._sunWarmth; }
    private _keyFill = 0;
    private _aerialHazeAmt = 0;
    /** visual-polish #4: 0..1 cool shade fill at golden hour / dusk (CityLook.coolFill). */
    private _coolFill = 0;
    get coolFill(): number { return this._coolFill; }
    /** visual-polish #8: lit-window glow multiplier (CityLook.windowGlow; 1 = the built glow, persisted only when != 1). */
    private _windowGlow = 1;
    get windowGlow(): number { return this._windowGlow; }
    private static _cleanWindowGlow(v: unknown): number {
        return typeof v === 'number' && isFinite(v) ? Math.max(0.1, Math.min(2, v)) : 1;
    }

    // ── visual-polish #5 / #7c: NIGHT LIGHT SPILL, WET SHEEN, the Play PLAYER LIGHT (CityLook fields; absent = 0 = off,
    //    persisted only when set, so older cities look unchanged). ──
    private _nightSpill = 0;
    private _wetSheen = 0;
    private _playerLight = 0;
    /** 0..1.5 night light spill (CityLook.nightSpill): shop + sign light on the pavement, soft lamp-coloured pools. */
    get nightSpill(): number { return this._nightSpill; }
    /** 0..1 wet sheen (CityLook.wetSheen): glossier rain-slick roads, damp roads on a dry night. */
    get wetSheen(): number { return this._wetSheen; }
    /** 0..1 how wet the streets are for Play's landing dust (2026-10-04): 1 in rain, else the wet sheen; 0 outside a
     *  city. ≥ 0.35 splashes instead of raising dust. */
    get playWetness(): number {
        if (!this._cityMode || !this._params) return 0;
        return this._params.weather === 'rain' ? 1 : Math.max(0, Math.min(1, this._wetSheen));
    }
    /** 0..2 Play player light (CityLook.playerLight), scaled by the night level. */
    get playerLight(): number { return this._playerLight; }
    private static _cleanRange(v: unknown, max: number): number { return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(max, v)) : 0; }
    setNightSpill(v: number): void { this._nightSpill = WorldManager._cleanRange(v, 1.5); this._surfaceLookChanged(); }
    setWetSheen(v: number): void { this._wetSheen = WorldManager._cleanRange(v, 1); this._surfaceLookChanged(); }
    setPlayerLight(v: number): void {
        this._playerLight = WorldManager._cleanRange(v, 2);
        this._scenePreset = null;
        this._applyPlayerLight(this._timeOfDay != null && this._cityMode ? this._nightAt(this._timeOfDay) : 0);
        this._stampWorldParams();
    }
    /** The Play player light for night level `night` (Scene3DManager.setPlayerLight3D; null = off). */
    private _applyPlayerLight(night: number): void {
        const k = this._playerLight * Math.max(0, Math.min(1, (night - 0.2) / 0.5));
        this.scene3d.setPlayerLight3D(k > 0.01 && this._cityMode ? { strength: k, color: [1.0, 0.93, 0.86] } : null);
    }
    /** Wet-road roughness for the glow pass: legacy 0.35 in rain / 1 dry; the wet sheen glosses rain down to 0.08 and
     *  dampens a dry NIGHT road down to 0.4 (by day a dry road stays matte). */
    private _wetRoughness(wet: boolean, night: number): number {
        const s = this._wetSheen;
        if (s <= 0) return wet ? 0.35 : 1;
        if (wet) return 0.35 - 0.27 * s;
        return 1 - 0.6 * s * Math.max(0, Math.min(1, (night - 0.3) / 0.4));
    }
    private static readonly SPILL_GROUP = 'World Light Spill';
    private static readonly POOL_BUILT: { r: number; g: number; b: number; a: number } = { r: 1.0, g: 0.88, b: 0.6, a: 1 };   // streets.ts world:lamp-pool
    /** The light colour of each spill material (its built diffuse, captured before the first dress darkens it). */
    private readonly _spillBase = new WeakMap<object, [number, number, number]>();
    private readonly _poolDressed = new WeakSet<object>();
    private _spillKey: unknown = null;
    /** Build / drop the spill group for the current look + city (main thread, from the lot meta: a few hundred quads).
     *  Rebuilt when the streets group is replaced (a regen). True when it (re)built a group. */
    private _syncLightSpill(night: number): boolean {
        const want = this._nightSpill > 0 && !!this._graph;
        const has = this._groups.some(g => g.name === WorldManager.SPILL_GROUP);
        if (!want) { if (has) this._removeGroupsByName([WorldManager.SPILL_GROUP]); this._spillKey = null; return false; }
        const streets = this._groups.find(g => g.name === 'World Streets') ?? null;
        if (has && this._spillKey === streets) return false;
        // Built lazily the first time the night comes (a city only seen by day never pays for it); kept (hidden) after.
        if (night <= 0.12) { if (has) { this._removeGroupsByName([WorldManager.SPILL_GROUP]); this._spillKey = null; } return false; }
        if (has) this._removeGroupsByName([WorldManager.SPILL_GROUP]);
        this._spillKey = streets;
        try {
            const layers = buildLightSpill(this._graph!);
            if (!layers.length) return false;
            this._add(WorldManager.SPILL_GROUP, layers);
        } catch { return false; }   // a night nicety must never break the city
        return true;
    }
    /** Dress a spill / lamp-pool mesh as soft coloured light. False = not handled (a pool with the spill off: the
     *  legacy glow row dresses it, after the built colour is put back). */
    private _dressNightLight(m: Mesh3D, isPool: boolean, night: number): boolean {
        const mat = m.material!;
        if (isPool && this._nightSpill <= 0) {
            if (this._poolDressed.has(mat)) { mat.diffuse = { ...WorldManager.POOL_BUILT }; this._poolDressed.delete(mat); }
            return false;
        }
        let base: [number, number, number];
        if (isPool) {
            // the lamp colour a little more saturated: the night grade's blue split-tone greys a pale warm pool out
            const sat = (v: number): number => Math.max(0, 1 - (1 - v) * 1.35);
            base = [sat(this._lampColor[0]), sat(this._lampColor[1]), sat(this._lampColor[2])];
            this._poolDressed.add(mat);
        }
        else {
            let b = this._spillBase.get(mat);
            if (!b) { b = [mat.diffuse.r, mat.diffuse.g, mat.diffuse.b]; this._spillBase.set(mat, b); }
            base = b;
        }
        const mx = Math.max(base[0], base[1], base[2], 1e-3);
        // Emission stays BELOW 1 per channel (the old pool's 1.9x clipped to white = the grey-white disc); the diffuse is
        // nearly black so the moon fill / lamp point light cannot wash the colour out either.
        const k = Math.max(0, Math.min(1, (night - 0.12) / 0.45)) * Math.min(1.5, this._nightSpill) * 0.95 / mx;
        const e = (i: number): number => Math.min(0.98, base[i] * k);
        mat.diffuse = { r: base[0] * 0.05, g: base[1] * 0.05, b: base[2] * 0.05, a: mat.diffuse.a };
        mat.emissive = { r: e(0), g: e(1), b: e(2), a: 1 };
        return true;
    }
    /** 0..1 KEY/FILL contrast (persona-polish A4): by day a warmer, stronger sun over a cooler, lower, less blue fill. */
    setKeyFill(v: number): void { this._keyFill = Math.max(0, Math.min(1, v || 0)); this._scenePreset = null; this._lastSkyBucket = ''; if (this._timeOfDay != null) this._applyTimeOfDay(); this._stampWorldParams(); }
    get keyFill(): number { return this._keyFill; }
    /** 0..1 AERIAL PERSPECTIVE (persona-polish A5): street-scale distance haze (contrast fade + horizon tint). Needs Fog. */
    setAerialHaze(v: number): void { this._aerialHazeAmt = Math.max(0, Math.min(1, v || 0)); this._scenePreset = null; if (this._timeOfDay != null) this._applyTimeOfDay(); this._stampWorldParams(); }
    get aerialHaze(): number { return this._aerialHazeAmt; }
    private _surfaceLookChanged(): void {
        this._scenePreset = null;
        this._lastGlowNight = -1;
        this._redressGlow();
        this.scene3d.requestRender3D();
        this._stampWorldParams();
    }

    /** Light the city from its own sky (image-based lighting, baked per time bucket). */
    setSkyLighting(on: boolean): void { this._skyLighting = on; this._lastSkyBucket = ''; if (!on) this._clearSkyLighting(); if (this._timeOfDay != null) this._applyTimeOfDay(); this._stampWorldParams(); }
    get skyLighting(): boolean { return this._skyLighting; }
    /** Screen-space reflections on wet / night streets and water. */
    setWetReflections(on: boolean): void { this._reflections = on; if (!on) this._applyWetReflections(0, false); if (this._timeOfDay != null) this._applyTimeOfDay(); this._stampWorldParams(); }
    get wetReflections(): boolean { return this._reflections; }
    /** P9: ground-hugging HEIGHT FOG strength (0 = off). Street canyons + low ground haze, rooftops stay crisp;
     *  thickest at dusk / dawn / night and in rain / snow. Needs the city fog on. */
    setHeightFog(strength: number): void { this._heightFog = Math.max(0, strength || 0); if (this._timeOfDay != null) this._applyTimeOfDay(); this._stampWorldParams(); }
    get heightFog(): number { return this._heightFog; }
    private _heightFog = 0;
    private _applyHeightFog(L: ReturnType<typeof computeDayNight>, weather: string): void {
        if (!this._heightFog || this._params?.fog === false) { this.scene3d.setHeightFog3D(0); return; }
        const s = (this._graph?.radius ?? this._params?.radius ?? 10) / 10;
        const R = this._params?.worldMode === 'tiled' && this._params ? tiledWorldExtent(this._params) : (this._params?.radius ?? 10);
        const w = L.weights;
        const phase = 0.35 * w.noon + 0.85 * (w.dawn + w.dusk) + 0.7 * w.night;
        const wx = weather === 'rain' ? 1.35 : weather === 'snow' ? 1.25 : 1;
        const baseY = this._cityTransform.y + (this._params?.groundY ?? 0);
        // density · exp(-(y - base) / (0.35·s)) · (1 - exp(-dist / (0.6·R)))
        this.scene3d.setHeightFog3D(Math.min(1, this._heightFog * phase * wx), baseY, 1 / (0.35 * s), 1 / (0.6 * R));
    }
    /** A5 AERIAL PERSPECTIVE: the look's amount → the renderer's aerial haze, sized in real metres (~63 % built up at
     *  ~320 m, weather closes it in), strongest at dawn / dusk. Rides the Fog toggle like the street haze. */
    private _applyAerialHaze(L: ReturnType<typeof computeDayNight>, weather: string): void {
        if (!this._aerialHazeAmt || this._params?.fog === false) { this.scene3d.setAerialHaze3D(0); return; }
        const mpu = cityMetresPerUnit(this._graph?.params.radius ?? this._params?.radius ?? 10);
        const w = L.weights;
        const phase = 0.8 * w.noon + 1.0 * (w.dawn + w.dusk) + 0.55 * w.night;   // night: the dark already hides depth
        const wx = weather === 'rain' ? 1.3 : weather === 'snow' ? 1.25 : weather === 'overcast' ? 1.15 : 1;
        const reachM = weather === 'rain' || weather === 'snow' ? 220 : 320;
        this.scene3d.setAerialHaze3D(Math.min(0.85, 0.7 * this._aerialHazeAmt * phase * wx), reachM / mpu, 0.55, 0.55);
    }
    /** Screen-space ambient occlusion sized to the city (contact shadows in street canyons). */
    setSSAO(on: boolean, fromLook = false): void {
        if (on) {
            const s = (this._params?.radius ?? 10) / 10 / (this._cityWorldScale() || 1);
            this.scene3d.setSSAO3D(true, { radius: 0.07 * s, intensity: 1.0 });
            if (fromLook) this._lookSSAO = true;
            this._ssaoOn = true;
        } else if (!fromLook || this._lookSSAO) {
            this.scene3d.setSSAO3D(false);
            this._lookSSAO = false;
            this._ssaoOn = false;
        }
        if (!fromLook) this._stampWorldParams();
    }
    /** Is the city's SSAO on (for a panel toggle)? */
    get ssao(): boolean { return this._ssaoOn; }
    /** The city's screen-space INK OUTLINES (null = off). Persisted with the city; re-applied on city enter. */
    setCityOutlines(cfg: CityOutlines | null): void {
        this._outlinesCfg = WorldManager._copyOutlines(cfg);
        if (this._outlinesCfg) { this._enableCityOutlines(this._outlinesCfg); this._lookOutlines = true; }
        else { this.scene3d.disableOutlines(); this._lookOutlines = false; }
        this._stampWorldParams();
    }
    get cityOutlines(): CityOutlines | null { return WorldManager._copyOutlines(this._outlinesCfg); }
    /** A validated copy of an outline config (null for none / malformed); keeps `depthFade` only when present (old saves
     *  round-trip byte-identical). */
    private static _copyOutlines(o: CityOutlines | null | undefined): CityOutlines | null {
        if (!o || !Array.isArray(o.color) || o.color.length !== 4 || typeof o.threshold !== 'number') return null;
        const out: CityOutlines = { color: [o.color[0], o.color[1], o.color[2], o.color[3]], threshold: o.threshold };
        const df = o.depthFade;
        if (df && Number.isFinite(df.near) && Number.isFinite(df.far) && df.far > df.near) out.depthFade = { near: df.near, far: df.far, ...(df.minAlpha !== undefined ? { minAlpha: df.minAlpha } : {}) };
        // visual-polish #3 (both kept only when present / non-default, so older saves round-trip byte-identical)
        if (o.foliage === 'silhouette' || o.foliage === 'off') out.foliage = o.foliage;
        const cf = o.creaseFade;
        if (cf && Number.isFinite(cf.near) && Number.isFinite(cf.far) && cf.far > cf.near) out.creaseFade = { near: cf.near, far: cf.far, ...(cf.minAlpha !== undefined ? { minAlpha: cf.minAlpha } : {}),
            ...(typeof cf.thinPx === 'number' && Number.isFinite(cf.thinPx) && cf.thinPx >= 2 ? { thinPx: cf.thinPx } : {}) };   // visual-polish #3b (absent = off)
        return out;
    }
    /** Turn the screen-space ink on with `o` — the depth fade converted from metres to this city's world units. */
    private _enableCityOutlines(o: CityOutlines): void {
        const df = o.depthFade, mpu = cityMetresPerUnit(this._params?.radius ?? 10);
        const cf = o.creaseFade;   // visual-polish #3: foliage mode + crease fade (metres -> world units)
        this.scene3d.enableOutlines(o.color, o.threshold, df ? { near: df.near / mpu, far: df.far / mpu, minAlpha: df.minAlpha ?? 0.25 } : null,
            { foliage: o.foliage ?? 'full', creaseFade: cf ? { near: cf.near / mpu, far: cf.far / mpu, minAlpha: cf.minAlpha ?? 0, ...(cf.thinPx ? { thinPx: cf.thinPx } : {}) } : null });
    }
    /** Street-lamp light colour. */
    setLampColor(c: [number, number, number]): void { this._lampColor = [c[0], c[1], c[2]]; this._lastLampBucket = -1; if (this._nightSpill > 0) this._lastGlowNight = -1; if (this._timeOfDay != null) this._applyTimeOfDay(); this._stampWorldParams(); }
    get lampColor(): [number, number, number] { return [...this._lampColor] as [number, number, number]; }
    /** Coloured-shadow hue per phase (partial merge). */
    setShadowTints(t: Partial<Record<TimeGradePhase, [number, number, number]>>): void {
        for (const k of Object.keys(t) as TimeGradePhase[]) { const v = t[k]; if (v) this._shadowTints[k] = [v[0], v[1], v[2]]; }
        if (this._timeOfDay != null) this._applyTimeOfDay();
        this._stampWorldParams();
    }
    get shadowTints(): Record<TimeGradePhase, [number, number, number]> { return JSON.parse(JSON.stringify(this._shadowTints)); }

    /** City units → world units scale of the container (1 = unscaled). */
    private _cityWorldScale(): number { return (this._cityTransform as { s?: number }).s ?? 1; }

    /** P4: bake the city's time-of-day sky into image-based lighting — bucketed (the bake is a CPU equirect + a cube). */
    private _applySkyLighting(L: ReturnType<typeof computeDayNight>): void {
        if (!this._skyLighting) return;
        const w = L.weights, q = (v: number) => Math.round(v * 10);
        const key = `${q(w.night)}|${q(w.dawn)}|${q(w.dusk)}|${q(L.ambientIntensity)}|${this._params?.weather ?? 'clear'}|${q(this._keyFill)}|${q(this._coolFill)}`;
        if (key === this._lastSkyBucket) return;
        this._lastSkyBucket = key;
        // visual-polish #4 COOL FILL: at golden hour the baked fill's horizon + ground bounce lean blue-violet (the visible
        // sky keeps its orange horizon), so the shade side of a sunlit facade reads cool instead of tan.
        const ck = 0.6 * this._coolFill * w.dusk, sb = L.sky.bottom, cool: [number, number, number] = [0.46, 0.52, 0.78];
        const hz: [number, number, number] = ck > 0 ? [sb[0] + (cool[0] - sb[0]) * ck, sb[1] + (cool[1] - sb[1]) * ck, sb[2] + (cool[2] - sb[2]) * ck] : sb;
        const sky: ProceduralSkyParams = {
            ...DEFAULT_PROC_SKY,
            // A4 key/fill: the FILL is baked from a partly desaturated zenith by day (the visible sky keeps its blue) —
            // the sky-blue ambient was the "blue cast" on every shaded face.
            model: 'gradient', zenith: this._fillZenith(L), horizon: [...hz] as [number, number, number],
            ground: [hz[0] * 0.5, hz[1] * 0.5, hz[2] * 0.52], sunColor: [...L.sunColor] as [number, number, number],   // 0.5: bounce off a lit city (0.3 left cloud undersides / eaves murky)
            sunHalo: 0.25 + 0.4 * L.dusk, intensity: 1,
        };
        // ★ NORMALISE the bake to the tuned flat ambient (the sky-lighting white-out fix, polish-round-3 Round 4): SH
        // irradiance is PI x the sky radiance and the PBR shader applies it with no 1/PI, so the old fixed intensity
        // (ambientIntensity x 1.1) lit pale pavements ~3x brighter than the flat ambient and bloom clipped them white.
        // Matched here, the sky re-shapes the fill (sky-tinted, brighter tops / dimmer walls) at the SAME energy.
        const amb: [number, number, number] = [L.ambientColor[0] * L.ambientIntensity, L.ambientColor[1] * L.ambientIntensity, L.ambientColor[2] * L.ambientIntensity];
        // gain: by day the sky may light ~1.45x the flat fill (the airy sky-lit look), night stays at the flat energy
        // (lamps + neon carry it); maxUp caps the up-facing fill so pale 50 cm tile pavements + sun stay under white.
        this.scene3d.setSky3D(sky, ambientMatchedSkyIntensity(sky, [-L.sunDir[0], -L.sunDir[1], -L.sunDir[2]], amb, { gain: 1 + 0.45 * L.day, maxUp: 0.75 }));
    }
    private _fillZenith(L: ReturnType<typeof computeDayNight>): [number, number, number] {
        const t = L.sky.top, k = 0.6 * this._keyFill * L.day;
        if (k <= 0) return [t[0], t[1], t[2]];
        const g = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
        return [t[0] + (g - t[0]) * k, t[1] + (g - t[1]) * k, t[2] + (g - t[2]) * k];
    }
    private _clearSkyLighting(): void { if (this._lastSkyBucket !== '') { this._lastSkyBucket = ''; } this.scene3d.clearEnvironmentMap3D(); }

    /** P5: SSR on when the look wants reflections AND the street is wet or it's night; off otherwise (only undoes
     *  what the city turned on). */
    private _applyWetReflections(night: number, wet: boolean): void {
        const want = this._reflections && (wet || night > 0.5);
        if (want === this._ssrByCity) return;
        this._ssrByCity = want;
        this.scene3d.setSSR3D({ ssr: want });
    }

    /** Per-layer light dressing: the city's own lights come ON as darkness rises, the flat-map base emissive dims
     *  (so the lights POP against a dark city), and building windows light up. Matched by layer name. */
    public _lastGlowNight = -1;
    private _lastGlowWeather = '';
    // Candidate street-lamp point-light gate (see _applyTimeOfDay): -1 forces a rebuild; _lampGraph pins the city
    // the current candidate set was built for (a regen swaps the graph → rebuild). Reset these when clearing lamps.
    private _lastLampBucket = -1;
    private _lampGraph: WorldGraph | null = null;
    /** Re-dress freshly built meshes: the full time-of-day pass when city lighting drives the scene, else the
     *  BASELINE glow (day factors) — so a city never keeps the old flat 45 % build emissive (city-quality L1). */
    private _redressGlow(): void {
        this._applyGroundContact();   // A3: fresh blob meshes follow the contact-shadow toggle / strength
        if (this._timeOfDay != null && this._cityMode && this._overrideGlobalLighting) { this._applyTimeOfDay(); return; }
        this._lastGlowNight = -1;
        this._applyGlow(this._timeOfDay != null && this._cityMode ? this._nightAt(this._timeOfDay) : 0);
    }
    /** Night level 0..1 at time-of-day t (the same curve as computeDayNight). */
    private _nightAt(t: number): number { return computeDayNight(t, { weather: this._params?.weather ?? 'clear' }).night; }

    // ── GLOW pass (performance-plan P5.W3) ─────────────────────────────────────────────────────────────────────────
    // [layer-name match, day factor, night factor] — the first matching row wins (the last is the catch-all).
    private static readonly GLOW: ReadonlyArray<readonly [RegExp, number, number]> = [
        [/sky-stars|sky-moon/, 0.0, 1.5],        // celestial: invisible-dark by day (also visibility-gated below)
        [/headlight|taillight|lamp-pool/, 0.25, 1.9],   // the moving/pooled night lights
        [/train-lit|train-sign/, 0.15, 0.95],     // EMU (train.ts): the lit cabin behind an open doorway + the destination sign
        // ★ city-quality L4: detailed buildings name their signs/screens 'world:detail-sign' / 'detail-screen…'
        //   (no trailing hyphen) — they fell through to the dim catch-all and went DARK at night.
        [/detail-sign-ink/, 0.05, 0.03],       // sign LETTERING ink is dark paint, not a light (B7)
        // ADVERTS (docs/ui/garp.md §Adverts): white-based image faces (emissive × texture). Lit = backlit
        // lightbox (full image brightness at night, never blown out); unlit = a poster lit by the scene.
        [/sign-advert-lit/, 0.3, 1.0],
        [/sign-advert/, 0.05, 0.03],
        [/shop-room/, 0.3, 1.0],               // C4: the lit room behind an image-interior shop bay (a fluorescent shop)
        [/sign-|screen-|detail-sign|detail-screen|neon|lantern|vending-|busstop-sign|sg-lantern|rail-train-win|lm-accent|lamplights|traffic-holo|traffic-flyer-glow|traffic-skytrain-glow|robot-visor|rail-sky/, 0.6, 1.7],
        [/detail-glass|shop-glass/, 0.1, 0.6],   // was 0.95 — lit shopfronts blew out to white at street level  // shop windows: lit from inside at night
        [/signal-red|signal-yellow|signal-green|local-xing-lamp/, 0.55, 1.5],   // (+ the R3.2 level-crossing lamps: phase-switched diffuse)
        [/canal|pond|fountain-water/, 0.12, 0.06],
        // The CROWD (static + walkers) is shaded FLAT like Persona's background NPCs: its diffuse is pre-dimmed
        // (mannequin PED_SHADE) and this lift evens light vs shadow — soft colour blocks, not lit hero figures.
        // (pedestrianStyle other than 'flat' swaps this for the ordinary baseline — _pedGlow below)
        [/world:ped-|world:traffic-walker/, PED_SHADE.emissive, PED_SHADE.emissiveNight],
        // ★ city-quality L1: was 0.45 / 0.13 — every surface self-lit at 45 % of its own colour, which washed out
        //   every cast shadow and AO term and made night a dimmed day. Now light does the work.
        [/./, 0.05, 0.03],
    ];
    /** Per-NAME classification for the glow + surface-look passes, computed ONCE per distinct mesh name (P5.W3: the
     *  pass used to regex-test every name against ~15 patterns on every re-dress — ~5 k meshes × 15 tests). Names are
     *  build-time constants and repeat heavily (chunked cells share their layer's name), so the cache stays small. */
    private static readonly _traits = new Map<string, GlowTraits>();
    static glowTraits(name: string): GlowTraits {
        let t = WorldManager._traits.get(name);
        if (t) return t;
        if (WorldManager._traits.size > 20000) WorldManager._traits.clear();   // safety valve (names are finite in practice)
        t = {
            skip: /border-glow/.test(name),
            celestial: /sky-stars|sky-moon/.test(name),
            skyClouds: /sky-clouds/.test(name),
            cloud: /sky-clouds|traffic-cloud/.test(name),
            cloudRim: /cloud-rim|clouds-rim/.test(name),
            lampPool: /lamp-pool/.test(name),
            lightSpill: /world:light-spill/.test(name),
            row: WorldManager.GLOW.findIndex(([re]) => re.test(name)),
            crowd: WorldManager.CROWD_RE.test(name),
            roadPaintEnd: /world:roadpaint$/.test(name),
            snowGround: /world:roads|sidewalk|crosswalk|world:roofs|courtyard|world:parking|zone-|parks/.test(name),
            trainWin: /train-win/.test(name),
            wetRoad: /world:roads|sidewalk|crosswalk|roadpaint/.test(name),
            cleanGround: WorldManager.CLEAN_GROUND_RE.test(name),
            mute: WorldManager.MUTE_RE.test(name),
            sidewalks: name === 'world:sidewalks',
            roadsWear: /roads-wear/.test(name),
            kerb: /sidewalks-kerb/.test(name),
        };
        WorldManager._traits.set(name, t);
        return t;
    }

    /** A sliced glow pass in progress (null = none): the per-pass constants + the mesh snapshot + a cursor. */
    private _glowPass: GlowPass | null = null;
    private _glowRaf = 0;
    /** Main-thread budget per frame for a SLICED (incremental day-cycle) glow pass. */
    static GLOW_SLICE_MS = 2;
    /** Diagnostics: the last pass's mode, mesh count, total JS ms and slice count (salsaWorld.manager._glowStats). */
    _glowStats: { mode: 'sync' | 'sliced'; meshes: number; ms: number; slices: number } | null = null;

    private _applyGlow(night: number): void {
        // THROTTLE: the glow walk touches every mesh material — skip when nothing meaningful changed
        // (lightning flashes and per-frame cycle ticks call _applyTimeOfDay far more often than the glow
        // actually needs to move). ~0.004 night ≈ half a minute of a 2-minute day cycle per re-dress.
        const weatherNow = this._params?.weather ?? 'clear';
        if (this._syncLightSpill(night)) this._lastGlowNight = -1;  // visual-polish #5: a fresh spill group needs its first dress
        if (Math.abs(night - this._lastGlowNight) < 0.004 && weatherNow === this._lastGlowWeather) return;
        // A FORCED re-dress (_lastGlowNight reset: fresh meshes, a look / weather change) runs in one shot so nothing is
        // ever shown half-dressed; an incremental day-cycle step (a small night delta, same weather) is SLICED across
        // frames under GLOW_SLICE_MS — a 0.004 night step spread over 2-3 frames is invisible. The GPU half (the
        // materialDirty slot rewrites) is already spread by the renderer's re-dress budget (P4.3).
        const forced = this._lastGlowNight < 0 || weatherNow !== this._lastGlowWeather;
        this._lastGlowNight = night;
        this._lastGlowWeather = weatherNow;
        const meshes: Mesh3D[] = [];
        for (const g of this._groups) for (const child of g.children) meshes.push(child as Mesh3D);
        const pass = this._glowPassFor(night, weatherNow, meshes);
        this._glowPass = pass;   // supersedes any sliced pass still running (this one re-dresses every mesh)
        const sliced = !forced && typeof requestAnimationFrame !== 'undefined';
        if (!sliced) {
            if (this._glowRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._glowRaf);
            this._glowRaf = 0;
            this._glowRun(pass, Infinity);
            return;
        }
        this._glowRun(pass, WorldManager.GLOW_SLICE_MS);
    }

    private _glowPassFor(night: number, weather: string, meshes: Mesh3D[]): GlowPass {
        return {
            night, meshes, i: 0, ms: 0, slices: 0,
            litFrac: 0.62 * Math.max(0, Math.min(1, night * 1.6 - 0.1)),   // windows come on through dusk
            wet: weather === 'rain',     // rain-slick asphalt: low roughness → the city lights smear
            snowy: weather === 'snow',   // frost: ground/roof layers get a white emissive cast (reversible — recomputed each pass)
            clear: weather === 'clear',
            showSky: night > 0.45 && weather === 'clear',   // stars/moon: night only, hidden by an overcast deck
            domeSky: this._skyDomeOn(), domeClouds: this._domeCloudsLive(),
            cloudGlow: this._paintedClouds ? this._paintedCloudGlow() : null,
            cloudRim: this._paintedClouds ? this._paintedCloudRim() : null,
        };
    }
    /** Step 3 refreshReattached: a re-attached LRU tile / restored centre still wore the glow, style and contact-shadow
     *  dressing of when it left (the full re-dress waited for the next day-cycle tick, i.e. never with the clock still).
     *  Dress JUST those groups now with the CURRENT dressing — the city style, then the glow pass at the night level the
     *  rest of the world wears (the same per-mesh code the full pass runs). */
    private _redressGroups(groups: readonly MeshGroup3D[]): void {
        if (WorldManager.STEP3.refreshReattached) this._dressGroups(groups);
    }
    /** Dress `groups` with the CURRENT style + glow + contact-shadow state (the per-mesh code of the full passes). */
    private _dressGroups(groups: readonly MeshGroup3D[]): void {
        if (!groups.length) return;
        if (this._hasStyle()) for (const g of groups) applyObjectStyle(g, this._style);
        const night = this._lastGlowNight;
        if (night < 0) return;   // a forced full re-dress is pending anyway (it covers these groups)
        const meshes: Mesh3D[] = [];
        for (const g of groups) for (const child of g.children) meshes.push(child as Mesh3D);
        const pass = this._glowPassFor(night, this._lastGlowWeather, meshes);
        let shown = false;
        for (const m of meshes) if (this._glowMesh(m, pass)) shown = true;
        // the contact-shadow blobs follow the current toggle / strength (the _applyGroundContact rule, these groups only)
        const vis = this._groundContact && this._groundContactStrength > 0.001, op = Math.max(0.001, Math.min(0.999, this._groundContactStrength));
        for (const m of meshes) {
            if (!m.material || !/world:contact-shadow/.test(m.name ?? '')) continue;
            if (m.visible !== vis) { m.visible = vis; shown = true; }
            if (m.material.opacity !== op) { m.material.opacity = op; m.materialDirty = true; }
        }
        if (shown) this.scene3d.notifyVisibilityChanged3D?.();
        this.scene3d.requestRender3D();
    }

    /** Dress meshes of `pass` from its cursor until done or `budgetMs` is spent; reschedules itself when sliced. */
    private _glowRun(pass: GlowPass, budgetMs: number): void {
        if (this._glowPass !== pass) return;   // superseded
        const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
        const t0 = now();
        const { meshes } = pass;
        let shown = false;
        while (pass.i < meshes.length) {
            const m = meshes[pass.i++];
            if (this._glowMesh(m, pass)) shown = true;
            if (budgetMs !== Infinity && (pass.i & 63) === 0 && now() - t0 >= budgetMs) break;
        }
        pass.ms += now() - t0; pass.slices++;
        if (shown) this.scene3d.notifyVisibilityChanged3D?.();
        if (pass.i < meshes.length) {
            this._glowRaf = requestAnimationFrame(() => { this._glowRaf = 0; this._glowRun(pass, budgetMs); });
            this.scene3d.requestRender3D();
            return;
        }
        this._glowPass = null;
        this._glowStats = { mode: budgetMs === Infinity ? 'sync' : 'sliced', meshes: meshes.length, ms: Math.round(pass.ms * 100) / 100, slices: pass.slices };
        if (budgetMs !== Infinity) this.scene3d.requestRender3D();
    }

    /** Dress ONE mesh for the pass (the old per-mesh loop body). Returns true when the mesh went hidden → shown. */
    private _glowMesh(m: Mesh3D, pass: GlowPass): boolean {
        const mat = m.material;
        if (!mat) return false;
        const name = m.name ?? '';
        const tr = WorldManager.glowTraits(name);
        if (tr.skip) return false;   // the border glow keeps its built emissive (bright always); the edit pulse owns it
        const { night, cloudGlow, cloudRim } = pass;
        const wasVis = m.visible;
        let shown = false;
        if (tr.celestial) m.visible = pass.showSky && !pass.domeSky;   // #9: the dome paints its own stars + moon
        this._applySurfaceLook(m, name, tr);   // T1.2 / T1.4: clean ground, tiled paving, muted buildings (before the emissive — it reads diffuse)
        if (tr.skyClouds) m.visible = !!cloudGlow && pass.clear && !pass.domeClouds;   // #9: anime clouds live in the dome
        if (m.visible && !wasVis) shown = true;
        if (cloudGlow && tr.cloud) {
            // Painted clouds: the shadow side takes the sky colour instead of going grey (the sun lights the rest).
            const cg = cloudRim && tr.cloudRim ? cloudRim : cloudGlow;   // E1: the rim cards take the SUN colour (golden-hour lit edges)
            mat.emissive = { r: cg[0], g: cg[1], b: cg[2], a: 1 };
            m.materialDirty = true;
            return shown;
        }
        // Lamp light-pools are a NIGHT effect: by day the 7.5 m discs read as dark stains at every junction.
        if (tr.lampPool) m.visible = night > 0.12;
        if (tr.lightSpill) m.visible = night > 0.12 && this._nightSpill > 0;
        if (m.visible && !wasVis) shown = true;   // hidden -> shown: the host render list needs a re-filter (notifyVisibilityChanged3D)
        // visual-polish #5: the spill + (with the spill on) the lamp pools are dressed as soft coloured LIGHT.
        if (tr.lightSpill || tr.lampPool) { if (this._dressNightLight(m, tr.lampPool, night)) { m.materialDirty = true; return shown; } }
        const row = WorldManager.GLOW[tr.row];
        let fd = row[1], fn = row[2];
        if (tr.crowd) { this._pedLook(m, name); [fd, fn] = this._pedGlow(name); }   // pedestrianStyle
        // B2: clean-look road paint is matte paint, never a light (no emissive lift for bloom to catch).
        const f = this._groundFinish === 'clean' && tr.roadPaintEnd ? 0 : fd + (fn - fd) * night;
        const d = mat.diffuse;
        if (pass.snowy && tr.snowGround) {
            const k = 0.5;   // frost blend toward white
            mat.emissive = { r: d.r * f * (1 - k) + 0.68 * k, g: d.g * f * (1 - k) + 0.70 * k, b: d.b * f * (1 - k) + 0.74 * k, a: 1 };
        } else {
            mat.emissive = { r: d.r * f, g: d.g * f, b: d.b * f, a: 1 };
        }
        // EMU side glass (train.ts '…-train-win…'): a commuter train is lit end to end after dark, not a hashed fraction.
        if (mat.patternMode === 'windows') {
            mat.patternSpacing = tr.trainWin ? Math.min(1, pass.litFrac * 1.62) : pass.litFrac;
            // visual-polish #8: the look's lit-window glow cap (absent / 1 = unset -> the shader's built glow, bit-identical)
            if (this._windowGlow !== 1) mat.windowGlow = this._windowGlow; else delete mat.windowGlow;
        }
        if (tr.wetRoad) mat.roughness = this._wetRoughness(pass.wet, night);
        // materialDirty (NOT gpuDirty): repack the instance slots without re-uploading the whole
        // city's geometry + rebuilding the texture atlas — the old flag caused multi-second hitches.
        m.materialDirty = true;
        return shown;
    }

    /** Painted-cloud self-light for the current time of day: the horizon colour (+ a little sun) — so the shadow side of
     *  a cloud reads as sky-lit paint (violet / peach at golden hour) instead of flat grey. */
    private _paintedCloudGlow(): [number, number, number] {
        // E1: the shade takes a zenith + horizon mix (the P5 / Ghibli cloud underside is sky-violet / blue-grey, not a
        // paler copy of the horizon behind it — that washed the banks into the haze), plus a little sun.
        const L = computeDayNight(this._timeOfDay ?? 0.5, { weather: this._params?.weather ?? 'clear', sunAzimuth: this._sunAzimuth, skyKeys: this._skyKeys, sunWarmth: this._sunWarmth, keyFill: this._keyFill });
        const k = 0.8, ks = 0.1 * L.sunIntensity, m = (i: number): number => L.sky.top[i] * 0.55 + L.sky.bottom[i] * 0.45;
        return [m(0) * k + L.sunColor[0] * ks, m(1) * k + L.sunColor[1] * ks, m(2) * k + L.sunColor[2] * ks];
    }
    /** E1: the self-light of the painted clouds' RIM cards (their sunlit crowns): the sun colour, strongest when the sun
     *  is low (golden hour / dawn: warm lit edges), a soft pale crown at noon, gone at night (then just the sky tint). */
    private _paintedCloudRim(): [number, number, number] {
        const L = computeDayNight(this._timeOfDay ?? 0.5, { weather: this._params?.weather ?? 'clear', sunAzimuth: this._sunAzimuth, skyKeys: this._skyKeys, sunWarmth: this._sunWarmth, keyFill: this._keyFill });
        const low = 1 - Math.min(1, Math.max(0, -L.sunDir[1]) / 0.9);   // 1 at the horizon → 0 with the sun ~64 deg up
        const ks = L.sunIntensity * (0.6 + 0.35 * low), kb = 0.35;
        // Low sun: push the sun colour toward its own square (1, .77, .56 -> 1, .56, .28) — the saturated gold / apricot
        // edge of a golden-hour cloud, not a pale peach one (the haze desaturates whatever reaches the horizon).
        const sc = (i: number): number => { const c = L.sunColor[i]; return c + (Math.pow(Math.max(0, c), 2.2) - c) * low; };
        const c: [number, number, number] = [L.sky.bottom[0] * kb + sc(0) * ks, L.sky.bottom[1] * kb + sc(1) * ks, L.sky.bottom[2] * kb + sc(2) * ks];
        // The lit colour clamps at 1 in the shader: an over-bright (sunIntensity > 1) gold clipped to cream white. Keep the HUE.
        const mx = Math.max(c[0], c[1], c[2]) / 0.97;
        return mx > 1 ? [c[0] / mx, c[1] / mx, c[2] / mx] : c;
    }

    /** The as-built ground / colour values of a mesh the surface look has touched (restored when the look turns off). */
    private _surfaceOrig = new WeakMap<Mesh3D, { weather?: number; jitter?: number; mode?: number; tile?: [number, number]; grout?: { r: number; g: number; b: number; a: number }; diffuse: { r: number; g: number; b: number; a: number }; shade?: boolean }>();
    /** persona-polish B1-B3 clean-look ground colours: warm mid-grey asphalt, off-white paint, warm pavement tile. */
    private static readonly CLEAN_ASPHALT: [number, number, number] = [0.33, 0.31, 0.28];
    private static readonly CLEAN_PAINT: [number, number, number] = [0.82, 0.79, 0.71];
    private static readonly CLEAN_TILE: [number, number, number] = [0.75, 0.68, 0.57];
    private static readonly CLEAN_GROUND_RE = /world:(roads|sidewalks|courtyard|plaza|gutter|parking|commercial|residential|civic)|sidewalks-kerb/;
    private static readonly MUTE_RE = /world:detail-(wall|wallbase|partywall|parapet|trim|roof|doorframe|windowtrim|railing-steel|storefront)|world:roofs|world:lm-(stone|roof|steps)|world:(residential|commercial|civic)$|world:foundation/;
    /** visual-polish #11: the detailed buildings' roof decks and walls (the mute exemption of the district palette). */
    private static readonly ROOF_DECK_RE = /world:detail-roof(#|$)/;
    /** visual-polish #11 tail: the coloured clustered roof plant (water tanks, solar panels, helipad deck). */
    private static readonly ROOF_PLANT_RE = /world:detail-roof-equip-(tank|solar|pad)/;
    private static readonly WALL_RE = /world:detail-wall(#|$)/;
    /** Apply the clean surface look to ONE mesh (live material edits; idempotent — always derived from the as-built
     *  values, so toggling back restores them exactly). */
    private _applySurfaceLook(m: Mesh3D, name: string, tr: GlowTraits = WorldManager.glowTraits(name)): void {
        const mat = m.material;
        const clean = this._groundFinish === 'clean';
        const tiles = this._paving === 'tiles' && tr.sidewalks;
        const ground = !!mat.groundShade && tr.cleanGround;
        const mute = this._buildingMute > 0 && tr.mute;
        const cloud = this._paintedClouds && tr.cloud;
        // persona-polish B2: road paint is BUILT as a roadPaint ground mesh, but only the clean look shades it — any
        // other finish turns the ground shading off, which is exactly the old flat paint.
        const paint = tr.roadPaintEnd;
        let o = this._surfaceOrig.get(m);
        if (!o) {
            if (!(ground && (clean || tiles)) && !mute && !cloud && !(paint && mat.groundShade)) return;   // untouched and nothing to do
            o = { weather: mat.groundWeather, jitter: mat.groundJitter, mode: mat.groundMode, tile: mat.groundTile ? [mat.groundTile[0], mat.groundTile[1]] : undefined,
                grout: mat.groundGrout ? { ...mat.groundGrout } : undefined, diffuse: { ...mat.diffuse }, shade: mat.groundShade };
            this._surfaceOrig.set(m, o);
        }
        let d = { ...o.diffuse };
        if (paint && o.shade) mat.groundShade = clean;
        if (mat.groundShade) {
            mat.groundWeather = o.weather; mat.groundJitter = o.jitter; mat.groundMode = o.mode;
            mat.groundTile = o.tile ? [o.tile[0], o.tile[1]] : undefined; mat.groundGrout = o.grout ? { ...o.grout } : undefined;
            if (ground && clean) {
                mat.groundWeather = 0;                                   // 'new' — no grime / wear / edge masks
                mat.groundJitter = (o.jitter ?? 1) * 0.3;                // quiet slab-to-slab + aggregate noise
                if (o.mode === 4) {
                    // asphalt: p0 = crack suppression (1 = none), p1 = the B1 street extras (broad drift + repair patches).
                    // persona-polish B1: a lighter WARM grey instead of the near-black navy; the tyre-wear strips
                    // (roadpaint.ts buildRoadWear) take the same grey a shade darker.
                    mat.groundTile = [1, 1];
                    const k = tr.roadsWear ? 0.92 : 1;
                    d = { r: WorldManager.CLEAN_ASPHALT[0] * k, g: WorldManager.CLEAN_ASPHALT[1] * k, b: WorldManager.CLEAN_ASPHALT[2] * k, a: d.a };
                }
                if (tr.kerb) {   // B3: the granite kerb warms with the tiles (it read cold blue beside them)
                    const w = WorldManager.CLEAN_TILE;
                    d = { r: d.r + (w[0] - d.r) * 0.45, g: d.g + (w[1] - d.g) * 0.45, b: d.b + (w[2] - d.b) * 0.45, a: d.a };
                }
            }
            if (paint && clean) {
                // B2: matte OFF-WHITE (a pure white under the blue sky fill read cyan and grazed the bloom threshold),
                // edges + scuffs worn through to the asphalt tone (the roadPaint surface's seam).
                mat.groundTile = [1, 0];
                d = { r: WorldManager.CLEAN_PAINT[0], g: WorldManager.CLEAN_PAINT[1], b: WorldManager.CLEAN_PAINT[2], a: d.a };
                mat.groundGrout = { r: WorldManager.CLEAN_ASPHALT[0], g: WorldManager.CLEAN_ASPHALT[1], b: WorldManager.CLEAN_ASPHALT[2], a: 0 };
            }
            if (tiles) {
                // T1.4 + persona-polish B3: the P5X pavement — ~50 cm WARM square tiles (the paverTiles surface, mode 21):
                // per-tile value steps, 3 mm soft joints only a little darker than the tile (was the concrete tiler with
                // 4 mm hard grey joints on a cold pale tile — high contrast, and blue under the sky fill).
                mat.groundMode = 21;
                mat.groundTile = [0.5, 0.5];
                mat.groundJitter = 0.8;
                const w = WorldManager.CLEAN_TILE;
                d = { r: d.r + (w[0] - d.r) * 0.8, g: d.g + (w[1] - d.g) * 0.8, b: d.b + (w[2] - d.b) * 0.8, a: d.a };
                mat.groundGrout = { r: d.r * 0.8, g: d.g * 0.79, b: d.b * 0.78, a: 0.003 };
            }
        }
        // painted clouds: leave headroom so the sun side tints instead of clipping white. E1 cloud CARDS (radialFade) are
        // painted by their self-light (shade / sunlit-rim colours) — keep the scene light to a quarter so it cannot wash them.
        if (cloud) { const k = mat.radialFade ? 0.25 : 0.78; d = { r: d.r * k, g: d.g * k, b: d.b * (k + 0.02), a: d.a }; }
        if (mute) {
            let k = this._buildingMute;
            // visual-polish #11: the district palette / roof variety ARE the colour design (already low-saturation) — the
            // walls take about half the mute, the roof decks a third (only cities built with them; old saves unchanged)
            if (this._params?.roofVariety && WorldManager.ROOF_DECK_RE.test(name)) k *= 0.35;
            else if (WorldManager.ROOF_PLANT_RE.test(name)) k *= 0.35;   // (only clustered roofs build these layers)
            else if (this._params?.districtPalette && WorldManager.WALL_RE.test(name)) k *= 0.5;
            const lum = 0.2126 * d.r + 0.7152 * d.g + 0.0722 * d.b;
            const grey: [number, number, number] = [lum * 1.03, lum, lum * 0.95];   // a warm grey, same brightness
            d = { r: d.r + (grey[0] - d.r) * k, g: d.g + (grey[1] - d.g) * k, b: d.b + (grey[2] - d.b) * k, a: d.a };
        }
        mat.diffuse = d;
        m.materialDirty = true;
    }

    /** Remove the whole generated world from the scene. */
    clear(): void {
        this.stopDayCycle();
        this._abortAsync();         // drop any staged half-built city
        this._flushHlodFades(); this._stream.clear();       // abort any in-flight tile pump + forget the neighbour-tile cache
        this._tileSig = '';
        this._streamFocus = { x: 0, z: 0, scale: 1 };   // origin diorama focus (follow-off)
        this._lastVisibleSig = '';
        this._lastViewSig = '';
        this._lastCoarseSig = '';
        this._lastFogReach = 0;
        this._worstJobMs = 0;
        this._worstJobName = '';
        this._worstJobTotalMs = 0;
        if (this._compactTimer) { clearTimeout(this._compactTimer); this._compactTimer = null; }
        if (this._reassembleRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._reassembleRaf);
        this._reassembleRaf = 0;
        const drained = new Set<ReassembleCtx>();   // resolve each in-flight tile's Promise ONCE (jobs share a ctx)
        if (this._slice) { drained.add(this._slice.job.ctx); this._slice.job.ctx.resolve([]); this._dropSlice(); }
        for (const job of this._reassembleQueue) if (!drained.has(job.ctx)) { drained.add(job.ctx); job.ctx.resolve([]); }
        this._reassembleQueue.length = 0;
        if (this._promoteTimer) { clearTimeout(this._promoteTimer); this._promoteTimer = null; }   // no ghost rebuilds after a clear
        this._targetParams = null;
        this._lastGlowNight = -1;   // fresh meshes must be re-dressed (the glow throttle would skip them)
        this._glowPass = null;      // P5.W3: drop a sliced glow pass over the meshes being removed
        this._dropCentreParking();       // P10.D: a parked centre belongs to the world being cleared
        this._liveCrowd.resetOnClear();   // live crowd meshes live under the container (removed below)
        this._moverShadows.resetOnClear();   // visual-polish #16: the blob mesh lives under the container too
        this._crowd.reset();              // P12: the instanced crowd's blocks + lazy cells (their meshes go with the groups)
        this._traffic.resetOnClear();   // movers/visits/door state (their groups live in _groups — removed below); `on` persists → respawns on regen
        for (const g of this._groups) this.scene3d.removeFlatColorMeshGroup(g);
        this._groups = [];
        this._tileGroups.clear();
        this._tileRetired.clear();   // retired tiles belong to the world being cleared — never revive across worlds
        this._proxyRetired.clear(); this._hlodRetired.clear();
        this._tileBuildTok.clear(); this._tileReassembly.clear();
        if (this._tileBoundsTimer) { clearTimeout(this._tileBoundsTimer); this._tileBoundsTimer = null; }
        this._centreHidden = false;  // fresh groups spawn visible — the flag must match
        this.scene3d.setShadowsSuspended3D(false);
        if (this._dynResTimer) { clearTimeout(this._dynResTimer); this._dynResTimer = null; } this._dynResMoveStart = 0;
        if (this._dynResOn) { this._dynResOn = false; this.scene3d.setDynamicResScale3D(1); }
        // Remove the (now-empty) City wrapper too; a rebuild recreates it and re-applies `_cityTransform`, so the
        // placement persists across regens. (`_cityTransform` itself is NOT reset here — only setCityTransform changes it.)
        if (this._cityContainer) { this.scene3d.removeFlatColorMeshGroup(this._cityContainer); this._cityContainer = null; }
        this._lodTint.forget();       // its meshes are gone
        this._applyLodRenderer();     // no city -> the renderer-wide LOD options back to the defaults
        this._graph = null;
        // bug-hunt 2026-10-01: the streamed-tile stale guard is `tileParams() !== p` — leaving the old params here let
        // a worker tile result that landed AFTER clear() pass it and re-create an orphan "City" container (+ retire
        // dead-world geometry into the just-purged LRU). The next build/stream sync sets it again.
        this._tileParamsForBuild = null;
    }

    /** Document-load reset (bug-hunt 2026-10-01): the WorldManager used to survive a load — doc A's graph/params/
     *  traffic/streaming/City mode kept running in doc B, the cached (now DETACHED) container swallowed B's own city
     *  build, and an in-flight first build of A landed in B (and was saved with it). Run BEFORE the restore. */
    clearForDocumentLoad(): void {
        if (this._cityMode || this._pendingCityEnter) {
            try { this.exitCityMode(); } catch (e) { console.warn('[world] exitCityMode during document load failed', e); }
        }
        this._turntable = 0;
        this.clear();
        this._params = null;
        this._previewGraph = null;
        this._pendingCityEnter = false;
        this._preCityLighting = null;
        this._preCityCascades = null;
        this._suppressNextFinishLighting = false;
        this._style = undefined;
        this._resetLookForLoad();
        this._setLodCfgForLoad(defaultCityLodSettings());   // LOD settings belong to the city: a new doc starts at the defaults
    }
    private _setLodCfgForLoad(cfg: CityLodSettings): void {
        this._lodTint.forget();
        this._lodCfg = { ...cfg, debugTint: false };
        this._sim.configure({ ...cfg.sim, reset: true });   // SIM LOD: a document starts from its saved fields
        this._distLodOn = this._lodCfg.distanceLod;
        this._distLodMul = this._lodCfg.global;
        this._lodCfgVer++;
        this._distLodKey = '';
        this._distLodBias = -1;
    }

    /** bug-hunt 2026-10-01 D-P3: every city LOOK field back to a FRESH session's state. restoreFromSave only resets
     *  them inside the `if (wp.lighting)` branch, so a new city in a doc without one inherited the PREVIOUS doc's grade / tints /
     *  lamps / sky / fog / SSAO / outlines / finish / cascades / key-fill / haze / preset / time of day / placement.
     *  Mirrors the constructor (CITY_CLEAN_LOOK) + the field initializers; world-bug-hunt.test.ts compares against a
     *  fresh instance. */
    private _resetLookForLoad(): void {
        this._setLookData(CITY_CLEAN_LOOK);
        this._cityTransform = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
        this._timeOfDay = null;
        this._overrideGlobalLighting = true;
        this._sunAzimuth = Math.PI * 0.25;
        this._cycleOn = false;
        this._cyclePeriod = 120;
        this._lookOutlines = false;
        this._ssaoOn = false;
        this._scenePreset = null;
        this._shadowCascades = 2;
        this._shadowNearM = 24;
        this._groundContact = true;
        this._groundContactStrength = 0.55;
        this._moverShadows.set(MOVER_SHADOW_DEFAULTS.on, MOVER_SHADOW_DEFAULTS.strength);   // visual-polish #16
        this._lastGlowNight = -1;
        this._traffic.setSignalTiming({ ...DEFAULT_SIGNAL_TIMING });
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
    public _ensureCityContainer(): MeshGroup3D {
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
    /** T7.2 — frame the whole city (centre + resident streamed tiles; far decoration excluded) from the current view
     *  direction. The "return to the scene" button's City-mode path. False when no city exists. */
    frameCity(padding = 1.1): boolean {
        if (!this._cityContainer) return false;
        // Skip the MOVERS (traffic / clouds / planes / flyers — cheapBounds meshes): a plane or cloud route can run
        // well outside the city and would pull the framing out.
        return this.scene3d.frameScene3D({ padding, root: this._cityContainer, skip: (m) => m.cheapBounds });
    }

    /** HERO VIEW (city-quality L7): a perspective, street-canyon framing of the city — ~40° FOV, ~30° pitch, a
     *  three-quarter azimuth, pulled in from the fit-all framing so buildings have presence. Returns false with no city. */
    heroView(opts: { fovDeg?: number; pitchDeg?: number; azimuthDeg?: number; zoom?: number } = {}): boolean {
        const c = this._cityContainer;
        if (!c) return false;
        const cam = this.scene3d.getCamera();
        cam.mode = 'perspective';
        cam.fov = (opts.fovDeg ?? 40) * Math.PI / 180;
        this.scene3d.frameGroup(c);                                  // target + radius fitted to the city
        const ctrl = this.scene3d.getOrbitController();
        if (ctrl) {
            ctrl.radius *= Math.max(0.1, opts.zoom ?? 0.55);
            ctrl.setSpherical((opts.azimuthDeg ?? 35) * Math.PI / 180, (opts.pitchDeg ?? 30) * Math.PI / 180);
        }
        this.scene3d.requestRender3D();
        return true;
    }

    /** STREET VIEW (polish-round-3 T1.5): an eye-level perspective shot from a pavement, looking ALONG a street —
     *  the P5X framing. `eyeHeightM` (default 1.6 m, real metres → city units via cityMetresPerUnit), `fovDeg`
     *  (default 50), `pitchDeg` (look up, default 4), `pick` cycles through candidate streets (0, 1, 2 …), `side`
     *  picks the pavement (1 / -1). Candidates are streets about a third of the way out from the centre (busy but
     *  with depth). City-mode framing (the container sits at identity there). Returns false with no city / streets. */
    streetView(opts: { fovDeg?: number; eyeHeightM?: number; pitchDeg?: number; pick?: number; side?: 1 | -1 } = {}): boolean {
        const g = this._graph;
        if (!g || !this._cityContainer || !g.roads.length) return false;
        const p = g.params, R = p.radius, s = R / 10, mpu = cityMetresPerUnit(R);
        // SUN-AWARE (the P5X shot): prefer a street the low sun crosses at ~65 deg from its axis, from behind the camera. The
        // far row of facades then faces the sun and the near row's shadow only drops ~W*tan(elev) down it (a sun raking
        // ALONG the street throws the near row's shadow the whole way up the far row). Stand on the pavement of the shaded
        // row, looking across at the lit one.
        let sunH: [number, number] | null = null;
        if (this._timeOfDay != null) {
            const L = computeDayNight(this._timeOfDay, { weather: p.weather, sunAzimuth: this._sunAzimuth });
            const hl = Math.hypot(L.sunDir[0], L.sunDir[2]);
            if (L.day > 0.2 && hl > 1e-3) sunH = [L.sunDir[0] / hl, L.sunDir[2] / hl];   // the light's travel direction
        }
        const want = Math.cos(65 * Math.PI / 180);
        const cands = g.roads
            .map((r) => {
                const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
                const mid: [number, number] = [(r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2];
                let a = r.a, b = r.b, align = 0;
                if (sunH && len > 0) {
                    const d = ((b[0] - a[0]) * sunH[0] + (b[1] - a[1]) * sunH[1]) / len;
                    if (d < 0) { a = r.b; b = r.a; }   // look WITH the light (sun behind)
                    align = Math.abs(Math.abs(d) - want);
                }
                return { r, a, b, len, mid, score: Math.abs(Math.hypot(mid[0], mid[1]) - 0.3 * R) / R + align * 0.8 };
            })
            .filter((c) => c.len > 0.8 * s)
            .sort((u, v) => u.score - v.score);
        if (!cands.length) return false;
        const pave = p.streetWidth * 0.31;   // the pavement band (streetBandHalf - half)
        for (let tries = 0; tries < cands.length; tries++) {
            const c = cands[((opts.pick ?? 0) + tries) % cands.length], r = c.r;
            const dir: [number, number] = [(c.b[0] - c.a[0]) / c.len, (c.b[1] - c.a[1]) / c.len];
            const side = opts.side ?? (sunH && (-dir[1] * -sunH[0] + dir[0] * -sunH[1]) < 0 ? -1 : 1);
            const perp: [number, number] = [-dir[1] * side, dir[0] * side];
            const off = r.width * 0.5 + pave * 0.42;
            const ex = c.a[0] + dir[0] * c.len * 0.15 + perp[0] * off, ez = c.a[1] + dir[1] * c.len * 0.15 + perp[1] * off;
            if (cellLevelAt(g, ex, ez) < 0) continue;   // never stand in a canal
            const eyeY = p.groundY + this._heightFn(ex, ez) + (opts.eyeHeightM ?? 1.6) / mpu;
            const ahead = 12 / mpu, pitch = (opts.pitchDeg ?? 4) * Math.PI / 180;
            const tx = ex + dir[0] * ahead - perp[0] * off * 0.35, tz = ez + dir[1] * ahead - perp[1] * off * 0.35;   // aim a touch toward the road
            const w0: [number, number] = [0, 0], w1: [number, number] = [0, 0];
            this._warpInto(ex, ez, w0); this._warpInto(tx, tz, w1);
            const cam = this.scene3d.getCamera();
            cam.mode = 'perspective';
            cam.fov = (opts.fovDeg ?? 50) * Math.PI / 180;
            cam.setPosition(ex + w0[0], eyeY, ez + w0[1]);
            cam.setTarget(tx + w1[0], eyeY + Math.tan(pitch) * ahead, tz + w1[1]);
            this.scene3d.getOrbitController()?.syncFromCamera();
            this.scene3d.requestRender3D();
            return true;
        }
        return false;
    }

    /** _add with explicit height/warp environment + target list — the ASYNC regen stages a NEW city's groups
     *  (built with the NEW graph's fields) while the OLD city stays live and ticking. `silent` skips the host
     *  scene-graph notification (async staging → the host never sees the transient old+new "2N" graph). */
    private _addStaged(name: string, layers: LayoutPreviewLayer[],
        heightFn: (x: number, z: number) => number, smoothFn: (x: number, z: number) => number,
        warpInto: (x: number, z: number, out: [number, number]) => void, into: MeshGroup3D[], silent = false, preDraped = false,
        chunk = true): void {
        if (!layers.length) return;
        if (preDraped) {   // streamed tiles arrive world-ready (drapeTileLayers ran in the worker) — skip both passes
            if (!isContactDone(layers)) layers = this._withContactShadows(layers);   // persona-polish A3 (world-ready geometry → blobs sit on it); worker builds made them over the WHOLE group already (P3.2)
            into.push(this._addCrowdAware(name, chunk ? this._chunked(name, layers) : layers, silent));
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
        const BAKED = /rail-|util-pole|util-wire|bldg-|world:detail|world:roofs|roof-detail|roof-equip|roof-mark|balcony|screen-|world:sign-|world:roadsign-|world:warning|awning-|shopfront|noren|textsign-|lm-|foundation|world:sky-|laundry|construction|world:parking|alley-clutter/;
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
            // ★ ANY instanced layer (not just world:detail) — see drape.ts, kept in lockstep. Lifting/warping
            // the shared canonical geometry moves every copy identically; an instanced TREE would sit at the
            // origin's height with a sheared canopy. Transform-level lift is also the only tear-free way to
            // place a WIDE rigid prop across a terrace step.
            const inst = (L as any).instances as { x: number; y: number; z: number }[] | undefined;
            const tier = L.drape ?? (BAKED.test(L.name) ? 'baked'
                : /bridge|retaining|stair|canal/.test(L.name) ? 'smooth' : 'full');
            const noWarp = L.noWarp || NOWARP.test(L.name);   // rigid layers (the elevated railway) opt out of the warp
            if (L.crowdRecords) drapeCrowdRecords(L.crowdRecords, heightFn, smoothFn, noWarp ? null : warpInto);   // P12 (drape.ts lockstep)
            if (inst?.length) {
                // warpInto writes a DISPLACEMENT (dx, dz) — add it (like applyDomainWarp does per-vertex), don't
                // overwrite the position (that collapsed every instance to the origin → one giant pile).
                if (tier !== 'baked') { const f = tier === 'smooth' ? smoothFn : heightFn; for (const t of inst) t.y += f(t.x, t.z); }
                if (!noWarp) for (const t of inst) { warpInto(t.x, t.z, _ws); t.x += _ws[0]; t.z += _ws[1]; }
                continue;
            }
            if (tier !== 'baked') applyHeightField(L.geometry, tier === 'smooth' ? smoothFn : heightFn);
            if (!noWarp) applyDomainWarp(L.geometry, warpInto);
        }
        layers = this._withContactShadows(layers);   // persona-polish A3: AFTER the drape + warp (final positions)
        into.push(this._addCrowdAware(name, this._chunked(name, layers), silent));
    }

    /** addFlatColorMeshGroup + the P12 instanced crowd: its AUX layers (footprints + person records) never become meshes,
     *  every xfar copy shares ONE geometry per variant, and the group registers with the crowd manager. */
    private _addCrowdAware(name: string, layers: LayoutPreviewLayer[], silent: boolean): MeshGroup3D {
        this._internPropLayers(layers);   // P20
        let crowd: LayoutPreviewLayer[] | null = null;
        for (const L of layers) if (L.crowdAux || L.crowdInst) (crowd ??= []).push(L);
        if (!crowd) return this.scene3d.addFlatColorMeshGroup(name, layers, silent, this._ensureCityContainer());
        for (const L of crowd) if (L.crowdInst && L.instanceKey) L.geometry = this._crowd.intern(L.instanceKey, L.geometry);
        const g = this.scene3d.addFlatColorMeshGroup(name, layers.filter(L => !L.crowdAux), silent, this._ensureCityContainer());
        this._crowd.register(g, crowd);
        return g;
    }

    /** P12: the crowd's dress for a lazily built cell mesh (world-crowd.ts) — the crowd style's diffuse + render style
     *  (_pedLook from the flat build colour) and the glow walk's emissive, exactly as a baked crowd layer gets them. */
    _dressCrowdMesh(m: Mesh3D): void {
        const name = m.name ?? '';
        const d = PED_SHADE.diffuse;
        m.material.diffuse = { r: d, g: d, b: d, a: m.material.diffuse.a };   // the flat build colour (white × the crowd dim)
        this._pedOrig.delete(m);
        this._pedLook(m, name);
        const night = this._lastGlowNight >= 0 ? this._lastGlowNight : 0;
        const [fd, fn] = this._pedGlow(name), f = fd + (fn - fd) * night, dd = m.material.diffuse;
        m.material.emissive = { r: dd.r * f, g: dd.g * f, b: dd.b * f, a: 1 };
        m.materialDirty = true;
    }

    /** P12: the instanced crowd (default) vs the baked per-colour crowd (world param `instancedCrowd`; rebuilds the world). */
    setInstancedCrowd(on: boolean): void {
        if (!this._params || (this._params.instancedCrowd !== false) === on) return;
        const next = { ...this._params };
        if (on) delete next.instancedCrowd; else next.instancedCrowd = false;
        this.generateWorld(next);
    }

    // ── CONTACT SHADOWS (persona-polish A3) — soft blobs under people / parked cars / street props (contact-shadows.ts).
    // Always BUILT (one transparent quad layer per group, a few hundred triangles); shown / faded live by the glow walk.
    private _groundContact = true;
    private _groundContactStrength = 0.55;
    private _withContactShadows(layers: LayoutPreviewLayer[]): LayoutPreviewLayer[] {
        try {
            return withContactShadows(layers, cityContactShadowOptions(this._graph?.params.radius ?? this._params?.radius ?? 10, this._groundContactStrength));
        } catch { return layers; }   // never let a grounding nicety break a city build
    }
    /** Contact shadows (soft ground blobs under people, parked cars and street props). `strength` 0..1 = blob
     *  opacity (default 0.55). Persisted with the city; live (no rebuild). */
    setGroundContact(on: boolean, strength?: number): void {
        this._groundContact = !!on;
        if (typeof strength === 'number' && isFinite(strength)) this._groundContactStrength = Math.max(0, Math.min(1, strength));
        this._applyGroundContact();
        this._stampWorldParams();
    }
    get groundContact(): { on: boolean; strength: number } { return { on: this._groundContact, strength: this._groundContactStrength }; }
    /** visual-polish #16: soft contact blobs under the MOVING walkers, cars, buses, train cars and the Play player (one
     *  transparent mesh that follows them; world-mover-shadows.ts). `strength` 0..1 = blob opacity (default 0.55). On for
     *  new cities; a city saved before it reloads with it off. Persisted with the city; live (no rebuild). */
    setMoverShadows(on: boolean, strength?: number): void {
        this._moverShadows.set(on, strength);
        this.scene3d.requestRender3D();
        this._stampWorldParams();
    }
    get moverShadows(): { on: boolean; strength: number } { return { on: this._moverShadows.on, strength: this._moverShadows.strength }; }
    /** Mover-blob counters (blobs built / shown / written last frame, update ms, uploads). */
    moverShadowStats(reset = false): Record<string, number> { const s = { ...this._moverShadows.stats }; if (reset) this._moverShadows.resetStats(); return s; }
    private _applyGroundContact(): void {
        let changed = false;
        for (const g of this._groups) for (const ch of g.children) {
            const m = ch as Mesh3D;
            if (!m.material || !/world:contact-shadow/.test(m.name ?? '')) continue;
            const vis = this._groundContact && this._groundContactStrength > 0.001;
            if (m.visible !== vis) { m.visible = vis; changed = true; }
            const op = Math.max(0.001, Math.min(0.999, this._groundContactStrength));
            if (m.material.opacity !== op) { m.material.opacity = op; m.materialDirty = true; }
        }
        if (changed) this.scene3d.notifyVisibilityChanged3D?.();
        this.scene3d.requestRender3D();
    }

    // ── SPATIAL CHUNKING (polish-round-3 Round 5 — culling) ─────────────────────────────────────────────────────
    // Big city-wide merged layers are split into per-cell meshes / per-cell instanced groups (world/chunking.ts) AFTER
    // the drape + warp (final render-space positions), right before they become meshes — the one choke point every
    // centre / worker / tile build passes through. Names are unchanged, so every name-keyed rule still matches.
    // Groups skipped: CHUNK_SKIP_GROUPS (sky dome, border glow, movers/doors). Streamed TILES skip it too (see
    // _addTracked). The centre-build WORKER chunks off-thread (CentreBuildOptions.chunk); its layers pass through.
    private _cullChunks = true;
    private _chunkTune: Partial<ChunkOptions> & { minCellMul?: number } = {};
    /** Toggle spatial chunking (A/B: `salsaWorld.cullChunks(false)`); `tune` overrides the grid rule for profiling
     *  ({ targetTris, maxCells, minInstances, minCellMul }). Rebuilds the current world when one exists. */
    setCullChunks(on: boolean, tune?: Partial<ChunkOptions> & { minCellMul?: number }): void {
        if (this._cullChunks === on && !tune) return;
        this._cullChunks = on;
        if (tune) this._chunkTune = tune;
        if (this._params && this._graph) this.generateWorld({ ...this._params });
    }
    get cullChunks(): boolean { return this._cullChunks; }
    /** P9: the heavy props' far twins + the crowd's third tier (world param `propTwins`; rebuilds the world). */
    setPropTwins(on: boolean): void {
        if (!this._params || (this._params.propTwins !== false) === on) return;
        this.generateWorld({ ...this._params, propTwins: on });
    }
    /** P9 runtime switches (no rebuild): read, or set all of them on / off together. */
    private _p9Switches(on?: boolean): Record<string, boolean> {
        const r = (this.scene3d as unknown as { renderer3D: Record<string, boolean> }).renderer3D, t = this._traffic as unknown as Record<string, boolean>;
        const S = this.scene3d.constructor as unknown as { lazyCameraCandidates?: boolean } | undefined;
        if (on !== undefined) {
            r.hierarchicalCull = on; r.drawListFastPaths = on; r.resolutionLod = on; r.useGeometryBounds = on;
            t.blockGrid = on; if (S) S.lazyCameraCandidates = on;
            this.scene3d.requestRender3D();
        }
        return { hierarchicalCull: r.hierarchicalCull, drawListFastPaths: r.drawListFastPaths, resolutionLod: r.resolutionLod,
            useGeometryBounds: r.useGeometryBounds, blockGrid: t.blockGrid, lazyCameraCandidates: !!S?.lazyCameraCandidates, propTwins: this._params?.propTwins !== false };
    }
    /** The chunk options for a city of `radius` (null = chunking off) — shared by the main-thread step and the
     *  centre-build worker request. */
    private _chunkOpts(radius?: number): ChunkOptions | null {
        if (!this._cullChunks) return null;
        const { minCellMul, ...t } = this._chunkTune;
        return { ...t, minCell: chunkMinCell(radius ?? 10) * (minCellMul ?? 1) };
    }
    private _chunked(name: string, layers: LayoutPreviewLayer[]): LayoutPreviewLayer[] {
        const o = this._chunkOpts(this._params?.radius);
        if (!o || CHUNK_SKIP_GROUPS.test(name)) return layers;
        return chunkCityLayers(layers, o);   // already-chunked (worker) layers pass through untouched
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
