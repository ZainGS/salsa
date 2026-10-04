// ── World generation — traffic (the moving-city sim, v1) ────────────────────────────────────────
// Computes MOVER SPECS: cars + buses and walkers + cyclists ROUTED over the intersection graph (route-sim.ts — cars
// turn at junctions and stop at red lights, walkers keep to the pavements and cross on the zebras), a moving train
// on the viaduct, clouds / weather / birds / ducks. Each mover = archetype geometry built at the ORIGIN along +X
// (shared per archetype → instanced draws); the WorldManager spawns them and the WorldTraffic ticker drives them
// every frame, lifting Y with the terrain. Pure + deterministic; the per-frame ticking lives bridge-side.

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { Accum3D } from './meshbuild';
import { makeVehicleAcc, emitVehicle, vehicleLayers, vehicleHalfLength, VEH_TAXI, type VehicleType, type VehicleAcc } from './vehicle';
import { twinAccum, withFarTwin, PROP_TWIN_M } from './lod-accum';
import { hash2 } from './util';
import * as RW from './railway';
import { terraceStep } from './elevation';
import { duckFlotillaLayers, duckGarpPool, DUCK_COLORWAYS } from './ducks';
import { pickSkin } from './garp';
import { cityMetresPerUnit } from './types';
import { roadNet } from './route-sim';
import { pavementLift } from './street-slots';
import { cloudCard } from './sky';
import { footfallField, umbrellaFor, crowdLayer } from './pedestrians';
import { walkerParts, personLook, archetypeIndex, type PersonLook, type PedColor } from './mannequin';
import { railConsists, railTrackInfo, type RailStationIn, type TrainRunPlan, type TrainRunState } from './train';
import { localConsist } from './local-line-build';

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
    cars?: {
        count: number; spacing: number;
        /** Per-car layer VARIANTS (the EMU: cab / mid / pantograph cars) — car c uses `variants[pick[c]]` instead of
         *  `layers`; `flip[c]` turns the car 180° (the rear cab faces backward). */
        variants?: LayoutPreviewLayer[][]; pick?: number[]; flip?: boolean[];
    };
    /** RAIL RUN (railway-upgrade R2.2): the consist runs a station-stop schedule (train.ts stepTrainRun — accelerate,
     *  cruise, brake to a stop centred at each station, dwell with the doors open, reverse at the termini) instead of
     *  a pingPong shuttle. Arc positions are world units from `a` along a→b. */
    run?: {
        plan: TrainRunPlan; start: TrainRunState;
        /** railway-upgrade R3.2 — the AT-GRADE local consist: rail-top Y per path point (the ticker lifts + pitches each
         *  car on its bogies), the short car's bogie half-spacing + door slide (world units), and the marker the level
         *  crossings read their train from. */
        heights?: number[]; bogieHalf?: number; doorSlide?: number; local?: boolean;
    };
    /** ROUTED mover (cars / walkers over the road graph — route-sim.ts): the starting directed `edge`, pavement
     *  `side` (walkers; +1 = left of travel), start fraction `t` along the first leg, a stable `id` for the hash-driven
     *  turn choices, and the vehicle half-length (cars stop their FRONT at the stop line). Overrides a/b/t0/lane. */
    route?: { mode: 'car' | 'walk'; edge: number; side: 1 | -1; t: number; id: number; halfLen: number; bus?: boolean };
    /** Uniform scale of every mesh of this mover (walker height variety on shared geometry). */
    scale?: number;
    /** LEG SWING (no shader): the `…-legL` / `…-legR` layers are built in hip-pivot space; the ticker places them at
     *  (0, pivotY, ±pivotZ) in the mover frame and rotates them about local Z by ±amp·sin(phase), the phase advancing
     *  one stride per `stride` world units walked. `arm` (optional): the `…-armL` / `…-armR` layers are built in
     *  shoulder-pivot space and swing OPPOSITE their same-side leg by `amp`× the leg angle (natural arm swing); the
     *  `…-handL` / `…-handR` skin layers swing with them. `knee` (optional): the `…-shinL` / `…-shinR` (+ `…-shoeL` /
     *  `…-shoeR`) layers are built in KNEE-pivot space — the ticker hangs them at the thigh's knee (x, y from the hip) and
     *  bends the knee through the cycle (`flex` peak radians: folded in swing, nearly straight at heel strike, a little
     *  give on loading), sinking the body so the lower foot (heel / toe points, from the knee) stays on the ground —
     *  the walking bob falls out of the leg geometry. `pedal`: a cyclist — the knee follows the crank, no ground
     *  contact / bob. All in world units. */
    gait?: {
        pivotY: number; pivotZ: number; stride: number; amp: number; arm?: { y: number; z: number; amp: number };
        knee?: { x: number; y: number; heel: [number, number]; toe: [number, number]; flex: number; pedal?: boolean };
    };
}

/** Frame-cost caps on the routed movers (the static crowd carries the density beyond these). */
export const MAX_CARS = 64, MAX_WALKERS = 240;

const CARBODY: [number, number, number][] = [[0.86, 0.86, 0.88], [0.22, 0.24, 0.28], [0.68, 0.22, 0.20], [0.22, 0.38, 0.58], [0.90, 0.78, 0.30]];
const DARK: [number, number, number] = [0.10, 0.11, 0.13];

/** All movers for a graph: routed cars + buses + walkers + cyclists, the train, the sky / weather / wildlife. */
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
        if (!l) { l = build().map(L => ({ ...L, instanceKey: `${key}:${L.name}${L.nearTwin ? ':' + L.nearTwin.role : ''}` })); geoCache.set(key, l); }   // P9: near / far twins never share a pool entry
        return l;
    };

    const weather = p.weather ?? 'clear';
    const wcache = new Map<string, ReturnType<typeof buildWalkerArchetype>>();
    const walkerArchetype = (look: PersonLook, u: number, umb: PedColor | null, bike: boolean, lookKey: string): ReturnType<typeof buildWalkerArchetype> => {
        const k = `${lookKey}:${umb}:${bike}:${u}`;
        let w = wcache.get(k); if (!w) { w = buildWalkerArchetype(look, u, umb, bike); wcache.set(k, w); } return w;
    };

    // ── CARS + BUSES route over the intersection graph (route-sim.ts) ─────────────────────────────────────
    // Spawned on evenly spaced slots along the passable car edges (deterministic per seed); the ticker drives each
    // along its lane, picks straight / left / right at every junction and stops at red lights + stop signs. Count
    // scales with the road network (≈ one car per 1.9·s of carriageway, both directions), capped for frame cost.
    const net = roadNet(graph);
    const night = !!p.nightMode;
    if ((p.traffic ?? true) && net.carEdges.length) {
        const totalLen = net.carEdges.reduce((n, e) => n + net.edges[e].len, 0);
        // visual-polish #16: `trafficDensity` (× the count; absent = 1, the original) also lifts the cap with it (to 2×).
        const carMul = Math.min(Math.max(0, p.trafficDensity ?? 1), 3);
        const nCars = Math.min(Math.round(MAX_CARS * Math.min(2, Math.max(1, carMul))), Math.round(totalLen / (1.9 * s) * carMul * (night ? 0.7 : 1)));
        const used = new Set<number>();
        const arterials = net.carEdges.filter(e => net.edges[e].arterial);
        for (let k = 0; k < nCars; k++) {
            const isBus = k % 9 === 4 && arterials.length > 0;
            const pool = isBus ? arterials : net.carEdges;
            let edge = pool[(H(k, 1, 0xca11) * pool.length) | 0];
            for (let tries = 0; tries < 6 && used.has(edge); tries++) edge = pool[(H(k, 2 + tries, 0xca12) * pool.length) | 0];
            if (used.has(edge)) continue;   // one spawn per directed edge → no two cars born on top of each other
            used.add(edge);
            const t = 0.15 + H(k, 9, 0x77aa) * 0.5;
            if (isBus) {
                out.push({
                    kind: 'car', a: net.edges[edge].a, b: net.edges[edge].b, t0: 0, speed: 0.3 * s, lane: 0, baseY: gy, faceRoute: true,
                    route: { mode: 'car', edge, side: 1, t, id: k, halfLen: 0.33 * s, bus: true },
                    layers: arch('bus', () => [...busLayers(s, p.propTwins), ...headPoolLayers(s, 0.3)]),
                });
                continue;
            }
            const colorIdx = (H(k, 3, 0x90ce) * CARBODY.length) | 0;
            // Vehicle mix (Round 4 lofted bodies): ~9% TAXIS, ~11% 80s CLASSICS, ~15% HATCHES, ~12% KEI wagons,
            // ~7% kei VANS, the rest 90s 4-door SEDANS (the P5 street-car staple).
            const vt = H(k, 4, 0x5a7c);
            const type: VehicleType = vt < 0.09 ? 'taxi' : vt < 0.20 ? 'classic' : vt < 0.35 ? 'hatch' : vt < 0.47 ? 'kei' : vt < 0.54 ? 'van' : 'sedan';
            const key = type === 'taxi' ? 'taxi' : type + colorIdx;   // share geometry per (type,colour)
            out.push({
                kind: 'car', a: net.edges[edge].a, b: net.edges[edge].b, t0: 0,
                speed: (0.42 + H(k, 5, 0x1f2d) * 0.22) * s, lane: 0, baseY: gy, faceRoute: true,
                route: { mode: 'car', edge, side: 1, t, id: k, halfLen: vehicleHalfLength(type, s) },
                layers: arch(key, () => [...carLayers(colorIdx, s, type, p.propTwins), ...headPoolLayers(s, vehicleHalfLength(type, s) / s)]),
            });
        }
    }

    // ── WALKERS + CYCLISTS route over the pavements (both sides of every walkable road) ───────────────────
    // Spawn density follows the FOOTFALL field (station / shops / junctions busier; thinner at night). Each keeps to its
    // pavement, turns corners, crosses on the zebras and waits for the green man at signalled junctions.
    if (net.walkEdges.length) {
        const field = footfallField(graph);
        const u = 1 / cityMetresPerUnit(p.radius);
        const cap = Math.round(MAX_WALKERS * walkMul / 4 + 60);
        let nW = 0, nBikes = 0;
        const umbAll = (i: number): PedColor | null => umbrellaFor(weather, H(i, 71, 0x0b0b), H(i, 72, 0x0b0c));
        // Wanted walkers per road from the footfall field, then ONE global scale to the cap — so the cap thins the
        // whole city evenly instead of filling the first roads in scan order and leaving the rest empty.
        const fwd = net.walkEdges.filter(e => net.edges[e].forward);   // one pass per road; each spawn picks a direction + side
        const wants = fwd.map(e => {
            const E = net.edges[e], mid: V2 = [(E.a[0] + E.b[0]) * 0.5, (E.a[1] + E.b[1]) * 0.5];
            return E.len / (1.05 * s) * walkMul * (night ? 0.6 : 1) * Math.min(2.2, field(mid[0], mid[1]));
        });
        const wantTotal = wants.reduce((n, v) => n + v, 0), scaleW = wantTotal > cap ? cap / wantTotal : 1;
        for (let wi = 0; wi < fwd.length; wi++) {
            const e = fwd[wi], E = net.edges[e];
            const want = wants[wi] * scaleW;
            const n = Math.floor(want) + (H(e, 1, 0x3b31) < want - Math.floor(want) ? 1 : 0);
            for (let j = 0; j < n && nW < cap; j++, nW++) {
                const i = e * 7 + j;
                const dir = H(i, 2, 0x44d1) < 0.5 ? e : E.rev, side: 1 | -1 = H(i, 3, 0x44d2) < 0.5 ? 1 : -1;
                const robot = (p.holograms ?? false) && H(i, 4, 0x0b07) < 0.2;
                const bike = !robot && nBikes < Math.round(10 * walkMul) && H(i, 5, 0xb1ce) < 0.08;
                if (bike) nBikes++;
                const look = WALKER_LOOKS[(H(i, 6, 0x24fa) * WALKER_LOOKS.length) | 0];
                const umb = bike || robot ? null : umbAll(i);
                const key = robot ? 'robot' : `${look.key}${umb ? ':' + umb : ''}${bike ? ':bike' : ''}`;
                const built = robot ? null : walkerArchetype(look.look, u, umb, bike, look.key);
                out.push({
                    kind: 'walker', a: E.a, b: E.b, t0: 0,
                    speed: (bike ? 0.22 + H(i, 7, 0x51f7) * 0.06 : 0.075 + H(i, 7, 0x51f7) * 0.03) * s,
                    lane: 0, baseY: gy + pavementLift(p), faceRoute: true,
                    route: { mode: 'walk', edge: dir, side, t: H(i, 8, 0x0be5), id: 5000 + i, halfLen: 0 },
                    scale: 0.94 + H(i, 9, 0x5ca1) * 0.12,
                    gait: built ? walkerGait(built, u, bike) : undefined,
                    layers: arch(key, () => robot ? robotLayers(s) : built!.layers),
                });
            }
        }
    }

    // Shotengai strollers — the pedestrian street is BUSY (they shuttle up and down the corridor; the ticker eases
    // their heading and pauses them for a beat at each end instead of flipping 180° on the spot).
    const sg = graph.shotengai;
    if (sg) {
        const u = 1 / cityMetresPerUnit(p.radius);
        for (let i = 0; i < Math.round(9 * walkMul); i++) {
            const look = WALKER_LOOKS[(H(i, 54, 0x33af) * WALKER_LOOKS.length) | 0];
            const umb = umbrellaFor(weather, H(i, 56, 0x0b0b), H(i, 57, 0x0b0c));
            const built = walkerArchetype(look.look, u, umb, false, look.key);
            out.push({
                kind: 'walker', a: sg.spine[0], b: sg.spine[1], t0: H(i, 52, 0x1c44), speed: (0.07 + H(i, 53, 0x6d02) * 0.03) * s,
                lane: (H(i, 51, 0x9ab3) - 0.5) * sg.width * 0.62, baseY: gy + pavementLift(p), pingPong: true, margin: 0.04, faceRoute: true,
                scale: 0.94 + H(i, 58, 0x5ca1) * 0.12,
                gait: walkerGait(built, u, false),
                layers: arch(`${look.key}${umb ? ':' + umb : ''}`, () => built.layers),
            });
        }
    }

    // The moving trains (railway-upgrade R1.5 / R2.2): a real EMU consist per track (opposite directions on a double
    // track) running a station-stop schedule. ARTICULATED: each car is its own clone (cab / mid / pantograph variants)
    // placed at its own arc length by the ticker. Car geometry + the run live in train.ts (shared with the parked train).
    // railStations(p) comes with the structure build (R2.1); until then the run is terminus-to-terminus.
    const stationsOf = (RW as unknown as { railStations?: (q: typeof p) => RailStationIn[] }).railStations;
    for (const c of (p.railway ?? true) ? railConsists(p, railTrackInfo(p, RW.railwayLine(p), typeof stationsOf === 'function' ? stationsOf(p) : [])) : []) {
        out.push({
            kind: 'train', a: c.path[0], b: c.path[c.path.length - 1], path: c.path, t0: 0, speed: c.plan.cruise, lane: 0, baseY: 0,
            layers: c.variants[0], cars: { count: c.count, spacing: c.spacing, variants: c.variants, pick: c.pick, flip: c.flip },
            run: { plan: c.plan, start: c.start },
        });
    }
    // The at-grade LOCAL LINE's short consist (railway-upgrade R3.2/R3.3; `localLine`, off by default): terminus to
    // terminus with the dwell, lifted onto its rails per car (heights) — the level crossings close for it.
    const lc = localConsist(graph);
    if (lc) out.push({
        kind: 'train', a: lc.path[0], b: lc.path[lc.path.length - 1], path: lc.path, t0: 0, speed: lc.plan.cruise, lane: 0, baseY: 0,
        layers: lc.variants[0], cars: { count: lc.count, spacing: lc.spacing, variants: lc.variants, pick: lc.pick, flip: lc.flip },
        run: { plan: lc.plan, start: lc.start, heights: lc.heights, bogieHalf: lc.bogieHalf, doorSlide: lc.doorSlide, local: true },
    });

    // CLOUDS — slow seeded formations drifting across the sky, wrapping well past the border.
    // `cloudDensity` scales the count (≈3 sparse … ≈18 overcast); RAIN/SNOW force a heavy overcast deck.
    const overcast = weather !== 'clear';
    if ((p.clouds ?? true) && !overcast && p.paintedClouds && p.domeClouds) {
        // visual-polish #9: the sky dome paints these clouds (anime cumulus at infinity — never far-clipped or sorted).
    } else if ((p.clouds ?? true) && !overcast && p.paintedClouds) {
        // PAINTED SKY (persona-polish E1): instead of hundreds of small white puffs, a FEW BIG soft painted clouds high
        // up and well out from the city — where an eye-level view actually sees sky (15-40 deg up), drifting slowly on
        // long chords. Crossed soft cards (paintedCloudLayers) + sunlit rim cards; the look's glow walk lights them.
        const R = p.radius, density = p.cloudDensity ?? 0.55;
        const n = Math.max(3, Math.round(4 + density * 10));
        for (let i = 0; i < n; i++) {
            const side = i % 2 ? 1 : -1;
            const zLane = side * R * (1.3 + H(i, 61, 0x40de) * 1.3);
            const alt = R * (1.1 + H(i, 62, 0x2e1a) * 0.6);
            const shape = i % 5;
            out.push({
                kind: 'cloud', a: [-R * 3.4, zLane], b: [R * 3.4, zLane], t0: H(i, 63, 0x7b26),
                speed: (0.02 + H(i, 64, 0x1949) * 0.02) * s, lane: 0, baseY: p.groundY + alt,
                layers: arch(`cloudpaint${shape}${side}`, () => paintedCloudLayers(shape, p.seed, R, side as 1 | -1)),
            });
        }
    } else if (p.clouds ?? true) {
        const R = p.radius, density = p.cloudDensity ?? 0.55;
        // Clear = sparse puffies by the slider; RAIN = a genuinely heavy STORM DECK (30–44 dark clouds);
        // snow = a solid pale winter blanket. Overcast lanes overlap (×0.55 spacing jitter) so the deck closes.
        const nClouds = weather === 'rain' ? Math.round(60 + density * 28)
            : weather === 'snow' || weather === 'overcast' ? Math.round(44 + density * 20)
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
    if (weather === 'rain' || weather === 'snow') {   // (an 'overcast' deck has no precipitation)
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
        const sky = RW.skywayPath(graph);
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

/** A puffy cloud formation at the origin: 3–6 overlapping SOFT puffs (smooth ellipsoids with a flattened base,
 *  so each cloud shades as one painted volume that picks up the sun's colour — polish-round-3 T1.3; they were
 *  faceted octahedron blobs). Seeded shape per cloud. Rain = dark grey storm deck · snow / overcast = pale grey. */
function cloudLayers(idx: number, seed: number, s: number, weather: 'clear' | 'rain' | 'snow' | 'overcast' = 'clear'): LayoutPreviewLayer[] {
    const acc = new Accum3D();
    const H = (a: number, b: number): number => hash2(idx * 13.7 + a, b * 7.1, (seed ^ 0xc10d) >>> 0);
    const n = 3 + (H(1, 1) * 4) | 0;
    const big = weather === 'clear' ? 1 : 1.45;   // storm/winter clouds are fat, flat slabs that merge into a deck
    const spread = (0.35 + H(2, 2) * 0.5) * s * big;
    const X: V3 = [1, 0, 0], Y: V3 = [0, 1, 0], Z: V3 = [0, 0, 1];
    for (let k = 0; k < n; k++) {
        const ox = (H(k, 3) - 0.5) * spread * 2, oz = (H(k, 4) - 0.5) * spread * (weather === 'clear' ? 0.8 : 1.2), oy = (H(k, 5) - 0.3) * 0.06 * s;
        // (clear puffs are ~0.7x the old blob radius: smooth ellipsoids fill their whole footprint, so the same sizes
        //  closed into one solid deck seen from below)
        const r = (0.14 + H(k, 6) * 0.16) * s * big * (weather === 'clear' ? 0.7 : 1);
        // central puffs stand taller (a cumulus crown); every puff shares a flat base
        const crown = 1 - Math.min(1, Math.abs(ox) / Math.max(1e-6, spread)) * 0.5;
        const top = r * (weather === 'clear' ? 0.62 : 0.42) * crown;
        acc.ellipsoid([ox, oy, oz], X, Y, Z, r * 1.5, top, r * 0.16, r, 8, 5);
    }
    const color: [number, number, number] = weather === 'rain' ? [0.40, 0.42, 0.48] : weather === 'snow' ? [0.80, 0.82, 0.86]
        : weather === 'overcast' ? [0.76, 0.78, 0.82] : [0.97, 0.97, 1.0];
    return [{
        name: 'world:traffic-cloud', color, y: 0,
        geometry: acc.geometry(), emissive: weather === 'rain' ? 0.2 : weather === 'clear' ? 0.75 : 0.55, opacity: weather === 'clear' ? 0.88 : 0.95,
        noFog: 'hardEdge',   // fog-horizon follow-up: no fog-coloured blobs past Far under Hard fog edge (soft fog: as before)
    }];
}

/** A BIG PAINTED high cloud (persona-polish E1) at the origin, ~1-2 R across: 2-3 masses, each a few overlapping
 *  soft cards (lumpy silhouette) + a raised RIM card for the sunlit crown. Movers only translate, so the cards are
 *  built FACING THE CITY from their lane side (`side` = sign of the lane z) and tilted ~30 deg to face a viewer below —
 *  an ellipse from anywhere in the city (no crossed-card stars). Transparent + radialFade like the horizon banks;
 *  excluded from the auto-frame. The glow walk tints body (sky) and rim (sun) — see WorldManager paintedClouds. */
function paintedCloudLayers(idx: number, seed: number, R: number, side: 1 | -1): LayoutPreviewLayer[] {
    const body = new Accum3D(), rim = new Accum3D();
    const H = (a: number, b: number): number => hash2(idx * 11.3 + a, b * 5.9, (seed ^ 0xc10e) >>> 0);
    const tilt = 0.5 + H(9, 9) * 0.15;                       // ~29-37 deg
    const tan: V3 = [-side, 0, 0], up: V3 = [0, Math.cos(tilt), -side * Math.sin(tilt)], back: V3 = [0, 0, side];
    const masses = 2 + ((H(1, 1) * 2) | 0);
    const span = R * (0.7 + H(2, 2) * 0.5);
    for (let k = 0; k < masses; k++) {
        const t = (k / (masses - 1) - 0.5) * 2;
        const crown = 1 - Math.abs(t) * 0.4;
        const rx = R * (0.5 + H(k, 3) * 0.3) * crown, ry = rx * (0.4 + H(k, 4) * 0.14);
        const c: V3 = [t * span * 0.7, (H(k, 5) - 0.3) * ry * 0.4, (H(k, 6) - 0.5) * R * 0.15];
        cloudCard(body, c, tan, back, rx, ry, ry * 0.75, 0, up);
        cloudCard(body, c, tan, back, rx * 0.82, ry * 0.82, ry * 0.62, 0, up);   // concentric core (crisper painted edge)
        // two lumps riding on the mass (offset sideways + up) break the ellipse into a cumulus crown
        for (const sx of [-1, 1]) {
            const lx = sx * rx * (0.35 + H(k, 7 + sx) * 0.2), ly = ry * (0.25 + H(k, 10 + sx) * 0.25);
            cloudCard(body, [c[0] + lx, c[1] + up[1] * ly, c[2] + up[2] * ly], tan, back, rx * 0.55, ry * 0.8, ry * 0.6, 0, up);
        }
        cloudCard(rim, [c[0], c[1] + up[1] * ry * 0.45, c[2] + up[2] * ry * 0.45], tan, back, rx * 0.85, ry * 0.85, ry * 0.6, -R * 0.02, up);
    }
    // Body first, rim second: transparent meshes draw in list order, so the sunlit crown blends OVER the body.
    return [
        { name: 'world:traffic-cloud', color: [0.96, 0.95, 0.97], y: 0, geometry: body.geometry(), emissive: 0.5, opacity: 0.92, radialFade: true, excludeFromFrame: true, noFog: 'hardEdge' },
        { name: 'world:traffic-cloud-rim', color: [1.0, 0.98, 0.95], y: 0, geometry: rim.geometry(), emissive: 0.5, opacity: 0.72, radialFade: true, excludeFromFrame: true, noFog: 'hardEdge' },
    ];
}

/** A car at the origin, nose ALONG +X (faceRoute yaws it to its route). Upgraded silhouette + round wheels +
 *  chrome + HEAD/TAIL LIGHTS (glow hard at night via the glow walk) — see vehicle.ts. `type` picks the shape:
 *  a modern `sedan`, an old-school long-hood `classic`, or a yellow checker `taxi`. */
function carLayers(colorIdx: number, s: number, type: VehicleType = 'sedan', twins?: boolean): LayoutPreviewLayer[] {
    const acc = moverAcc(s, twins);
    emitVehicle(acc, [0, 0, 0], [1, 0, 0], [0, 0, 1], s, type);
    const bodyColor = type === 'taxi' ? VEH_TAXI : CARBODY[colorIdx];
    return moverTwins(vehicleLayers(acc, type === 'taxi' ? 'world:traffic-taxi' : 'world:traffic-car', bodyColor), acc, s);
}

/** P9 MOVER DETAIL TIERS: a traffic car's trim (tyres, rubber, grille) and chrome also build a cheap FAR TWIN
 *  (lod-accum.ts), swapped at PROP_TWIN_M.carTrim like the parked cars'; WorldManager.cityDistanceTiers also gives
 *  the trim / chrome / lenses the small-props draw distance. World param `propTwins: false` = the pre-P9 movers. */
function moverAcc(s: number, twins: boolean | undefined): VehicleAcc {
    const acc = makeVehicleAcc(), u = 1 / cityMetresPerUnit(s * 10);
    acc.trim = twinAccum(PROP_TWIN_M.carTrim, u, twins); acc.chrome = twinAccum(PROP_TWIN_M.carTrim, u, twins);
    return acc;
}
/** Split a mover's trim / chrome layers into near / far twins. A mover is not chunked, so both twins get the SAME
 *  precomputed box (the near geometry's): their swap decisions then agree exactly. */
function moverTwins(layers: LayoutPreviewLayer[], acc: VehicleAcc, s: number): LayoutPreviewLayer[] {
    const u = 1 / cityMetresPerUnit(s * 10), out: LayoutPreviewLayer[] = [];
    for (const L of layers) {
        const src = L.name === 'world:veh-trim' ? acc.trim : L.name === 'world:veh-chrome' ? acc.chrome : null;
        const pair = src ? withFarTwin(L, src, L.name, PROP_TWIN_M.carTrim, u) : [L];
        if (pair.length === 2) { const b = boundsOf(pair[0].geometry.vertices); (pair[0].geometry as { bounds?: Float32Array }).bounds = b; (pair[1].geometry as { bounds?: Float32Array }).bounds = Float32Array.from(b); }
        out.push(...pair);
    }
    return out;
}
function boundsOf(v: Float32Array): Float32Array {
    const b = Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    for (let i = 0; i < v.length; i += 12) for (let k = 0; k < 3; k++) { if (v[i + k] < b[k]) b[k] = v[i + k]; if (v[i + k] > b[k + 3]) b[k + 3] = v[i + k]; }
    return b;
}

/** A BUS at the origin, nose ALONG +X (faceRoute): upgraded single-deck body + window band + lights (vehicle.ts). */
function busLayers(s: number, twins?: boolean): LayoutPreviewLayer[] {
    const acc = moverAcc(s, twins);
    emitVehicle(acc, [0, 0, 0], [1, 0, 0], [0, 0, 1], s, 'bus');
    return moverTwins(vehicleLayers(acc, 'world:traffic-bus', [0.36, 0.62, 0.50]), acc, s);
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

/** ~16 walker LOOKS drawn from the weighted mannequin archetypes (salarymen / uniforms / casual / elders …). A small
 *  fixed pool so every walker of a look SHARES its part geometries (instanced draws); per-walker height scale +
 *  routes supply the rest of the variety. */
const WALKER_LOOKS: { key: string; look: PersonLook }[] = Array.from({ length: 20 }, (_, i) => {
    const arch = archetypeIndex((i + 0.5) / 20);
    return { key: `wk${i}`, look: personLook(arch, 101 + i * 37) };
});

type WalkerArchetype = { layers: LayoutPreviewLayer[]; pivotY: number; pivotZ: number; armY: number; armZ: number; amp: number; arms: boolean; knee: NonNullable<MoverSpec['gait']>['knee'] };
/** A walker's GAIT from its archetype: legs swing about the hip (smaller steps in a skirt / yukata), FREE arms swing
 *  opposite about the shoulder (0.8× the leg angle); cyclists pedal (bigger, slower cycle) and hold the bars. */
function walkerGait(b: WalkerArchetype, u: number, bike: boolean): NonNullable<MoverSpec['gait']> {
    return {
        pivotY: b.pivotY, pivotZ: b.pivotZ, stride: (bike ? 0.9 : 0.36 * (b.amp / 0.42)) * u, amp: bike ? 0.55 : b.amp,
        ...(b.arms && !bike ? { arm: { y: b.armY, z: b.armZ, amp: 0.8 } } : {}),
        ...(b.knee ? { knee: bike ? { ...b.knee, flex: 0.9, pedal: true } : b.knee } : {}),
    };
}

/** A walker archetype at the origin facing +X: mannequin body parts (rigid), the two swinging LEGS (hip-pivot space,
 *  cloned L/R by name), the FREE ARMS (shoulder-pivot space — a phone / umbrella / briefcase hand stays rigid in the
 *  body), and the hidden CHAT EMOTE bubble the encounter system toggles. All names start `world:traffic-walker`
 *  (the tier-1 LOD + night rules + the flat crowd shading key on that). */
function buildWalkerArchetype(look: PersonLook, u: number, umbrella: PedColor | null, bike: boolean): WalkerArchetype {
    const parts = walkerParts(look, u, umbrella, bike);
    const layers: LayoutPreviewLayer[] = [];
    for (const b of parts.body) if (!b.acc.empty) layers.push({ ...crowdLayer(`world:traffic-walker-${b.part}`, b.pc), y: 0, geometry: b.acc.geometry() });
    layers.push({ ...crowdLayer('world:traffic-walker-legL', parts.leg.pc), y: 0, geometry: parts.leg.accL.geometry() });
    layers.push({ ...crowdLayer('world:traffic-walker-legR', parts.leg.pc), y: 0, geometry: parts.leg.accR.geometry() });
    if (parts.shin) {
        layers.push({ ...crowdLayer('world:traffic-walker-shinL', parts.leg.pc), y: 0, geometry: parts.shin.accL.geometry() });
        layers.push({ ...crowdLayer('world:traffic-walker-shinR', parts.leg.pc), y: 0, geometry: parts.shin.accR.geometry() });
    }
    if (parts.shoe) {
        layers.push({ ...crowdLayer('world:traffic-walker-shoeL', parts.shoe.pc), y: 0, geometry: parts.shoe.accL.geometry() });
        layers.push({ ...crowdLayer('world:traffic-walker-shoeR', parts.shoe.pc), y: 0, geometry: parts.shoe.accR.geometry() });
    }
    if (parts.arm.accL) layers.push({ ...crowdLayer('world:traffic-walker-armL', parts.arm.pc), y: 0, geometry: parts.arm.accL.geometry() });
    if (parts.arm.accR) layers.push({ ...crowdLayer('world:traffic-walker-armR', parts.arm.pc), y: 0, geometry: parts.arm.accR.geometry() });
    if (parts.hand.accL) layers.push({ ...crowdLayer('world:traffic-walker-handL', 'skin'), y: 0, geometry: parts.hand.accL.geometry() });
    if (parts.hand.accR) layers.push({ ...crowdLayer('world:traffic-walker-handR', 'skin'), y: 0, geometry: parts.hand.accR.geometry() });
    const emote = new Accum3D(), top = look.heightM * u;
    emote.blob([0, top + 0.022 * u * 15, 0], 0.011 * u * 15, 0.008 * u * 15, 0.006 * u * 15, 0, 0);          // speech bubble
    emote.blob([0.004 * u * 15, top + 0.011 * u * 15, 0], 0.0022 * u * 15, 0.0022 * u * 15, 0.002 * u * 15, 0, 0);   // tail dot
    layers.push({ name: 'world:traffic-emote', color: [0.98, 0.97, 0.92], y: 0, geometry: emote.geometry(), emissive: 0.9 });
    const kn = parts.knee, flex = 1.0 * (parts.amp / 0.4);
    return {
        layers, pivotY: parts.pivotY * u, pivotZ: parts.pivotZ * u, armY: parts.armY * u, armZ: parts.armZ * u, amp: parts.amp, arms: !!(parts.arm.accL || parts.arm.accR),
        knee: kn ? { x: kn.x * u, y: kn.y * u, heel: [kn.heel[0] * u, kn.heel[1] * u], toe: [kn.toe[0] * u, kn.toe[1] * u], flex } : undefined,
    };
}

/** The cyber-suite ROBOT walker: chrome chassis, boxy head, glowing cyan visor (no legs — it hovers-walks). */
function robotLayers(s: number): LayoutPreviewLayer[] {
    const body = new Accum3D(), head = new Accum3D(), emote = new Accum3D(), visor = new Accum3D();
    const bh = 0.088 * s;
    body.prism([0, 0, 0], 0.0092 * s, 0.0073 * s, bh, 4);
    head.obox([0, bh + 0.009 * s, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.0078 * s, 0.0082 * s, 0.0078 * s);
    visor.obox([0, bh + 0.011 * s, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.0082 * s, 0.0019 * s, 0.0082 * s);   // glowing eye band
    emote.blob([0, bh + 0.032 * s, 0], 0.011 * s, 0.008 * s, 0.006 * s, 0, 0);
    emote.blob([0.004 * s, bh + 0.021 * s, 0], 0.0022 * s, 0.0022 * s, 0.002 * s, 0, 0);
    return [
        { name: 'world:traffic-walker-robot', color: [0.72, 0.75, 0.80], y: 0, geometry: body.geometry() },
        { name: 'world:traffic-walker-robothead', color: [0.60, 0.63, 0.68], y: 0, geometry: head.geometry() },
        { name: 'world:traffic-robot-visor', color: [0.3, 0.95, 1.0], y: 0, geometry: visor.geometry(), emissive: 1.3 },
        { name: 'world:traffic-emote', color: [0.98, 0.97, 0.92], y: 0, geometry: emote.geometry(), emissive: 0.9 },
    ];
}

/** A HEADLIGHT POOL on the road ahead of a car (built along +X like the car): a soft radial-fade disc that the
 *  night-glow walk (`headlight` regex) cranks after dark; the ticker hides it by day. `fwd` = the car's half-length. */
function headPoolLayers(s: number, fwd: number): LayoutPreviewLayer[] {
    const a = new Accum3D();
    a.disc([(fwd + 0.13) * s, 0.005 * s, 0], [0, 1, 0], 0.14 * s, 14);
    return [{ name: 'world:traffic-headlight-pool', color: [1.0, 0.93, 0.74], y: 0, geometry: a.geometry(), emissive: 1.2, opacity: 0.42, radialFade: true }];
}

