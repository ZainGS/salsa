// ── World generation — RAILWAY LAYOUT (the pure half of the elevated railway, docs/specs/railway-upgrade.md) ──────
// Everything here is PURE layout maths — no geometry — so the static viaduct builder (railway.ts), the street plan
// (street-slots.ts: nothing tall under the deck, nothing on a pier / station stair / hall), and the traffic sim's
// moving train (traffic.ts / train.ts / world-traffic.ts) all agree on ONE line, ONE set of tracks and ONE set of
// stations. Real dimensions throughout: every size is given in METRES (RAIL_M) and converted with the city's
// diorama scale (1 unit = cityMetresPerUnit(radius) m — 15 m at the default radius 10).
//
// ★ SPACES. The line is defined in LAYOUT space (x = rx, z0..z1) like every other city feature, but the city is
//   domain-warped at render time (up to ~4.5 m at the default warp 0.35) and the rail layers opt OUT of that warp
//   (noWarp — the rigid viaduct and the train must share one exact coordinate space). So the viaduct is built along
//   the WARPED centreline: `line.path` = warp(rx, z) sampled every RAIL_M.pathStep metres. That keeps the deck over
//   its (warped) street instead of drifting onto the buildings, and it is still pure (warp = f(params)).
//   · Things standing on the GROUND (pier columns, station stairs / halls) are placed at warp(layout point) exactly —
//     the same spot the pavement they stand on renders at.
//   · Things on the DECK use the rigid frame of the warped centreline: railFrameAt(line, z) → point + unit tangent
//     + unit normal (normal = +x-ish, i.e. to the right when heading +z). Track k's centre = frame point +
//     normal × trackOffsets[k]. The train follows railTrackPath(line, k) — a render-space polyline, noWarp.
//   · `z` in every API is the LAYOUT z along the line (it parameterises the path; station z's use it too).

import type { ArcadeBayKind, BorderShape, LayoutParams, Lot, V2, WorldGraph, Zone } from './types';
import { cityMetresPerUnit } from './types';
import { borderPolygon, bounds, centroid, clipSegmentToConvex, hash2, pointInPolygon, polyArea } from './util';
import { cellLevelAt, makeHeightField, makeElevation, rawTerraceLevels, terraceStep } from './elevation';
import { makeDomainWarpInto } from './warp';
import { gridLotRegion, streetBandHalf, streetDims } from './street-layout';

/** Real railway dimensions in METRES (narrow-gauge Japanese commuter line on a concrete viaduct). */
export const RAIL_M = {
    deckAboveGround: 7.5,     // deck top over flat ground
    deckClearance: 6.8,       // minimum deck-top height over the HIGHEST terrain point along the line
    deckHalfW: 5.0,           // double-track deck ~10 m wide
    deckDepth: 1.2,           // box-girder depth at the centre
    gauge: 1.067,             // Cape gauge (inner faces of the rail heads)
    trackCentres: 4.0,
    ballastH: 0.30,           // ballast / slab-track bed on the deck
    sleeperL: 2.0, sleeperW: 0.20, sleeperH: 0.14, sleeperSink: 0.04, sleeperPitch: 0.62,
    railPad: 0.01, railH: 0.165, railHeadHalf: 0.0325,
    contactAboveRail: 5.0,    // contact wire height over rail top (pantograph reach)
    systemHeight: 1.1,        // messenger above contact at the supports
    parapetH: 1.25, parapetT: 0.28,
    barrierH: 0.8,            // noise-barrier panels on top of the parapet (some runs)
    platformAboveDeck: 1.6,   // ≈ 1.03 m over rail top (EMU floor height)
    platformEdge: 3.57,       // platform edge from the line centre (track 2.0 + car half-width 1.45 + gap)
    platformMaxW: 3.5,
    carLen: 20, stationPad: 6,
    pierSpanMax: 24,
    pathStep: 3,              // centreline sampling (m) — the warp is smooth; chord error < 1 cm
    stairPitchDeg: 34, stairW: 1.5, hallLen: 5.5,
} as const;

/** The railway ARCADE (railway-upgrade R3.1, `railViaduct: 'arcade'`), metres. The line runs BESIDE its road over
 *  the adjacent lot strip: the arcade's street face stands just behind the lot line, the deck cantilevers ~1.2 m out
 *  over the pavement (the shaded footway under a Tokyo viaduct), and the strip's lots are claimed for the bays. */
export const ARC_M = {
    front: 0.2,        // arcade street face behind the lot line
    centre: 4.0,       // line centre from the lot line (deck ±5 m → 1 m over the pavement, 9 m into the strip)
    depth: 8.6,        // street face → back face
    claim: 9.9,        // lot strip claimed from the lot line (covers a station's 5.85 m wing too)
    minRemain: 4.0,    // a lot trimmed by the claim keeps ≥ 4 m of depth, else it is claimed whole
    bay: 10,           // target bay pitch (8–12 m)
    pier: 0.9,         // bay (cross) wall thickness
    endPier: 1.3,      // the wall closing a run at a cross street
    slab: 0.6,         // deck slab depth over the arcade (the walls carry it)
    girder: 1.3,       // plate girders carrying the slab over a cross street / canal (below the slab)
    shopSet: 0.45,     // shopfront plane behind the arcade face
} as const;

/** Viaduct style actually used: 'arcade' only on grid cities (radial has no lot strip beside a straight road). */
export type RailViaduct = 'portal' | 'arcade';
export function railViaductMode(p: { railViaduct?: string; pattern: string }): RailViaduct {
    return p.railViaduct === 'arcade' && p.pattern === 'grid' ? 'arcade' : 'portal';
}

/** Metro-entrance kiosk footprint (metres): half-length along the road, half-width across (street-slots reserves it,
 *  metro.ts builds it). */
export const METRO_HALF_LEN_M = 2.6;
export const METRO_HALF_W_M = 0.78;

/** Rail-top height above the deck top (m): ballast + sleeper (sunk a little) + pad + rail. */
export const RAIL_TOP_M = RAIL_M.ballastH + RAIL_M.sleeperH - RAIL_M.sleeperSink + RAIL_M.railPad + RAIL_M.railH;

/** The params the line reads (a subset of LayoutParams, so callers can pass the full set). */
export type RailLineParams = {
    seed: number; gridCols: number; gridRows?: number; pattern: string; radius: number; groundY: number;
    border: BorderShape; borderSides: number;
    elevation?: number; terrainSeed?: number; warp?: number;
    railway?: boolean; stations?: boolean; railCars?: number;
    railViaduct?: 'portal' | 'arcade'; terraces?: boolean; streetWidth?: number; arterialWidth?: number;
    /** Tiled worlds (P10.A1): a neighbour tile's world offset + the world's warp seed (types.ts LayoutParams). */
    tileOrigin?: [number, number]; warpSeed?: number;
};

/** The viaduct line. `rx`/`z0`/`z1` are LAYOUT space (see the header); `path` is the render-space centreline. */
export interface RailLine {
    rx: number; z0: number; z1: number;
    /** Deck TOP surface Y (world units, level along the whole line). */
    deckY: number;
    tracks: number;
    /** Lateral offsets of each track centre from the centreline, world units (along railFrameAt's normal). */
    trackOffsets: number[];
    /** Top of rail — where the wheels sit (world units). */
    railTopY: number;
    /** Track gauge (inner rail-head faces), world units. */
    gaugeU: number;
    /** Contact-wire height (world units) — the pantograph's working height. */
    contactY: number;
    /** World units per metre for this city. */
    unitsPerMetre: number;
    /** Render-space (pre-warped) centreline polyline, and the layout z of each point. */
    path: V2[]; pathZ: number[];
    /** How it is carried (R3.1): 'portal' = over the road at `roadX`; 'arcade' = beside it, over the lot strip on
     *  `side` (±1 along x), centre `rx` = roadX + side·(lot line + ARC_M.centre). */
    mode: RailViaduct; roadX: number; side: 1 | -1;
}

const lineCache = new Map<string, RailLine>();

/** The viaduct line for a params set — shared by the static build AND the traffic sim's moving train.
 *  The span is CLIPPED to the city border so the viaduct doesn't stick out of a circle/hex silhouette.
 *  Pure (params only) + memoised. */
export function railwayLine(p: RailLineParams): RailLine {
    const mode = railViaductMode(p);
    const key = [p.seed, p.gridCols, p.gridRows ?? '', p.pattern, p.radius, p.groundY, p.border, p.borderSides, p.elevation ?? '', p.terrainSeed ?? '', p.warp ?? '',
        p.terraces ?? '', mode, p.streetWidth ?? '', p.arterialWidth ?? '', p.tileOrigin?.[0] ?? 0, p.tileOrigin?.[1] ?? 0, p.warpSeed ?? ''].join('|');
    const hit = lineCache.get(key);
    if (hit) return hit;
    const R = p.radius, cols = Math.max(2, p.gridCols | 0);
    // P10.A1: a neighbour tile's line sits at ITS offset (layout space of the offset tile graph), not on the centre city.
    const ox = p.tileOrigin?.[0] ?? 0, oz = p.tileOrigin?.[1] ?? 0;
    const col = 2 + ((p.seed >>> 3) % Math.max(1, cols - 4));
    const roadX = ox + (p.pattern === 'grid' ? -R + col * (2 * R / cols) : R * 0.18);   // over a grid road line (piers land on the street)
    const u = 1 / cityMetresPerUnit(R);
    // ARCADE (R3.1): beside the road, over the lot strip on a seeded side.
    const side: 1 | -1 = ((Math.imul(p.seed | 0, 0x9e3779b1) >>> 0) & 0x100) ? 1 : -1;
    const rx = mode === 'arcade' ? roadX + side * (streetBandHalf(p as unknown as LayoutParams) + ARC_M.centre * u) : roadX;
    let z0 = oz - R * 0.94, z1 = oz + R * 0.94;
    const border = borderPolygon(p.border, R * 0.97, p.borderSides).map(q => [q[0] + ox, q[1] + oz] as V2);
    const seg = clipSegmentToConvex([rx, z0], [rx, z1], border);
    if (seg) { z0 = seg[0][1]; z1 = seg[1][1]; }
    if (z0 > z1) { const t = z0; z0 = z1; z1 = t; }
    // Centreline: the warped road line, sampled every pathStep metres (+ the exact ends).
    const warp = makeDomainWarpInto(p as unknown as LayoutParams);
    const n = Math.max(2, Math.ceil((z1 - z0) / (RAIL_M.pathStep * u)));
    const path: V2[] = [], pathZ: number[] = [];
    const w: [number, number] = [0, 0];
    for (let i = 0; i <= n; i++) {
        const z = z0 + (z1 - z0) * i / n;
        warp(rx, z, w);
        path.push([rx + w[0], z + w[1]]); pathZ.push(z);
    }
    // Deck height: LEVEL along the whole line (rail-* layers are routed with no height field). 7.5 m over flat ground,
    // raised so it still clears the highest ground under the deck by deckClearance — the smooth terrain AND the
    // discrete terrace levels (R3.1: a raised terrace under the line used to eat up to 4.8 m of headroom). Sampled
    // across the deck width: over a road the street band sits at the LOWER of its two cells (cellLevelAt), over the
    // arcade's lot strip at the cell's own level. (Canal cells read their raw level here — conservative.)
    const hf = makeHeightField(p as unknown as LayoutParams);
    const levels = p.pattern === 'grid' ? rawTerraceLevels(p as unknown as LayoutParams, borderPolygon(p.border, R, p.borderSides)) : null;
    const lite = { params: p as unknown as LayoutParams, radius: R, levels };
    const step = terraceStep(p as unknown as LayoutParams), hw = RAIL_M.deckHalfW * u;
    let peak = -Infinity;
    for (const z of pathZ) for (const k of [-1, -0.5, 0, 0.5, 1]) {
        const x = rx + k * hw;
        peak = Math.max(peak, hf(x, z) + (levels ? Math.max(0, cellLevelAt(lite, x - ox, z - oz)) * step : 0));
    }
    const deckY = p.groundY + Math.max(RAIL_M.deckAboveGround * u, peak + RAIL_M.deckClearance * u);
    const tc = RAIL_M.trackCentres * u;
    const line: RailLine = {
        rx, z0, z1, deckY, tracks: 2, trackOffsets: [-tc / 2, tc / 2],
        railTopY: deckY + RAIL_TOP_M * u, gaugeU: RAIL_M.gauge * u,
        contactY: deckY + (RAIL_TOP_M + RAIL_M.contactAboveRail) * u,
        unitsPerMetre: u, path, pathZ, mode, roadX, side,
    };
    if (lineCache.size > 64) lineCache.clear();
    lineCache.set(key, line);
    return line;
}

/** The rigid deck frame at layout z: render-space point on the centreline + unit tangent + unit normal. */
export interface RailFrame { x: number; z: number; tx: number; tz: number; nx: number; nz: number }

export function railFrameAt(line: RailLine, z: number): RailFrame {
    const { path, pathZ } = line, n = path.length - 1;
    const f = (z - line.z0) / ((line.z1 - line.z0) || 1) * n;
    const i = Math.max(0, Math.min(n - 1, Math.floor(f))), t = f - i;
    const a = path[i], b = path[i + 1];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    void pathZ;
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx, tz, nx: tz, nz: -tx };
}

/** Mitred normal at path point i (average of the two adjacent segment normals, scaled so offsets stay parallel). */
export function railPathNormal(line: RailLine, i: number): V2 {
    const { path } = line, n = path.length - 1;
    const seg = (k: number): V2 => { const a = path[k], b = path[k + 1]; const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dz / l, -dx / l]; };
    const na = seg(Math.max(0, Math.min(n - 1, i - 1))), nb = seg(Math.max(0, Math.min(n - 1, i)));
    let mx = na[0] + nb[0], mz = na[1] + nb[1];
    const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    const c = Math.max(0.5, mx * nb[0] + mz * nb[1]);   // 1 / cos(half the bend) keeps the offset line parallel
    return [mx / c, mz / c];
}

/** Track k's centre as a render-space polyline (noWarp) — what the moving train follows. */
export function railTrackPath(line: RailLine, track: number): V2[] {
    const off = line.trackOffsets[track] ?? 0;
    return line.path.map((p, i) => { const nn = railPathNormal(line, i); return [p[0] + nn[0] * off, p[1] + nn[1] * off] as V2; });
}

/** A station along the line (LAYOUT z) with its platform half-length (world units). */
export interface RailStation { z: number; halfLen: number; side: 'island' | 'side' }

/** Car count the platforms are sized for: the train's `railCars` (default 8), clamped. */
export function railPlatformCars(p: { railCars?: number }): number {
    return Math.max(2, Math.min(10, Math.round(p.railCars ?? 8)));
}

/** Station centres + platform half-lengths — deterministic, pure (params only), so the train can dwell there.
 *  Stations sit over a grid ROAD JUNCTION (a row line) near a seeded spot; a long line gets a second one. The
 *  CHOICE of junction never depends on the car count (only the platform length does), so a car-count change never
 *  moves a station. Side platforms: the tracks keep their 4 m centres through the station (no spread). */
export function railStations(p: RailLineParams): RailStation[] {
    if (!(p.railway ?? true) || !(p.stations ?? true)) return [];
    const line = railwayLine(p), u = line.unitsPerMetre, R = p.radius;
    const span = line.z1 - line.z0;
    const maxHalf = ((10 * RAIL_M.carLen + RAIL_M.stationPad) / 2) * u;           // sized for the longest train
    const margin = maxHalf * 0.8 + 12 * u;                                        // keep the platform ends on the span
    if (span < 2 * margin) return [];
    const rows = Math.max(2, (p.gridRows ?? p.gridCols) | 0), ch = 2 * R / rows, oz = p.tileOrigin?.[1] ?? 0;   // P10.A1 tile frame
    const cands: number[] = [];
    if (p.pattern === 'grid') for (let r = 1; r < rows; r++) { const z = oz - R + r * ch; if (z >= line.z0 + margin && z <= line.z1 - margin) cands.push(z); }
    if (!cands.length) cands.push((line.z0 + line.z1) / 2);
    const hs = ((p.seed * 2654435761) >>> 0) / 4294967296;
    const target = line.z0 + span * (0.3 + 0.4 * hs);
    const pick = (t: number, from: number[]): number => from.reduce((b, c) => Math.abs(c - t) < Math.abs(b - t) ? c : b, from[0]);
    const zs = [pick(target, cands)];
    const want = ((railPlatformCars(p) * RAIL_M.carLen + RAIL_M.stationPad) / 2) * u;
    // A second station when the line is long enough for two full platforms with a proper run between them (a long
    // line or short trains — the city is ~280 m across, so an 8-car line has one). The FIRST never moves.
    const gap = 2 * want + 50 * u, m2 = want + 12 * u;
    const all: number[] = [];
    if (p.pattern === 'grid') for (let r = 1; r < rows; r++) { const z = oz - R + r * ch; if (z >= line.z0 + m2 && z <= line.z1 - m2) all.push(z); }
    const far = all.filter(c => Math.abs(c - zs[0]) >= gap);
    if (far.length) zs.push(pick(zs[0] < (line.z0 + line.z1) / 2 ? line.z1 - (zs[0] - line.z0) : line.z0 + (line.z1 - zs[0]), far));
    zs.sort((a, b) => a - b);
    return zs.map(z => ({ z, halfLen: Math.min(want, z - line.z0 - 8 * u, line.z1 - z - 8 * u), side: 'side' as const }));
}

// ── Graph-aware layout: pier frames, station stairs, reservations (memoised per graph) ────────────────────────────

/** One pier: a PORTAL (rigid frame: two columns on the pavements + a cap beam across the road) over a grid street,
 *  or a T pier (one column + a wide cap) elsewhere. Column centres are LAYOUT space. */
export interface RailPier { z: number; kind: 'portal' | 'T'; cols: V2[]; colHx: number; colHz: number }

/** A station street connection: a stair flight from the platform's outer edge down along a cross-street pavement,
 *  with the ticket-gate hall tucked under its upper flight. LAYOUT space; `dir` = ±1 along x. */
export interface RailStair {
    station: number; side: 1 | -1; zp: number; xTop: number; dir: 1 | -1;
    run: number; width: number; topY: number; footY: number; hallLen: number;
}

/** One bay of the railway ARCADE (R3.1): the claimed lot it stands on, its z range along the line (layout), its
 *  fill and its district. Bays of one `run` are separated by cross walls; a run ends at a cross street / canal. */
export interface ArcadeBay { lot: Lot; za: number; zb: number; kind: ArcadeBayKind; district: string; run: number; i: number }

export interface RailLayout {
    line: RailLine; stations: RailStation[]; piers: RailPier[]; stairs: RailStair[];
    /** ARCADE mode: the bays (sorted by z) and the continuous runs [za, zb] they form (empty in portal mode). */
    bays: ArcadeBay[]; runs: [number, number][];
    /** Platform outer edge offset (units) and the station deck's half-width (edge of its parapet). */
    platformOuter: number; stationHalfW: number;
    /** Deck half-width at layout z (station wings included). */
    halfWAt(z: number): number;
    /** In a station's deck range? → its index, else -1. */
    stationAt(z: number): number;
}

const layoutCache = new WeakMap<WorldGraph, RailLayout>();
const BUILT = new Set(['residential', 'commercial', 'civic']);

/** Point-test helpers over a graph (layout space): built lot / canal / outside border / on a carriageway. */
function siteTests(graph: WorldGraph): { blocked(x: number, z: number, allowWater?: boolean): boolean } {
    const lots = graph.lots.filter(l => BUILT.has(l.zone) && l.poly.length >= 3);
    const lotB = lots.map(l => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const q of l.poly) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); } return [x0, z0, x1, z1]; });
    const lmPolys = (graph.landmarks ?? []).map(l => l.footprint).filter(f => !!f && f.length >= 3);
    const roads = graph.roads;
    return {
        blocked(x: number, z: number, allowWater = false): boolean {
            if (graph.border.length >= 3 && !pointInPolygon([x, z], graph.border)) return true;
            if (!allowWater && cellLevelAt(graph, x, z) < 0) return true;   // canal
            for (let i = 0; i < lots.length; i++) {
                const b = lotB[i];
                if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
                if (pointInPolygon([x, z], lots[i].poly)) return true;
            }
            for (const f of lmPolys) if (pointInPolygon([x, z], f)) return true;
            for (const r of roads) {   // on a carriageway (any road, alleys included)
                const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], L2 = dx * dx + dz * dz;
                if (L2 < 1e-12) continue;
                const t = Math.max(0, Math.min(1, ((x - r.a[0]) * dx + (z - r.a[1]) * dz) / L2));
                const ex = r.a[0] + dx * t - x, ez = r.a[1] + dz * t - z;
                // (RoadSegment.width is the whole corridor; the CARRIAGEWAY is the class width — pavements are fine.)
                const cw = r.klass === 'arterial' ? (graph.params.arterialWidth ?? graph.params.streetWidth) : r.klass === 'alley' ? r.width : graph.params.streetWidth;
                if (ex * ex + ez * ez < (cw * 0.5) ** 2) return true;
            }
            return false;
        },
    };
}

/** Each built lot's DOOR (layout point on its frontage): the middle of its longest edge that runs parallel to a
 *  non-alley road at kerb distance — the same rule street-slots uses for the 'entrance' slot (buildStreets puts the
 *  door there too). Piers slide off doors; a station stair never covers one. */
function lotDoors(graph: WorldGraph): V2[] {
    const p = graph.params, s = p.radius / 10, half = p.streetWidth * 0.5, probeMax = 0.45 * s + 0.3 * p.streetWidth;
    const roads = graph.roads.filter(r => r.klass !== 'alley').map(r => {
        const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], len = Math.hypot(dx, dz) || 1;
        return { a: r.a, d: [dx / len, dz / len] as V2, pp: [-dz / len, dx / len] as V2, len };
    });
    const out: V2[] = [];
    for (const lot of graph.lots) {
        if (!BUILT.has(lot.zone) || lot.poly.length < 3 || lot.slot === 'viaduct') continue;
        let best: V2 | null = null, bestLen = 0;
        const n = lot.poly.length;
        for (let k = 0; k < n; k++) {
            const e0 = lot.poly[k], e1 = lot.poly[(k + 1) % n];
            const ex = e1[0] - e0[0], ez = e1[1] - e0[1], el = Math.hypot(ex, ez);
            if (el < 0.05 * s) continue;
            const mx = (e0[0] + e1[0]) * 0.5, mz = (e0[1] + e1[1]) * 0.5;
            for (const R of roads) {
                if (Math.abs((ex * R.d[0] + ez * R.d[1]) / el) < 0.95) continue;
                const rx = mx - R.a[0], rz = mz - R.a[1];
                const al = rx * R.d[0] + rz * R.d[1], lat = Math.abs(rx * R.pp[0] + rz * R.pp[1]);
                if (al < 0 || al > R.len || lat < half * 0.9 || lat > half + probeMax) continue;
                if (el > bestLen) { bestLen = el; best = [mx, mz]; }
            }
        }
        if (best) out.push(best);
    }
    return out;
}

/** The graph-aware rail layout (piers + stairs), memoised per graph. Honours `railway` / `stations` (both are
 *  full-regen params, so a toggle builds a fresh graph and a fresh plan). */
export function railLayout(graph: WorldGraph): RailLayout {
    const hit = layoutCache.get(graph);
    if (hit) return hit;
    const p = graph.params, line = railwayLine(p), u = line.unitsPerMetre, R = p.radius;
    const stations = railStations(p);
    const grid = p.pattern === 'grid';
    const band = streetBandHalf(p), roadHalf = Math.max(p.streetWidth, p.arterialWidth ?? 0) * 0.5;
    const tests = siteTests(graph);
    const doors = lotDoors(graph);
    // Station deck: side platforms from the edge (3.57 m) outward, up to a small overhang past the lot line.
    // (ARCADE: the minimum 2 m platform — its road-side wing reaches the kerb line, its back wing stays on the strip.)
    const arcade = line.mode === 'arcade';
    const platformOuter = arcade ? RAIL_M.platformEdge * u + 2.0 * u
        : Math.max(RAIL_M.platformEdge * u + 2.0 * u, Math.min(RAIL_M.platformEdge * u + RAIL_M.platformMaxW * u, grid ? band + 0.5 * u : 7.1 * u));
    const stationHalfW = platformOuter + RAIL_M.parapetT * u;
    const pad = 2 * u;
    const stationAt = (z: number): number => { for (let i = 0; i < stations.length; i++) if (Math.abs(z - stations[i].z) <= stations[i].halfLen + pad) return i; return -1; };
    const halfWAt = (z: number): number => stationAt(z) >= 0 ? stationHalfW : RAIL_M.deckHalfW * u;

    // ── Piers ──
    const piers: RailPier[] = [];
    const pave = band - roadHalf;
    const portal = grid && pave > 0.9 * u && !arcade;
    const colHx = portal ? Math.max(0.35 * u, Math.min(0.8 * u, (pave - 0.35 * u) / 2)) : 1.0 * u;
    const colHz = portal ? 0.8 * u : 0.9 * u;
    const colOff = portal ? roadHalf + pave / 2 : 0;
    const okCol = (c: V2, allowWater: boolean): boolean => {
        for (const [sx, sz] of [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]]) if (tests.blocked(c[0] + sx * colHx * 1.05, c[1] + sz * colHz * 1.05, allowWater)) return false;
        return true;
    };
    // Candidates first; a frame whose column would stand in a canal is skipped (the deck spans the water) — unless the
    // line runs ALONG the water for a long way (> 60 m of rejects), where the frames stand in the channel instead.
    const cand: { z: number; cols: V2[]; ok: boolean; wet: boolean }[] = [];
    // Shop / house DOORS on the lots fronting the line (≈ the middle of each lot edge that faces the rail road — where
    // street-slots puts the 'entrance' and buildStreets the door): a column must not stand in front of one, so a
    // frame slides along its stretch (0.6 m steps) to the first door-free spot.
    const doorZ: number[] = portal ? doors.filter(d => Math.abs(Math.abs(d[0] - line.rx) - band) < 1.5 * u).map(d => d[1]) : [];
    const doorClear = colHz + 0.7 * u;   // column + reservation margin + half a door
    const tryPier = (z0c: number, lo = z0c, hi = z0c): void => {
        let z = z0c;
        for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
            const zz = z0c + k * 0.6 * u;
            if (zz < lo - 1e-9 || zz > hi + 1e-9) continue;
            if (!doorZ.some(d => Math.abs(d - zz) < doorClear)) { z = zz; break; }
        }
        const cols: V2[] = portal ? [[line.rx - colOff, z], [line.rx + colOff, z]] : [[line.rx, z]];
        const ok = cols.every(c => okCol(c, false));
        cand.push({ z, cols, ok, wet: !ok && cols.every(c => okCol(c, true)) });
    };
    const end = 0.8 * u + colHz;
    // ── ARCADE bays + runs (R3.1): the claimed strip lots (claimViaductLots) — the cross walls carry the deck, so
    //    T piers only stand in the long open gaps (a canal, the approach to the border). ──
    const bays: ArcadeBay[] = [], runs: [number, number][] = [];
    if (arcade) {
        const distOf = new Map(graph.blocks.map(b => [b.id, b.district ?? '']));
        const list = graph.lots.filter(l => l.slot === 'viaduct' && l.bay).map(l => { const b = bounds(l.poly); return { l, za: b.min[1], zb: b.max[1] }; }).sort((a, b) => a.za - b.za);
        for (const q of list) {
            if (!runs.length || q.za - runs[runs.length - 1][1] > 0.05 * u) runs.push([q.za, q.zb]);
            else runs[runs.length - 1][1] = Math.max(runs[runs.length - 1][1], q.zb);
            const run = runs.length - 1;
            bays.push({ lot: q.l, za: q.za, zb: q.zb, kind: q.l.bay!, district: distOf.get(q.l.block) ?? '', run, i: bays.filter(b => b.run === run).length });
        }
        const gaps = cutGaps(line.z0, line.z1, runs);
        for (const [a, b] of gaps) {
            if (b - a < 22 * u) continue;   // a cross street: the girders span it
            const n = Math.ceil((b - a) / (20 * u));
            for (let k = 1; k < n; k++) tryPier(a + (b - a) * k / n);
        }
    } else if (grid) {
        const rows = Math.max(2, p.gridRows | 0), ch = 2 * R / rows;
        const SD = streetDims(p);
        const clr = SD.cwStart + SD.cwDepth + 0.6 * u + colHz;   // clear of the junction box AND its zebra landings
        const lines: number[] = [];
        const oz = p.tileOrigin?.[1] ?? 0;   // P10.A1 tile frame: the junction rows of the OFFSET tile
        for (let r = 1; r < rows; r++) { const z = oz - R + r * ch; if (z > line.z0 && z < line.z1) lines.push(z); }
        const bounds = [line.z0, ...lines, line.z1];
        for (let k = 0; k + 1 < bounds.length; k++) {
            const a = bounds[k] + (k === 0 ? end : clr), b = bounds[k + 1] - (k + 1 === bounds.length - 1 ? end : clr);
            if (b < a) continue;   // a block too short to stand a frame clear of both junctions: span it
            const n = Math.max(1, Math.ceil((b - a) / (RAIL_M.pierSpanMax * u)));
            if (n === 1) tryPier((k === 0) ? a : (k + 1 === bounds.length - 1) ? b : (a + b) / 2, a, b);
            else for (let i = 0; i < n; i++) tryPier(a + (b - a) * i / (n - 1), a, b);
            if (n === 1 && (k === 0 || k + 1 === bounds.length - 1) && b - a > 10 * u) tryPier(k === 0 ? b : a, a, b);
        }
    } else {
        const n = Math.max(2, Math.ceil((line.z1 - line.z0 - 2 * end) / (22 * u)));
        for (let i = 0; i <= n; i++) tryPier(line.z0 + end + (line.z1 - line.z0 - 2 * end) * i / n);
    }

    cand.sort((a, b) => a.z - b.z);
    for (let i = 0; i < cand.length;) {
        if (cand[i].ok) { i++; continue; }
        let j = i; while (j < cand.length && !cand[j].ok) j++;
        const zA = i > 0 ? cand[i - 1].z : line.z0, zB = j < cand.length ? cand[j].z : line.z1;
        if (zB - zA > 60 * u) for (let k = i; k < j; k++) if (cand[k].wet) cand[k].ok = true;
        i = j;
    }
    if (arcade) { for (const c of cand) if (c.cols.every(q => okCol(q, true))) piers.push({ z: c.z, kind: 'T', cols: c.cols, colHx, colHz }); }
    else for (const c of cand) if (c.ok) piers.push({ z: c.z, kind: portal ? 'portal' : 'T', cols: c.cols, colHx, colHz });

    // ── Station stairs (+ halls) ──
    const stairs: RailStair[] = [];
    const elev = stations.length ? makeElevation(graph) : null;
    const tan = Math.tan(RAIL_M.stairPitchDeg * Math.PI / 180);
    const topY = line.deckY + RAIL_M.platformAboveDeck * u;
    const sw = Math.min(RAIL_M.stairW * u, Math.max(0.9 * u, (grid ? pave : 2.2 * u) - 0.3 * u));
    const pavC = grid ? roadHalf + pave / 2 : 3 * u;
    stations.forEach((st, si) => {
        for (const side of [1, -1] as const) {
            const xTop = line.rx + side * stationHalfW;
            const opts: RailStair[] = [];
            for (const zs of [1, -1]) {
                const zp = st.z + zs * side * pavC;   // try the pavement on one side of the cross street, then the other
                let footY = p.groundY + elev!(xTop + side * 13 * u, zp), run = 0;
                for (let it = 0; it < 3; it++) { run = Math.max(3 * u, (topY - footY) / tan) + 1.2 * u; footY = p.groundY + elev!(xTop + side * run, zp); }
                let ok = true;
                for (let t = 0; t <= 1.0001 && ok; t += 0.08) for (const q of [-0.5, 0, 0.5]) {
                    if (tests.blocked(xTop + side * (0.3 * u + t * (run - 0.3 * u)), zp + q * sw)) { ok = false; break; }
                }
                if (!ok) continue;
                opts.push({ station: si, side, zp, xTop, dir: side, run, width: sw, topY, footY, hallLen: Math.min(RAIL_M.hallLen * u, run * 0.45) });
            }
            const covers = (o: RailStair): boolean => doors.some(d => (d[0] - o.xTop) * o.dir > -0.8 * u && (d[0] - o.xTop) * o.dir < o.run + 1.4 * u && Math.abs(d[1] - o.zp) < o.width / 2 + 1.3 * u);
            const pick = opts.find(o => !covers(o));
            if (pick) stairs.push(pick);   // (no door-free side → no stair on this platform: never block a shop door)
        }
    });

    const out: RailLayout = { line, stations, piers, stairs, bays, runs, platformOuter, stationHalfW, halfWAt, stationAt };
    layoutCache.set(graph, out);
    return out;
}

/** Street-plan reservations (LAYOUT space): nothing TALL (trees, utility poles) under the deck, and nothing at all
 *  on a pier column, a station stair or its hall. Empty when the railway is off. */
export interface RailReservations {
    tallAt(x: number, z: number): boolean;
    solidAt(x: number, z: number): boolean;
    /** Distance-ish test: within `d` units of the deck footprint. */
    nearDeck(x: number, z: number, d: number): boolean;
}

const NONE: RailReservations = { tallAt: () => false, solidAt: () => false, nearDeck: () => false };
const resCache = new WeakMap<WorldGraph, RailReservations>();

export function railReservations(graph: WorldGraph): RailReservations {
    if (!(graph.params.railway ?? true)) return NONE;
    const hit = resCache.get(graph);
    if (hit) return hit;
    const L = railLayout(graph), u = L.line.unitsPerMetre;
    const rects: [number, number, number, number][] = [];   // x0 z0 x1 z1
    const m = 0.25 * u;
    for (const pr of L.piers) for (const c of pr.cols) rects.push([c[0] - pr.colHx - m, c[1] - pr.colHz - m, c[0] + pr.colHx + m, c[1] + pr.colHz + m]);
    for (const s of L.stairs) {
        const xa = s.xTop - s.dir * 0.3 * u, xb = s.xTop + s.dir * (s.run + 0.6 * u);
        rects.push([Math.min(xa, xb), s.zp - s.width / 2 - m, Math.max(xa, xb), s.zp + s.width / 2 + m]);
    }
    const { rx, z0, z1 } = L.line;
    // Tall things (a tree canopy, a pole + its wires) also keep ~3 m off a station stair / hall.
    const tallRects = rects.slice(L.piers.reduce((n, pr) => n + pr.cols.length, 0)).map(r => [r[0] - 3 * u, r[1] - 3 * u, r[2] + 3 * u, r[3] + 3 * u]);
    const res: RailReservations = {
        tallAt: (x, z) => (z >= z0 - 1.5 * u && z <= z1 + 1.5 * u && Math.abs(x - rx) < L.halfWAt(z) + 1.5 * u)
            || tallRects.some(r => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]),
        solidAt: (x, z) => { for (const r of rects) if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return true; return false; },
        nearDeck: (x, z, d) => z >= z0 - d && z <= z1 + d && Math.abs(x - rx) < L.halfWAt(z) + d,
    };
    resCache.set(graph, res);
    return res;
}

/** [a, b] minus the given (sorted, disjoint) covered ranges → the open gaps. */
function cutGaps(a: number, b: number, covered: [number, number][]): [number, number][] {
    const out: [number, number][] = [];
    let x = a;
    for (const [c0, c1] of covered) { if (c0 > x) out.push([x, Math.min(c0, b)]); x = Math.max(x, c1); }
    if (b > x) out.push([x, b]);
    return out.filter(([p, q]) => q - p > 1e-6);
}

// ── The ARCADE lot claim (R3.1) — layout time, like the shotengai / landmark tags ─────────────────────────────

/** The arcade strip in LAYOUT x: the lot line on the arcade side and the far edge of the claimed strip. */
export function arcadeStrip(p: RailLineParams): { lotLine: number; far: number; lo: number; hi: number; side: 1 | -1 } | null {
    if (!(p.railway ?? true) || railViaductMode(p) !== 'arcade') return null;
    const line = railwayLine(p), u = line.unitsPerMetre, band = streetBandHalf(p as unknown as LayoutParams);
    const lotLine = line.roadX + line.side * band, far = lotLine + line.side * ARC_M.claim * u;
    return { lotLine, far, lo: Math.min(lotLine, far), hi: Math.max(lotLine, far), side: line.side };
}

/** Bay fill by district (weights over izakaya / eatery / shop / bike / storage / service). The street face gets the
 *  life: nightlife + market districts are mostly izakaya and eateries, homes get bike parking and storage. */
const BAY_MIX: Record<string, [ArcadeBayKind, number][]> = {
    downtown: [['izakaya', 0.3], ['eatery', 0.24], ['shop', 0.24], ['bike', 0.1], ['storage', 0.06], ['service', 0.06]],
    market: [['izakaya', 0.26], ['eatery', 0.3], ['shop', 0.24], ['bike', 0.1], ['storage', 0.05], ['service', 0.05]],
    civic: [['shop', 0.3], ['eatery', 0.16], ['izakaya', 0.1], ['bike', 0.2], ['storage', 0.1], ['service', 0.14]],
    residential: [['shop', 0.2], ['eatery', 0.14], ['izakaya', 0.12], ['bike', 0.24], ['storage', 0.16], ['service', 0.14]],
    park: [['bike', 0.4], ['storage', 0.3], ['service', 0.3]],
};
export function arcadeBayKind(district: string | undefined, zone: Zone, h: number, nearStation: boolean): ArcadeBayKind {
    const mix = zone === 'park' ? BAY_MIX.park : BAY_MIX[district ?? ''] ?? BAY_MIX.residential;
    if (nearStation && h < 0.3) return 'bike';   // station bike parking under the line
    const r = nearStation ? (h - 0.3) / 0.7 : h;
    let acc = 0;
    for (const [k, w] of mix) { acc += w; if (r < acc) return k; }
    return mix[mix.length - 1][0];
}

/** Clip a convex polygon to the half-plane side·x ≥ side·x0. */
function clipX(poly: V2[], x0: number, side: 1 | -1): V2[] {
    const out: V2[] = [], inside = (q: V2): boolean => side * (q[0] - x0) >= -1e-9;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], ia = inside(a), ib = inside(b);
        if (ia) out.push(a);
        if (ia !== ib) { const t = (x0 - a[0]) / (b[0] - a[0]); out.push([x0, a[1] + (b[1] - a[1]) * t]); }
    }
    return out;
}

/** ARCADE mode (R3.1): claim the lot strip beside the rail road for the viaduct — deterministically, at layout time,
 *  like the shotengai tags its corridor. Lots over the strip are TRIMMED to the part behind it (at least 4 m deep)
 *  or dropped; each block the strip crosses gets a row of BAY lots (slot 'viaduct', ~10 m pitch, `bay` = the fill)
 *  so the shared street plan sees the arcade as the building line (entrance slots at the bay doors, nothing parked
 *  inside it) and the door-visit sim / footfall field count the shops. Tags the blocks (`viaduct`) so landmarks and
 *  the shotengai skip them. No-op in portal mode, off the grid, or with the railway off. */
export function claimViaductLots(graph: WorldGraph): void {
    const p = graph.params, st = arcadeStrip(p);
    if (!st || p.pattern !== 'grid') return;
    const line = railwayLine(p), u = line.unitsPerMetre, s = st.side;
    const zA = line.z0, zB = line.z1, e = 1e-6;
    const touched = new Set<number>();
    const drop = new Set<string>();
    for (const lot of graph.lots) {
        if (lot.zone === 'water' || lot.poly.length < 3) continue;
        const b = bounds(lot.poly);
        if (b.max[0] <= st.lo + e || b.min[0] >= st.hi - e || b.max[1] <= zA + e || b.min[1] >= zB - e) continue;
        touched.add(lot.block);
        const rem = clipX(lot.poly, st.far, s);
        const rb = rem.length >= 3 ? bounds(rem) : null;
        if (!rb || rb.max[0] - rb.min[0] < ARC_M.minRemain * u) { drop.add(lot.id); continue; }
        // Trim: keep the street edges that still lie on a street line (the claimed side's edge is gone).
        const lines = (lot.streetEdges ?? []).map(i => [lot.poly[i], lot.poly[(i + 1) % lot.poly.length]] as [V2, V2]);
        const onLine = (a: V2, c: V2): boolean => lines.some(([q0, q1]) => {
            const dx = q1[0] - q0[0], dz = q1[1] - q0[1], L = Math.hypot(dx, dz) || 1;
            const d = (q: V2): number => Math.abs((q[0] - q0[0]) * dz - (q[1] - q0[1]) * dx) / L;
            return d(a) < 1e-5 && d(c) < 1e-5;
        });
        lot.poly = rem; lot.center = centroid(rem); lot.area = polyArea(rem);
        if (lot.streetEdges) lot.streetEdges = rem.map((_, i) => i).filter(i => onLine(rem[i], rem[(i + 1) % rem.length]));
    }
    if (drop.size) {
        graph.lots = graph.lots.filter(l => !drop.has(l.id));
        for (const b of graph.blocks) if (touched.has(b.id)) b.lots = b.lots.filter(id => !drop.has(id));
    }
    // Bays per block along the strip.
    const stations = railStations(p);
    const x0 = st.lo, x1 = st.hi;
    for (const block of graph.blocks) {
        if (block.zone === 'water' || block.level === -1 || block.poly.length < 3) continue;
        const bb = bounds(block.poly);
        if (bb.max[0] <= x0 + e || bb.min[0] >= x1 - e) continue;
        const reg = gridLotRegion(p, block);
        if (!reg) continue;
        const [rx0, rz0, rx1, rz1] = reg.rect;
        if (Math.min(rx1, x1) - Math.max(rx0, x0) < 0.9 * (x1 - x0)) continue;   // the block doesn't carry the whole strip
        const za = Math.max(rz0, zA + 1.5 * u), zb = Math.min(rz1, zB - 1.5 * u);
        if (zb - za < 6 * u) continue;
        const n = Math.max(1, Math.round((zb - za) / (ARC_M.bay * u)));
        const pitch = (zb - za) / n;
        const zone: Zone = block.zone === 'residential' || block.zone === 'commercial' || block.zone === 'civic' ? block.zone : 'commercial';
        let any = false;
        for (let k = 0; k < n; k++) {
            const z0 = za + k * pitch, z1 = z0 + pitch;
            const poly: V2[] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
            if (graph.border.length >= 3 && !poly.every(q => pointInPolygon(q, graph.border))) continue;
            if (!poly.every(q => q[0] >= rx0 - 1e-6 && q[0] <= rx1 + 1e-6 && q[1] >= rz0 - 1e-6 && q[1] <= rz1 + 1e-6)) continue;
            const zc = (z0 + z1) / 2;
            const near = stations.some(sn => Math.abs(zc - sn.z) < sn.halfLen);
            const h = hash2(block.id * 31 + k, Math.round(zc * 1000), (p.seed ^ 0xa7cade) >>> 0);
            // A bay whose street face looks onto a canal trench (the rail road runs along the water) has no pavement
            // life in front: it is storage / service / bike space, never a shop.
            const wet = cellLevelAt(graph, st.lotLine - s * 1.0 * u, zc) < 0;
            const kind = arcadeBayKind(block.district, wet ? 'park' : block.zone, h, near && !wet);
            const front = s > 0 ? 3 : 1;   // the poly edge on the lot line (x0 when the strip runs +x, x1 when −x)
            const lot: Lot = { id: `V${block.id}_${k}`, poly, center: centroid(poly), zone, slot: 'viaduct', block: block.id, area: polyArea(poly), streetEdges: [front], bay: kind };
            if (kind === 'izakaya' || kind === 'eatery' || kind === 'shop') {
                lot.door = [st.lotLine + s * (ARC_M.front + ARC_M.shopSet) * u, zc];
                lot.doorOut = [-s, 0];
            }
            graph.lots.push(lot); block.lots.push(lot.id);
            any = true;
        }
        if (any) touched.add(block.id);
    }
    // STATION ENTRANCES: under an arcade line the ticket hall is IN the arcade (the stair climbs inside the viaduct) —
    // the bay nearest each station centre becomes its entrance.
    for (const sn of stations) {
        let best: Lot | null = null, bd = Infinity;
        for (const l of graph.lots) {
            if (l.slot !== 'viaduct' || !l.bay) continue;
            const d = Math.abs(l.center[1] - sn.z);
            if (d < bd && d < sn.halfLen) { bd = d; best = l; }
        }
        if (best) { best.bay = 'station'; delete best.door; delete best.doorOut; }
    }
    for (const b of graph.blocks) if (touched.has(b.id)) b.viaduct = true;
}
