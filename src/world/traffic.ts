// ── World generation — traffic (the moving-city sim, v1) ────────────────────────────────────────
// Computes MOVER SPECS: cars driving the long straight road runs (left-hand traffic, both directions), a
// moving train on the viaduct, and a few walking pedestrians. Each mover = its own tiny geometry built at the
// ORIGIN oriented along its route; the WorldManager spawns them as individual meshes and slides them along
// `a → b` every frame (wrapping), lifting Y with the terrain. Pure + deterministic; the per-frame ticking
// lives bridge-side (a first taste of the future src/game sim).

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { Accum3D } from './meshbuild';
import { makeVehicleAcc, emitVehicle, vehicleLayers, VEH_TAXI, type VehicleType } from './vehicle';
import { hash2, pointInPolygon } from './util';
import { railwayLine, skywayPath } from './railway';
import { inShotengai } from './shotengai';
import { terraceStep, cellLevelAt, inRamp } from './elevation';
import { duckFlotillaLayers, duckGarpPool, DUCK_COLORWAYS } from './ducks';
import { pickSkin } from './garp';

type V3 = [number, number, number];

export interface MoverSpec {
    kind: 'car' | 'walker' | 'train' | 'cloud' | 'holo' | 'rain' | 'boat';
    a: V2; b: V2;          // route endpoints (centerline)
    t0: number;            // start phase 0..1
    speed: number;         // world units / second (for kind 'rain' this is the FALL speed)
    lane: number;          // signed perpendicular offset from the centerline
    baseY: number;         // geometry rest height (train bakes the deck height; clouds bake altitude; others ride terrain)
    layers: LayoutPreviewLayer[];   // origin-centred geometry, oriented along the route direction (path movers: along +X)
    pingPong?: boolean;    // shuttle: reverse at the ends instead of wrapping (the train)
    margin?: number;       // t-margin kept clear at both ends (half the mover's own length — no overshoot)
    /** Multi-segment POLYLINE route (overrides a→b). Geometry must be built along +X at the origin — the ticker
     *  follows the segments and YAWS the meshes to each heading (the sky-train weaving through the megatower,
     *  birds circling a landmark). A CLOSED polyline (last pt = first) + no pingPong = a continuous loop. */
    path?: V2[];
    /** kind 'rain': the vertical wrap range (rain streaks / snowflakes / sakura petals fall through it). */
    fallRange?: number;
    /** kind 'rain': lateral sine-sway amplitude (snow drifts, petals flutter; rain falls straight). */
    sway?: number;
    /** kind 'car' buses: route-t positions where the mover pauses a moment (bus stops). */
    stops?: number[];
    /** Geometry is built along +X and the ticker YAWS the meshes to the route heading (like path movers).
     *  Lets every car/bus/fish/flyer of an archetype SHARE one geometry (batched instanced draws) instead
     *  of baking its route direction into a unique copy. */
    faceRoute?: boolean;
    /** ARTICULATED CONSIST (the train): `layers` is ONE car built at the origin along +X. The spawner clones it
     *  `count` times and the ticker places each car at its OWN arc-length along the route (`spacing` world units
     *  apart) with the LOCAL heading there — so the consist bends around a curve instead of rotating as one rigid
     *  body (the back car no longer swings off the outside of a turn). */
    cars?: { count: number; spacing: number };
}

const CARBODY: [number, number, number][] = [[0.86, 0.86, 0.88], [0.22, 0.24, 0.28], [0.68, 0.22, 0.20], [0.22, 0.38, 0.58], [0.90, 0.78, 0.30]];
const DARK: [number, number, number] = [0.10, 0.11, 0.13];
const TRAIN: [number, number, number] = [0.28, 0.50, 0.72];
const TRAIN_DK: [number, number, number] = [0.12, 0.13, 0.16];
const CLOTHES: [number, number, number][] = [[0.82, 0.30, 0.28], [0.24, 0.38, 0.62], [0.92, 0.86, 0.78], [0.28, 0.50, 0.38]];
const SKIN: [number, number, number] = [0.92, 0.78, 0.66];

/** Merge the per-cell road segments into maximal straight RUNS (junction-variety breaks some lines).
 *  ONE scan over the roads (was two — one per orientation), grouped by ROUNDED NUMERIC lane coordinate:
 *  Math.round(c·1e4)/1e4 reproduces the old parseFloat(c.toFixed(4)) key + quantized centreline without a
 *  string alloc + parse per road. Emit order (all vertical runs, then horizontal, each in road-scan group
 *  order) matches the old two-sweep output exactly. */
function roadRuns(graph: WorldGraph): { a: V2; b: V2 }[] {
    type Span = { lo: number; hi: number };
    const vGroups = new Map<number, Span[]>(), hGroups = new Map<number, Span[]>();
    for (const r of graph.roads) {
        if (r.klass === 'alley' || r.klass === 'ring') continue;
        const vertical = Math.abs(r.a[0] - r.b[0]) < 1e-6;
        const groups = vertical ? vGroups : hGroups;
        const key = Math.round((vertical ? r.a[0] : r.a[1]) * 1e4);
        const u0 = vertical ? r.a[1] : r.a[0], u1 = vertical ? r.b[1] : r.b[0];
        const span: Span = { lo: Math.min(u0, u1), hi: Math.max(u0, u1) };
        const g = groups.get(key);
        if (g) g.push(span); else groups.set(key, [span]);
    }
    const runs: { a: V2; b: V2 }[] = [];
    const emit = (groups: Map<number, Span[]>, vertical: boolean): void => {
        for (const [key, segs] of groups) {
            segs.sort((x, y) => x.lo - y.lo);
            const c = key / 1e4;   // the quantized lane coordinate (same value the old parseFloat produced)
            let cur: Span | null = null;
            const flush = (): void => { if (cur) runs.push(vertical ? { a: [c, cur.lo], b: [c, cur.hi] } : { a: [cur.lo, c], b: [cur.hi, c] }); };
            for (const sg of segs) {
                if (cur && sg.lo <= cur.hi + 1e-4) cur.hi = Math.max(cur.hi, sg.hi);
                else { flush(); cur = { lo: sg.lo, hi: sg.hi }; }
            }
            flush();
        }
    };
    emit(vGroups, true); emit(hGroups, false);
    return runs;
}

/** All movers for a graph: ~2 cars per long run (both directions, left-hand lanes), 1 train, a few walkers. */
export function computeTraffic(graph: WorldGraph): MoverSpec[] {
    const p = graph.params, gy = p.groundY, s = p.radius / 10;
    // Walking crowd scales with pedestrianDensity, but CAPPED (×4) — walkers are per-frame MOVERS (unlike the cheap
    // baked static crowd), so a 20× slider shouldn't spawn thousands of ticking movers. Static peds carry the density.
    const walkMul = Math.min(Math.max(0.1, p.pedestrianDensity ?? 1), 4);
    const out: MoverSpec[] = [];
    const H = (a: number, b: number, salt: number): number => hash2(a, b, (p.seed ^ salt) >>> 0);

    // ARCHETYPE geometry cache: every mover of the same archetype (red car, robot walker, storm cloud #3…)
    // shares ONE geometry object + an `instanceKey`, so the renderer uploads it once and batches all of them
    // into instanced draws. Vehicles build along +X and set `faceRoute` (the ticker yaws them per route).
    const geoCache = new Map<string, LayoutPreviewLayer[]>();
    const arch = (key: string, build: () => LayoutPreviewLayer[]): LayoutPreviewLayer[] => {
        let l = geoCache.get(key);
        if (!l) { l = build().map(L => ({ ...L, instanceKey: `${key}:${L.name}` })); geoCache.set(key, l); }
        return l;
    };

    const key = (r: { a: V2; b: V2 }): number => hash2(r.a[0] * 13.7 + r.b[1] * 3.1, r.a[1] * 7.3 + r.b[0], p.seed);
    // Keep movers OFF the water: cars + walkers ride these runs end-to-end, so a run that crosses a canal or runs
    // out past the diorama border into the sea would put traffic on the water. Trim each run to its LONGEST
    // contiguous on-LAND span (border + canal aware) before anything spawns; runs with no usable land span drop out.
    const border = graph.border, bridges = graph.bridges;
    // A bridge DECK is a real carriageway even though the cell under it reads as canal water — treat it as passable
    // so traffic CROSSES canals on the bridges instead of the run being trimmed off at the water's edge.
    const onBridge = (x: number, z: number): boolean => { for (const deck of bridges) if (pointInPolygon([x, z], deck)) return true; return false; };
    const onLand = (x: number, z: number): boolean =>
        onBridge(x, z) || (cellLevelAt(graph, x, z) >= 0 && (border.length < 3 || pointInPolygon([x, z], border)));
    const trimRun = (run: { a: V2; b: V2 }): { a: V2; b: V2 } | null => {
        const N = 28, dx = run.b[0] - run.a[0], dz = run.b[1] - run.a[1];
        let curLo = -1, bestLo = -1, bestHi = -1, curLvl = 0;
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            const px = run.a[0] + dx * t, pz = run.a[1] + dz * t;
            if (onLand(px, pz)) {
                // Split the run at a TERRACE LEVEL CHANGE that has NO RAMP. A road climbing into a higher block steps
                // up a retaining wall; where a road RAMP bridges that step the car climbs it (the ramp slopes the
                // carriageway + the height field), so the run stays whole there. Elsewhere the run splits so a car
                // stops at the kerb instead of dropping off the cliff. (Bridge decks + ramps inherit the current
                // level so a canal or a ramped crossing is NOT split.)
                const lvl = (onBridge(px, pz) || inRamp(graph.ramps, px, pz)) ? curLvl : cellLevelAt(graph, px, pz);
                if (curLo < 0 || lvl !== curLvl) { curLo = i; curLvl = lvl; }
                if (i - curLo > bestHi - bestLo) { bestLo = curLo; bestHi = i; }
            } else curLo = -1;
        }
        if (bestLo < 0 || bestHi <= bestLo) return null;
        const t0 = (bestLo + 0.5) / N, t1 = (bestHi - 0.5) / N;   // inset half a step so the ends sit fully on land
        if (t1 <= t0) return null;
        return { a: [run.a[0] + dx * t0, run.a[1] + dz * t0], b: [run.a[0] + dx * t1, run.a[1] + dz * t1] };
    };
    const runs = roadRuns(graph)
        .map(trimRun).filter((r): r is { a: V2; b: V2 } => r !== null)
        .filter(r => Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]) > 2.2 * s)
        .sort((r1, r2) => key(r1) - key(r2)).slice(0, 24);

    runs.forEach((run, ri) => {
        const d = nrm2([run.b[0] - run.a[0], run.b[1] - run.a[1]]);
        const lane = p.streetWidth * 0.22;
        // Cars keep off the pedestrian shotengai — drop car slots on runs that pass through the corridor.
        let throughSg = false;
        for (let k = 0; k <= 4; k++) { const t = k / 4; if (inShotengai(graph, run.a[0] + (run.b[0] - run.a[0]) * t, run.a[1] + (run.b[1] - run.a[1]) * t)) { throughSg = true; break; } }
        for (const rev of [false, true]) {                       // both directions — up to 2 cars per direction
            const nCars = throughSg ? 0 : H(ri, rev ? 1 : 0, 0xca11) < 0.12 ? 0 : H(ri, rev ? 1 : 0, 0xbe02) < 0.45 ? 2 : 1;
            // Left-hand traffic: the SAME +lane for both directions — the offset is applied in each mover's
            // own route frame (which flips with direction), so +lane lands on opposite world sides.
            // SPAWN SPACING: every vehicle in this lane (cars + the bus) takes an EVENLY SPACED slot with a
            // small jitter, so no two vehicles can spawn on top of each other.
            const hasBus = !rev && !throughSg && ri % 3 === 0;
            const nSlots = nCars + (hasBus ? 1 : 0);
            if (nSlots === 0) continue;
            const base = H(ri, rev ? 3 : 2, 0x77aa);
            for (let k = 0; k < nSlots; k++) {
                const t0 = (base + k / nSlots + (H(ri, 60 + k + (rev ? 8 : 0), 0x2f11) - 0.5) * (0.25 / nSlots) + 1) % 1;
                if (hasBus && k === nSlots - 1) {
                    // The BUS: slower, pauses at two "stops" along the route (route service reads real).
                    out.push({
                        kind: 'car', a: run.a, b: run.b, t0, speed: 0.3 * s, lane, baseY: gy,
                        stops: [0.28, 0.72], faceRoute: true, layers: arch('bus', () => busLayers(s)),
                    });
                } else {
                    const colorIdx = (H(ri, k * 2 + (rev ? 7 : 6), 0x90ce) * CARBODY.length) | 0;
                    // Vehicle mix: ~9% checker TAXIS, ~21% old-school long CLASSICS, the rest modern sedans.
                    const vt = H(ri, k * 3 + (rev ? 21 : 20), 0x5a7c);
                    const type: VehicleType = vt < 0.09 ? 'taxi' : vt < 0.30 ? 'classic' : 'sedan';
                    const key = type === 'taxi' ? 'taxi' : type + colorIdx;   // share geometry per (type,colour)
                    out.push({
                        kind: 'car', a: rev ? run.b : run.a, b: rev ? run.a : run.b,
                        t0, speed: (0.42 + H(ri, k * 2 + (rev ? 5 : 4), 0x1f2d) * 0.22) * s, lane, baseY: gy,
                        faceRoute: true, layers: arch(key, () => carLayers(colorIdx, s, type)),
                    });
                }
            }
        }
        // WALKERS strolling the same runs — several per run, on BOTH SIDEWALKS. They keep to the pavement (lane ≥
        // half the carriageway + a margin) so they never stroll down the driving lane and hold a car up; a little
        // near-kerb / mid-pavement variety keeps the crowd from marching in a single file.
        for (let wi = 0; wi < Math.round(5 * walkMul); wi++) {
            if (H(ri, 9 + wi, 0x3b31) > 0.82) continue;
            const nearKerb = H(ri, 30 + wi, 0x77e1) < 0.35;
            const side = wi % 2 === 0 ? 1 : -1;
            out.push({
                kind: 'walker', a: run.a, b: run.b, t0: H(ri, 11 + wi, 0x0be5), speed: (0.1 + H(ri, 40 + wi, 0x51f7) * 0.06) * s,
                lane: (p.streetWidth * 0.5 + (nearKerb ? 0.03 : 0.07) * s) * side, baseY: gy,
                layers: (() => { const ci = (H(ri, 13 + wi, 0x24fa) * CLOTHES.length) | 0, rb = (p.holograms ?? false) && H(ri, 90 + wi, 0x0b07) < 0.28; return arch(`walker${ci}${rb ? 'r' : ''}`, () => walkerLayers(ci, s, rb)); })(),
            });
        }
    });

    // Shotengai strollers — the pedestrian street is BUSY (ping-pong up and down the corridor).
    const sg = graph.shotengai;
    if (sg) {
        for (let i = 0; i < Math.round(7 * walkMul); i++) {
            out.push({
                kind: 'walker', a: sg.spine[0], b: sg.spine[1], t0: H(i, 52, 0x1c44), speed: (0.08 + H(i, 53, 0x6d02) * 0.05) * s,
                lane: (H(i, 51, 0x9ab3) - 0.5) * sg.width * 0.62, baseY: gy, pingPong: true, margin: 0.04,
                layers: (() => { const ci = (H(i, 54, 0x33af) * CLOTHES.length) | 0, rb = (p.holograms ?? false) && H(i, 55, 0x77c2) < 0.28; return arch(`walker${ci}${rb ? 'r' : ''}`, () => walkerLayers(ci, s, rb)); })(),
            });
        }
    }

    // The moving train — a SHUTTLE now: it slows into the terminus and heads back (no more falling off the end).
    // ARTICULATED: one car geometry, cloned TRAIN_CARS times; the ticker places each car at its own arc-length.
    if (p.railway ?? true) {
        const { rx, z0, z1, deckY } = railwayLine(p);
        const spanLen = Math.abs(z1 - z0) || 1;
        const spacing = (2 * TRAIN_CAR_L + TRAIN_CAR_GAP) * s;
        const halfTrain = TRAIN_CARS * spacing * 0.5;   // half the consist (keeps the end cars on the span)
        out.push({
            kind: 'train', a: [rx, z0], b: [rx, z1], t0: 0.3, speed: 1.0 * s, lane: 0, baseY: 0,
            pingPong: true, margin: Math.min(0.4, halfTrain / spanLen),
            layers: trainLayers(deckY, s), cars: { count: TRAIN_CARS, spacing },
        });
    }

    // CLOUDS — slow seeded formations drifting across the sky, wrapping well past the border.
    // `cloudDensity` scales the count (≈3 sparse … ≈18 overcast); RAIN/SNOW force a heavy overcast deck.
    const weather = p.weather ?? 'clear';
    const overcast = weather !== 'clear';
    if (p.clouds ?? true) {
        const R = p.radius, density = p.cloudDensity ?? 0.55;
        // Clear = sparse puffies by the slider; RAIN = a genuinely heavy STORM DECK (30–44 dark clouds);
        // snow = a solid pale winter blanket. Overcast lanes overlap (×0.55 spacing jitter) so the deck closes.
        const nClouds = weather === 'rain' ? Math.round(60 + density * 28)
            : weather === 'snow' ? Math.round(44 + density * 20)
                : Math.max(2, Math.round((6 + density * 30) * 10));   // clear: 10× denser sky (density 1.0 → ~360 clouds)
        for (let i = 0; i < nClouds; i++) {
            const zLane = -R * 0.95 + (i + 0.5) * (2 * R * 0.95 / nClouds) + (H(i, 61, 0x40dd) - 0.5) * R * (overcast ? 0.55 : 0.2);
            // Clear clouds sit a little ABOVE the tallest building (~8·s city-units) with spread up to ~16·s; overcast
            // keeps its low storm-deck altitude. (s = radius/10.)
            const alt = overcast
                ? 1.05 * s * (R / 10) + H(i, 62, 0x2e19) * 0.9 * s
                : (10 + H(i, 62, 0x2e19) * 6) * s;
            const shape = i % 7;   // 7 shared cloud shapes (phase offsets keep the sky from reading repeated)
            out.push({
                kind: 'cloud', a: [-R * 1.35, zLane], b: [R * 1.35, zLane], t0: H(i, 63, 0x7b25),
                speed: (0.02 + H(i, 64, 0x1948) * 0.025) * s, lane: 0, baseY: p.groundY + alt,
                layers: arch(`cloud${weather}${shape}`, () => cloudLayers(shape, p.seed, s, weather)),
            });
        }
    }

    // AIRPLANES — occasional toy airliners crossing HIGH above the city (well above the clouds) on long
    // diagonal chords; they wrap far past the border, so each one passes only every ~40–60 s. kind 'cloud'
    // = fixed altitude, no warp, no bob; faceRoute yaws the shared archetype along each chord.
    if (p.clouds ?? true) {
        const R = p.radius;
        // Planes ALWAYS cruise above the tallest building — float above the real max facade height plus a margin
        // that also clears roof spires/masts (~+40%) and any terrain lift under a hilltop tower.
        // ORDERING DEPENDENCY: `builtH` is stamped on each lot by buildStreets, so computeTraffic must run
        // AFTER the street composer (world-manager does). If streets haven't run — or ran with a region filter
        // that skipped every lot — the scan sees 0; fall back to a plausible tall-building height (~2·s, the
        // upper commercial/civic massing range) so the planes never cruise at street level.
        const scanH = graph.lots.reduce((m, l) => Math.max(m, l.builtH ?? 0), 0);
        const tallestH = scanH > 0 ? scanH : 2.0 * s;
        const cruiseFloor = p.groundY + tallestH * 1.4 + 0.8 * s;
        for (let i = 0; i < 2; i++) {
            const ang = H(i, 110, 0x3d81) * Math.PI * 2;
            const off = (H(i, 111, 0x59c2) - 0.5) * R * 0.8;                   // chord offset from the centre
            const dxp: V2 = [Math.cos(ang), Math.sin(ang)], pp: V2 = [-dxp[1], dxp[0]];
            const a: V2 = [pp[0] * off - dxp[0] * R * 1.6, pp[1] * off - dxp[1] * R * 1.6];
            const b: V2 = [pp[0] * off + dxp[0] * R * 1.6, pp[1] * off + dxp[1] * R * 1.6];
            out.push({
                kind: 'cloud', a, b, t0: H(i, 112, 0x71aa), speed: (0.85 + H(i, 113, 0x2e94) * 0.3) * s,
                lane: 0, baseY: cruiseFloor + H(i, 114, 0x18d5) * 0.45 * s,
                faceRoute: true, layers: arch('plane', () => planeLayers(s)),
            });
        }
    }

    // FALLING WEATHER — a 5×5 grid of fall clusters (kind 'rain' = the generic fall-and-wrap mover): RAIN =
    // fast thin streaks, SNOW = slow drifting flakes. Deterministic, cheap, reads as weather.
    if (overcast) {
        const R = p.radius, grid = 5, snow = weather === 'snow';
        for (let gx = 0; gx < grid; gx++) for (let gz = 0; gz < grid; gz++) {
            const i = gx * grid + gz;
            const cx = -R * 0.85 + (gx + 0.5) * (2 * R * 0.85 / grid) + (H(i, 81, 0x4d21) - 0.5) * R * 0.12;
            const cz = -R * 0.85 + (gz + 0.5) * (2 * R * 0.85 / grid) + (H(i, 82, 0x1e88) - 0.5) * R * 0.12;
            const shape = i % 4;   // 4 shared cluster shapes, phase-offset
            out.push({
                kind: 'rain', a: [cx, cz], b: [cx, cz], t0: H(i, 83, 0x66b0),
                speed: (snow ? 0.24 : 2.4) * s, fallRange: (snow ? 1.5 : 1.7) * s, sway: snow ? 0.045 * s : 0,
                lane: 0, baseY: p.groundY,
                layers: snow ? arch(`snow${shape}`, () => snowLayers(shape, p.seed, s, R / grid)) : arch(`rainfall${shape}`, () => rainLayers(shape, p.seed, s, R / grid)),
            });
        }
    }

    // SAKURA PETALS — a few slow pink flutter clusters on clear days (spring on the wind). Rides the same
    // generic fall mover as rain/snow, just tiny, slow and swaying.
    if (weather === 'clear' && (p.streetTrees ?? true)) {
        const R = p.radius;
        for (let i = 0; i < 7; i++) {
            const cx = (H(i, 85, 0x3fa1) - 0.5) * R * 1.5, cz = (H(i, 86, 0x60c7) - 0.5) * R * 1.5;
            const shape = i % 4;
            out.push({
                kind: 'rain', a: [cx, cz], b: [cx, cz], t0: H(i, 87, 0x1b39),
                speed: 0.05 * s, fallRange: 0.5 * s, sway: 0.05 * s, lane: 0, baseY: p.groundY,
                layers: arch(`petal${shape}`, () => petalLayers(shape, p.seed, s)),
            });
        }
    }

    // DUCKS — small flotillas paddling the long canal runs (grid cities with canals only). Replaces the old canal
    // boat. Colourway comes from the GARP duck pool (position-hashed) so the "skin" is reskinnable/extensible.
    if (graph.levels) {
        const R = p.radius, cols = Math.max(2, p.gridCols | 0), rows = Math.max(2, p.gridRows | 0);
        const cw = 2 * R / cols, ch = 2 * R / rows, lv = graph.levels;
        const duckBaseY = gy - terraceStep(p) + 0.010 * s;   // ride the canal water surface (one terrace step down)
        const duckPool = duckGarpPool();
        let nBoats = 0;
        // Horizontal + vertical runs of contiguous canal cells (level < 0), ≥ 2 cells long.
        for (const vert of [false, true]) {
            const outer = vert ? cols : rows, inner = vert ? rows : cols;
            for (let o = 0; o < outer && nBoats < 4; o++) {
                let runStart = -1;
                for (let k = 0; k <= inner; k++) {
                    const level = k < inner ? (vert ? (lv[o]?.[k] ?? 0) : (lv[k]?.[o] ?? 0)) : 0;
                    if (level < 0 && runStart < 0) runStart = k;
                    else if (level >= 0 && runStart >= 0) {
                        if (k - runStart >= 2 && nBoats < 4) {
                            const mid = -R + (o + 0.5) * (vert ? cw : ch);
                            const lo = -R + (runStart + 0.35) * (vert ? ch : cw), hi = -R + (k - 0.35) * (vert ? ch : cw);
                            const a: V2 = vert ? [mid, lo] : [lo, mid], b: V2 = vert ? [mid, hi] : [hi, mid];
                            // Pick the duck colourway from the GARP pool by the run's midpoint (deterministic).
                            const skin = pickSkin(duckPool, (a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, p.seed);
                            const di = Math.max(0, skin ? DUCK_COLORWAYS.findIndex(c => c.name === skin.name) : nBoats % DUCK_COLORWAYS.length);
                            out.push({
                                kind: 'boat', a, b, t0: H(nBoats, 91, 0x77d2), speed: (0.028 + H(nBoats, 92, 0x2ea4) * 0.02) * s,   // ducks paddle slower than a boat
                                lane: (H(nBoats, 93, 0x4bb8) - 0.5) * 0.1 * s, baseY: duckBaseY, pingPong: true, margin: 0.06,
                                faceRoute: true, layers: arch('duck' + di, () => duckFlotillaLayers(di, s)),
                            });
                            nBoats++;
                        }
                        runStart = -1;
                    }
                }
            }
        }
    }

    // BIRDS — two small flocks circling on closed polyline loops (they yaw with the path): one over the city
    // centre, one over a landmark. Soft altitude bob via the holo tick.
    {
        const R = p.radius;
        const lmC = graph.landmarks.length ? graph.landmarks[graph.landmarks.length - 1].center : [R * 0.3, -R * 0.3] as V2;
        const flocks: { c: V2; r: number; alt: number }[] = [
            { c: [0, 0], r: R * 0.3, alt: (0.75 + H(1, 95, 0x0dc1) * 0.2) * s },
            { c: [lmC[0], lmC[1]], r: R * 0.22, alt: (0.9 + H(2, 96, 0x3a55) * 0.2) * s },
        ];
        flocks.forEach((fl, fi) => {
            const loop: V2[] = [];
            for (let k = 0; k <= 9; k++) { const ang = (k / 9) * Math.PI * 2; loop.push([fl.c[0] + Math.cos(ang) * fl.r, fl.c[1] + Math.sin(ang) * fl.r]); }
            for (let b = 0; b < 4; b++) {
                out.push({
                    kind: 'holo', a: loop[0], b: loop[loop.length - 1], path: loop,
                    t0: (b / 4 + H(fi, 97 + b, 0x5e12) * 0.06) % 1, speed: (0.22 + H(fi, 101 + b, 0x71f9) * 0.08) * s,
                    lane: (H(fi, 105 + b, 0x24d8) - 0.5) * 0.06 * s, baseY: p.groundY + fl.alt + (b % 2) * 0.04 * s,
                    layers: arch('bird', () => birdLayers(s)),
                });
            }
        });
    }

    // HOLOGRAM FISH — the cyber look: glowing translucent koi swim lazy laps between the buildings.
    if (p.holograms ?? false) {
        const R = p.radius;
        for (let i = 0; i < 9; i++) {
            const horiz = H(i, 71, 0x0f15) < 0.5;
            const lane = -R * 0.7 + H(i, 72, 0x2c66) * R * 1.4;
            const a: V2 = horiz ? [-R * 0.85, lane] : [lane, -R * 0.85];
            const b: V2 = horiz ? [R * 0.85, lane] : [lane, R * 0.85];
            const fi = i % 3;   // 3 shared koi archetypes (one per neon tint); faceRoute flips them at reversal
            out.push({
                kind: 'holo', a, b, t0: H(i, 73, 0x5aa1), speed: (0.14 + H(i, 74, 0x6db2) * 0.16) * s,
                lane: (H(i, 75, 0x3e47) - 0.5) * 0.3 * s, baseY: p.groundY + (0.55 + H(i, 76, 0x18c9) * 0.5) * s,
                pingPong: true, margin: 0.03,
                faceRoute: true, layers: arch('fish' + fi, () => holoFishLayers(fi, s)),
            });
        }

        // FLYING VEHICLES — sleek craft cruising fast above the rooftops (higher + straighter than the fish).
        for (let i = 0; i < 6; i++) {
            const horiz = H(i, 84, 0x33d0) < 0.5;
            const lane = -R * 0.65 + H(i, 85, 0x7aa9) * R * 1.3;
            const vi = i % 3;
            out.push({
                kind: 'holo', a: horiz ? [-R * 1.1, lane] : [lane, -R * 1.1], b: horiz ? [R * 1.1, lane] : [lane, R * 1.1],
                t0: H(i, 86, 0x18ef), speed: (0.35 + H(i, 87, 0x2bb4) * 0.2) * s,
                lane: (H(i, 88, 0x51c3) - 0.5) * 0.4 * s, baseY: p.groundY + (1.0 + H(i, 89, 0x0dd7) * 0.4) * s,
                faceRoute: true, layers: arch('flyer' + vi, () => flyerLayers(vi, s)),
            });
        }

        // The SKY-TRAIN — follows the multi-segment skyway polyline, weaving across the city and STRAIGHT
        // THROUGH the megatower's portal. Built along +X; the ticker yaws it to each segment's heading.
        const sky = skywayPath(graph);
        if (sky) {
            let total = 0; for (let i = 0; i < sky.pts.length - 1; i++) total += Math.hypot(sky.pts[i + 1][0] - sky.pts[i][0], sky.pts[i + 1][1] - sky.pts[i][1]);
            const spacing = (2 * SKY_CAR_L + SKY_CAR_GAP) * s;
            const halfTrain = SKY_CARS * spacing * 0.5;
            out.push({
                kind: 'train', a: sky.pts[0], b: sky.pts[sky.pts.length - 1], path: sky.pts,
                t0: 0.15, speed: 1.25 * s, lane: 0, baseY: 0, pingPong: true, margin: Math.min(0.4, halfTrain / Math.max(0.001, total)),
                layers: skyTrainLayers(sky.y, s), cars: { count: SKY_CARS, spacing },
            });
        }
    }
    return out;
}

/** A flying vehicle at the origin ALONG +X (faceRoute): a sleek wedge body + canopy + engine glow. */
function flyerLayers(idx: number, s: number): LayoutPreviewLayer[] {
    const body = new Accum3D(), glow = new Accum3D();
    const aW: V3 = [1, 0, 0], up: V3 = [0, 1, 0], cW: V3 = [0, 0, 1];
    body.obox([0, 0, 0], aW, up, cW, 0.045 * s, 0.011 * s, 0.02 * s);                      // hull
    body.blob([aW[0] * 0.012 * s, 0.012 * s, aW[2] * 0.012 * s], 0.016 * s, 0.009 * s, 0.013 * s, 0.1, idx * 7 + 3);   // canopy
    glow.obox([0, -0.011 * s, 0], aW, up, cW, 0.036 * s, 0.0022 * s, 0.014 * s);           // underside engine glow
    glow.blob([-aW[0] * 0.048 * s, 0, -aW[2] * 0.048 * s], 0.007 * s, 0.005 * s, 0.007 * s, 0, 0);   // tail thruster
    const TINT: [number, number, number][] = [[0.85, 0.87, 0.92], [0.30, 0.32, 0.38], [0.72, 0.30, 0.30]];
    return [
        { name: 'world:traffic-flyer', color: TINT[idx % TINT.length], y: 0, geometry: body.geometry() },
        { name: 'world:traffic-flyer-glow', color: [0.35, 0.9, 1.0], y: 0, geometry: glow.geometry(), emissive: 1.4 },
    ];
}

/** ONE SKY-TRAIN car at the origin ALONG +X at altitude `y` (baked — the skyway is level), with a glowing window
 *  band + underside maglev glow. Articulated: the ticker clones it `SKY_CARS` times, one per arc-length slot, so
 *  the consist WEAVES through the megatower portal instead of pivoting rigidly at each bend. */
export const SKY_CARS = 3, SKY_CAR_L = 0.24, SKY_CAR_GAP = 0.02;
function skyTrainLayers(y: number, s: number): LayoutPreviewLayer[] {
    const body = new Accum3D(), win = new Accum3D();
    const xA: V3 = [1, 0, 0], up: V3 = [0, 1, 0], zA: V3 = [0, 0, 1];
    const carL = SKY_CAR_L * s, w = 0.042 * s;
    body.obox([0, y, 0], xA, up, zA, carL, 0.034 * s, w);
    win.obox([0, y + 0.01 * s, 0], xA, up, zA, carL * 0.9, 0.012 * s, w * 1.06);
    win.obox([0, y - 0.036 * s, 0], xA, up, zA, carL * 0.8, 0.004 * s, w * 0.5);   // maglev underglow
    return [
        { name: 'world:traffic-skytrain', color: [0.88, 0.90, 0.95], y: 0, geometry: body.geometry() },
        { name: 'world:traffic-skytrain-glow', color: [0.30, 0.90, 1.0], y: 0, geometry: win.geometry(), emissive: 1.2 },
    ];
}

/** One RAIN CLUSTER at the origin: a merged sheet of thin vertical streaks scattered over a `half`-sized square.
 *  The ticker slides the whole cluster downward and wraps it to the top (several phase-offset clusters overlap
 *  into continuous rainfall). */
function rainLayers(idx: number, seed: number, s: number, half: number): LayoutPreviewLayer[] {
    const acc = new Accum3D();
    const H = (a: number, b: number): number => hash2(idx * 17.3 + a, b * 5.9, (seed ^ 0x9a1d) >>> 0);
    for (let k = 0; k < 34; k++) {
        const ox = (H(k, 1) - 0.5) * half * 2, oz = (H(k, 2) - 0.5) * half * 2, oy = H(k, 3) * 0.5 * s;
        acc.obox([ox, oy, oz], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.0009 * s, 0.05 * s, 0.0009 * s);
    }
    return [{ name: 'world:traffic-rain', color: [0.72, 0.79, 0.88], y: 0, geometry: acc.geometry(), emissive: 0.5, opacity: 0.4 }];
}

/** A glowing hologram koi at the origin ALONG +X (faceRoute yaws it): tapered body blobs + a tail fin. */
function holoFishLayers(idx: number, s: number): LayoutPreviewLayer[] {
    const acc = new Accum3D();
    const aW: V3 = [1, 0, 0], up: V3 = [0, 1, 0], cW: V3 = [0, 0, 1];
    acc.blob([0.02 * s, 0, 0], 0.035 * s, 0.02 * s, 0.02 * s, 0.15, idx * 13 + 1);   // body (elongated along +X)
    acc.blob([-0.02 * s, 0.002 * s, 0], 0.022 * s, 0.013 * s, 0.014 * s, 0.15, idx * 13 + 2);
    acc.obox([-0.052 * s, 0, 0], aW, up, cW, 0.013 * s, 0.016 * s, 0.002 * s);       // tail fin
    const NEON: [number, number, number][] = [[0.25, 0.95, 1.0], [1.0, 0.35, 0.85], [0.55, 1.0, 0.5]];
    return [{ name: 'world:traffic-holo', color: NEON[idx % NEON.length], y: 0, geometry: acc.geometry(), emissive: 1.4, opacity: 0.72 }];
}

/** A puffy cloud formation at the origin: 3–6 overlapping soft blobs, seeded shape per cloud.
 *  Rain = dark grey storm deck · snow = pale winter grey. */
function cloudLayers(idx: number, seed: number, s: number, weather: 'clear' | 'rain' | 'snow' = 'clear'): LayoutPreviewLayer[] {
    const acc = new Accum3D();
    const H = (a: number, b: number): number => hash2(idx * 13.7 + a, b * 7.1, (seed ^ 0xc10d) >>> 0);
    const n = 3 + (H(1, 1) * 4) | 0;
    const big = weather === 'clear' ? 1 : 1.45;   // storm/winter clouds are fat, flat slabs that merge into a deck
    const spread = (0.35 + H(2, 2) * 0.5) * s * big;
    for (let k = 0; k < n; k++) {
        const ox = (H(k, 3) - 0.5) * spread * 2, oz = (H(k, 4) - 0.5) * spread * (weather === 'clear' ? 0.8 : 1.2), oy = (H(k, 5) - 0.3) * 0.06 * s;
        const r = (0.14 + H(k, 6) * 0.16) * s * big;
        acc.blob([ox, oy, oz], r * 1.5, r * (weather === 'clear' ? 0.55 : 0.42), r, 0.25, idx * 31 + k * 7);
    }
    // Rain = DARK slate storm cloud; snow = pale winter grey; clear = white puffies.
    const color: [number, number, number] = weather === 'rain' ? [0.40, 0.42, 0.48] : weather === 'snow' ? [0.80, 0.82, 0.86] : [0.97, 0.97, 1.0];
    return [{
        name: 'world:traffic-cloud', color, y: 0,
        geometry: acc.geometry(), emissive: weather === 'rain' ? 0.2 : weather === 'snow' ? 0.55 : 0.75, opacity: weather === 'clear' ? 0.88 : 0.95,
    }];
}

const nrm2 = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

/** A car at the origin, nose ALONG +X (faceRoute yaws it to its route). Upgraded silhouette + round wheels +
 *  chrome + HEAD/TAIL LIGHTS (glow hard at night via the glow walk) — see vehicle.ts. `type` picks the shape:
 *  a modern `sedan`, an old-school long-hood `classic`, or a yellow checker `taxi`. */
function carLayers(colorIdx: number, s: number, type: VehicleType = 'sedan'): LayoutPreviewLayer[] {
    const acc = makeVehicleAcc();
    emitVehicle(acc, [0, 0, 0], [1, 0, 0], [0, 0, 1], s, type);
    const bodyColor = type === 'taxi' ? VEH_TAXI : CARBODY[colorIdx];
    return vehicleLayers(acc, type === 'taxi' ? 'world:traffic-taxi' : 'world:traffic-car', bodyColor);
}

/** A BUS at the origin, nose ALONG +X (faceRoute): upgraded single-deck body + window band + lights (vehicle.ts). */
function busLayers(s: number): LayoutPreviewLayer[] {
    const acc = makeVehicleAcc();
    emitVehicle(acc, [0, 0, 0], [1, 0, 0], [0, 0, 1], s, 'bus');
    return vehicleLayers(acc, 'world:traffic-bus', [0.36, 0.62, 0.50]);
}

/** A TOY AIRLINER at the origin ALONG +X (faceRoute yaws it): plump rounded fuselage, swept mint low wings,
 *  two underslung engine nacelles, tall swept tail fin + stabilizers, and a red beacon on the fin (reuses the
 *  taillight layer name so it glows at night). The chunky bath-toy look — reads at altitude. */
function planeLayers(s: number): LayoutPreviewLayer[] {
    const body = new Accum3D(), wing = new Accum3D(), beacon = new Accum3D();
    const L = 0.13 * s;                                          // half-length
    // Fuselage: three overlapping blobs — plump mid, rounded nose, tapering tail.
    body.blob([0.02 * s, 0, 0], L * 0.85, 0.034 * s, 0.034 * s, 0.1, 3);
    body.blob([L * 0.78, 0.002 * s, 0], 0.045 * s, 0.030 * s, 0.030 * s, 0.05, 5);      // nose
    body.blob([-L * 0.82, 0.008 * s, 0], 0.05 * s, 0.022 * s, 0.022 * s, 0.05, 7);      // tail taper (rises a touch)
    // Swept LOW WINGS (mint): root forward at the belly, tip rearward + outward + slightly up.
    for (const sz of [-1, 1]) {
        wing.quad4([0.045 * s, -0.014 * s, sz * 0.02 * s], [-0.025 * s, -0.014 * s, sz * 0.024 * s],
            [-0.085 * s, -0.002 * s, sz * 0.125 * s], [-0.052 * s, -0.002 * s, sz * 0.125 * s]);
        // Engine nacelle slung under each wing.
        body.blob([0.005 * s, -0.024 * s, sz * 0.062 * s], 0.028 * s, 0.015 * s, 0.015 * s, 0.05, 11 + sz);
    }
    // Tall swept TAIL FIN + horizontal stabilizers (mint).
    wing.quad4([-L * 0.62, 0.02 * s, 0], [-L * 1.02, 0.02 * s, 0], [-L * 1.18, 0.085 * s, 0], [-L * 0.95, 0.085 * s, 0]);
    for (const sz of [-1, 1]) {
        wing.quad4([-L * 0.75, 0.022 * s, sz * 0.008 * s], [-L * 1.0, 0.022 * s, sz * 0.01 * s],
            [-L * 1.12, 0.03 * s, sz * 0.062 * s], [-L * 0.92, 0.03 * s, sz * 0.062 * s]);
    }
    beacon.blob([-L * 1.06, 0.09 * s, 0], 0.006 * s, 0.006 * s, 0.006 * s, 0, 0);        // red beacon on the fin
    return [
        { name: 'world:traffic-plane', color: [0.93, 0.92, 0.87], y: 0, geometry: body.geometry() },
        { name: 'world:traffic-plane-wing', color: [0.72, 0.88, 0.86], y: 0, geometry: wing.geometry() },
        { name: 'world:traffic-taillight', color: [0.9, 0.14, 0.10], y: 0, geometry: beacon.geometry(), emissive: 0.6 },
    ];
}

/** A tiny BIRD at the origin ALONG +X (birds ride closed path loops and yaw with them): body + swept wings. */
function birdLayers(s: number): LayoutPreviewLayer[] {
    const acc = new Accum3D();
    acc.blob([0, 0, 0], 0.009 * s, 0.004 * s, 0.004 * s, 0, 0);   // body (long axis = +X flight dir)
    for (const sz of [-1, 1]) acc.quad4([0.002 * s, 0.001 * s, 0], [-0.004 * s, 0.001 * s, 0], [-0.009 * s, 0.004 * s, sz * 0.012 * s], [0.000 * s, 0.004 * s, sz * 0.012 * s]);   // swept wings
    return [{ name: 'world:traffic-bird', color: [0.24, 0.25, 0.30], y: 0, geometry: acc.geometry() }];
}

/** One SNOW cluster at the origin: a merged sheet of small round flakes over a `half`-sized square. */
function snowLayers(idx: number, seed: number, s: number, half: number): LayoutPreviewLayer[] {
    const acc = new Accum3D();
    const H = (a: number, b: number): number => hash2(idx * 19.1 + a, b * 6.7, (seed ^ 0x60aa) >>> 0);
    for (let k = 0; k < 30; k++) {
        const ox = (H(k, 1) - 0.5) * half * 2, oz = (H(k, 2) - 0.5) * half * 2, oy = H(k, 3) * 0.5 * s;
        const r = (0.0028 + H(k, 4) * 0.002) * s;
        acc.blob([ox, oy, oz], r, r, r, 0, 0);
    }
    return [{ name: 'world:traffic-snow', color: [0.97, 0.97, 1.0], y: 0, geometry: acc.geometry(), emissive: 0.7, opacity: 0.85 }];
}

/** One SAKURA-PETAL cluster at the origin: a sparse handful of tiny pink flecks that flutter down slowly. */
function petalLayers(idx: number, seed: number, s: number): LayoutPreviewLayer[] {
    const acc = new Accum3D();
    const H = (a: number, b: number): number => hash2(idx * 23.3 + a, b * 9.1, (seed ^ 0x77f4) >>> 0);
    for (let k = 0; k < 12; k++) {
        const ox = (H(k, 1) - 0.5) * 0.7 * s, oz = (H(k, 2) - 0.5) * 0.7 * s, oy = H(k, 3) * 0.3 * s;
        acc.blob([ox, oy, oz], 0.0035 * s, 0.0012 * s, 0.0028 * s, 0, 0);
    }
    return [{ name: 'world:traffic-petal', color: [0.96, 0.74, 0.82], y: 0, geometry: acc.geometry(), opacity: 0.9 }];
}

/** A walker at the origin (clothing prism + skin head) + a hidden CHAT EMOTE bubble above the head — the
 *  encounter system toggles its visibility when two walkers stop to talk. `robot` (cyber suite) swaps in a
 *  chrome chassis, a boxy head and a glowing cyan visor — they stroll (and chat!) among the humans. */
function walkerLayers(clothIdx: number, s: number, robot = false): LayoutPreviewLayer[] {
    const body = new Accum3D(), head = new Accum3D(), emote = new Accum3D(), visor = new Accum3D();
    // Real human height (~1.6 m); matches the static crowd in pedestrians.ts (was 0.042·s ≈ 0.85 m, half-scale).
    const bh = 0.088 * s;
    body.prism([0, 0, 0], 0.0092 * s, 0.0073 * s, bh, robot ? 4 : 5);
    if (robot) {
        head.obox([0, bh + 0.009 * s, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.0078 * s, 0.0082 * s, 0.0078 * s);
        visor.obox([0, bh + 0.011 * s, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.0082 * s, 0.0019 * s, 0.0082 * s);   // glowing eye band
    } else head.blob([0, bh + 0.009 * s, 0], 0.0088 * s, 0.0098 * s, 0.0088 * s, 0, 0);
    emote.blob([0, bh + 0.032 * s, 0], 0.011 * s, 0.008 * s, 0.006 * s, 0, 0);        // speech bubble
    emote.blob([0.004 * s, bh + 0.021 * s, 0], 0.0022 * s, 0.0022 * s, 0.002 * s, 0, 0);   // bubble tail dot
    return [
        { name: 'world:traffic-walker', color: robot ? [0.72, 0.75, 0.80] : CLOTHES[clothIdx], y: 0, geometry: body.geometry() },
        { name: 'world:traffic-walker-skin', color: robot ? [0.60, 0.63, 0.68] : SKIN, y: 0, geometry: head.geometry() },
        ...(robot ? [{ name: 'world:traffic-robot-visor', color: [0.3, 0.95, 1.0] as [number, number, number], y: 0, geometry: visor.geometry(), emissive: 1.3 }] : []),
        { name: 'world:traffic-emote', color: [0.98, 0.97, 0.92], y: 0, geometry: emote.geometry(), emissive: 0.9 },
    ];
}

/** ONE train car at the origin ALONG +X, deck height BAKED (the viaduct is level). The consist is articulated:
 *  the ticker clones this car `TRAIN_CARS` times and places each at its own arc-length, yawed to the local track
 *  heading — so the back cars follow the rails around a curve instead of clipping off the outside. */
export const TRAIN_CARS = 4, TRAIN_CAR_L = 0.32, TRAIN_CAR_GAP = 0.02;
function trainLayers(deckY: number, s: number): LayoutPreviewLayer[] {
    const body = new Accum3D(), win = new Accum3D();
    const xA: V3 = [1, 0, 0], up: V3 = [0, 1, 0], zA: V3 = [0, 0, 1];
    const carL = TRAIN_CAR_L * s, cy = deckY + 0.052 * s, w = 0.06 * s;
    body.obox([0, cy, 0], xA, up, zA, carL, 0.042 * s, w * 0.82);
    win.obox([0, cy + 0.012 * s, 0], xA, up, zA, carL * 0.92, 0.015 * s, w * 0.86);
    return [
        { name: 'world:traffic-train', color: TRAIN, y: 0, geometry: body.geometry() },
        { name: 'world:traffic-train-win', color: TRAIN_DK, y: 0, geometry: win.geometry(), emissive: 0.7 },
    ];
}
