// ── World generation — the canal BRIDGE DECK surface (one height rule for every consumer) ──────────
// A bridge deck carries the street over a sunken canal. Four things must agree on how high its surface is at a
// point: the deck mesh itself (water.ts addArchBridge), the static crowd standing on it (pedestrians.ts), the
// walkers crossing it (world-traffic._groundY) and the tests. Before this module each had its own idea — the
// deck sat at the level-0 street height whatever the banks were, the crowd was draped with the full elevation
// (which over a canal cell resolves to the TRENCH level, so people stood in the water under the bridge) and the
// walkers used a per-cell arc that matched neither.
//
// ★ THE RULE (S13 / E5 / E12): each END of the deck lands exactly on the ground just past it — the carriageway at
// the approach road's baked height (terrace level or ramp × step) and the footways at the approach PAVEMENT height
// (road + the 15 cm kerb, or no kerb where the approach has none). Between the ends the deck ramps linearly (two
// banks on different terrace levels give a sloped deck, not a step) with a parabolic camber that is zero at both
// ends. Heights are BAKED (above groundY, before the smooth terrain field): every consumer drapes them on the
// SMOOTH field only, exactly like the road they meet.
//
// Pure, deterministic, worker-safe.

import type { WorldGraph, V2 } from './types';
import { cellLevelAt, rampLevelAt, terraceStep, streetBandHalf } from './elevation';
import { pavementIndex, streetDims } from './street-layout';
import { centroid, dist } from './util';

type GraphLike = Pick<WorldGraph, 'params' | 'radius' | 'levels' | 'bridges' | 'blocks' | 'border' | 'intersections' | 'shotengai' | 'plaza' | 'roads' | 'ramps'>;

export interface BridgeDeck {
    quad: V2[];
    /** Centre, unit span direction (end A → end B) and unit width direction. */
    c: V2; d: V2; p: V2;
    /** Half the span and half the deck width (the parapet line). */
    half: number; wHalf: number;
    /** Half-width of the carriageway on the deck (the kerb line — footways run from here to the parapet). */
    carriageHalf: number;
    /** Baked carriageway height (above groundY) of the approach road at end A / end B. */
    roadA: number; roadB: number;
    /** Footway kerb lift at end A / end B for the side at −p ([0]) and +p ([1]). */
    kerbA: [number, number]; kerbB: [number, number];
    /** Camber height at mid-span (0 at both ends). */
    rise: number;
    /** Tiny surfacing lift above the road it lands on (depth separation only). */
    lift: number;
}

const cache = new WeakMap<object, BridgeDeck[]>();

/** Every bridge deck of a graph with its end heights resolved (cached on the graph's bridges array). */
export function bridgeDecks(graph: GraphLike): BridgeDeck[] {
    const hit = cache.get(graph.bridges);
    if (hit) return hit;
    // (Two canals can emit the same crossing twice — keep one deck per span, or it is built, and walked, twice.)
    const seen = new Set<string>();
    const out = graph.bridges.filter(q => q.length >= 4).map(q => resolveDeck(graph, q)).filter(d => {
        const k = [d.c[0], d.c[1], d.half, d.wHalf].map(v => Math.round(v * 1e4)).join(',');
        if (seen.has(k)) return false;
        seen.add(k); return true;
    });
    cache.set(graph.bridges, out);
    return out;
}

function resolveDeck(graph: GraphLike, quad: V2[]): BridgeDeck {
    const p = graph.params, s = p.radius / 10;
    const e0 = dist(quad[0], quad[1]), e1 = dist(quad[1], quad[2]);
    const A = e0 >= e1 ? quad[0] : quad[1], B = e0 >= e1 ? quad[1] : quad[2];
    const spanLen = Math.max(e0, e1), width = Math.min(e0, e1);
    const c = centroid(quad);
    const d: V2 = [(B[0] - A[0]) / spanLen, (B[1] - A[1]) / spanLen];
    const pp: V2 = [-d[1], d[0]];
    const half = spanLen * 0.5, wHalf = width * 0.5;
    const D = streetDims(p), step = terraceStep(p);
    const carriageHalf = Math.min(D.half, wHalf * 0.9);
    const terraced = !!graph.levels && (p.terraces ?? true);
    const ramps = terraced ? (graph.ramps ?? null) : null;
    const levelAt = (x: number, z: number): number => {
        if (!terraced) return 0;
        const L = rampLevelAt(ramps, x, z) ?? cellLevelAt(graph, x, z);
        return L < 0 ? 0 : L;   // (the layout only builds decks whose approaches are dry — see layout.ts LAND)
    };
    const pave = pavementIndex(graph);
    // Sample a hair PAST each end, on the approach (the end itself sits exactly on the trench boundary line).
    const out = Math.max(1e-3 * s, 1e-4);
    const at = (end: -1 | 1, w: number): V2 => [c[0] + d[0] * (half + out) * end + pp[0] * w, c[1] + d[1] * (half + out) * end + pp[1] * w];
    const road = (end: -1 | 1): number => { const q = at(end, 0); return levelAt(q[0], q[1]) * step; };
    // Footway sample: the middle of the part of the pavement the deck covers.
    const band = Math.min(wHalf, streetBandHalf(p));
    const fw = (carriageHalf + band) * 0.5;
    const kerb = (end: -1 | 1, side: -1 | 1): number => {
        const q = at(end, fw * side);
        const raw = terraced ? (rampLevelAt(ramps, q[0], q[1]) ?? cellLevelAt(graph, q[0], q[1])) : 0;
        return raw >= 0 ? pave.lift(q[0], q[1]) : 0;   // a sunk approach has no kerb (makeGroundLevel's rule)
    };
    return {
        quad, c, d, p: pp, half, wHalf, carriageHalf,
        roadA: road(-1), roadB: road(1),
        kerbA: [kerb(-1, -1), kerb(-1, 1)], kerbB: [kerb(1, -1), kerb(1, 1)],
        rise: Math.min(0.045 * s, half * 0.18),
        lift: 0.0003 * s,
    };
}

/** Normalised span position t ∈ [0,1] (0 = end A) and signed width offset w of a point, relative to a deck. */
export function deckCoords(deck: BridgeDeck, x: number, z: number): { t: number; w: number } {
    const dx = x - deck.c[0], dz = z - deck.c[1];
    return { t: ((dx * deck.d[0] + dz * deck.d[1]) / deck.half + 1) * 0.5, w: dx * deck.p[0] + dz * deck.p[1] };
}

/** Baked carriageway height at span position t (linear ramp between the two banks + camber, zero at the ends). */
export function deckRoadY(deck: BridgeDeck, t: number): number {
    const u = t < 0 ? 0 : t > 1 ? 1 : t, k = u * 2 - 1;
    return deck.roadA + (deck.roadB - deck.roadA) * u + deck.rise * (1 - k * k) + deck.lift;
}

/** Footway kerb lift at span position t on a side (−1 / +1): linear between the two ends' pavement kerbs. */
export function deckKerb(deck: BridgeDeck, t: number, side: number): number {
    const u = t < 0 ? 0 : t > 1 ? 1 : t, i = side < 0 ? 0 : 1;
    return deck.kerbA[i] + (deck.kerbB[i] - deck.kerbA[i]) * u;
}

/** Baked deck SURFACE height at (t, w): the carriageway, or the raised footway beyond the kerb line. */
export function deckSurfaceY(deck: BridgeDeck, t: number, w: number): number {
    return deckRoadY(deck, t) + (Math.abs(w) > deck.carriageHalf ? deckKerb(deck, t, w) : 0);
}

/** The deck under (x,z) — inside its span and between its parapets, less `margin` — or null. */
export function deckAt(decks: BridgeDeck[], x: number, z: number, margin = 0): { deck: BridgeDeck; t: number; w: number } | null {
    for (const deck of decks) {
        const { t, w } = deckCoords(deck, x, z);
        if (t < 0 || t > 1 || Math.abs(w) > deck.wHalf - margin) continue;
        return { deck, t, w };
    }
    return null;
}

/** Baked surface height (above groundY) of the bridge deck under (x,z), or null when no deck is there. Consumers
 *  add the SMOOTH terrain field (the deck drapes 'smooth', like the road it meets). */
export function bridgeSurfaceAt(graph: GraphLike, x: number, z: number, margin = 0): number | null {
    const hit = deckAt(bridgeDecks(graph), x, z, margin);
    return hit ? deckSurfaceY(hit.deck, hit.t, hit.w) : null;
}
