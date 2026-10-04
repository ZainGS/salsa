// ── World generation — NIGHT LIGHT SPILL (visual-polish #5) ─────────────────────────────────────────────────────
// Persona night streets glow: warm pools in front of every lit shop and a coloured wash under every sign. The city
// had neither (its 16 point lights go to the street lamps nearest the camera), so shopping streets went near-black
// between the lamps. This is the cheap version: soft radial-fade quads on the pavement (the same transparent
// `radialFade` material the lamp pools and the contact-shadow blobs use — no new texture, binding or pipeline),
// placed from the per-lot building meta (lot-meta.ts: the shopfront edge, the sign slots and their colours), one
// layer per colour bucket. WorldManager builds it on the main thread when a look turns the spill on (a few hundred
// quads, about a millisecond) and the glow pass fades it in with the night level.
//
// Coordinates are LAYOUT space (unwarped, at groundY): the layers DRAPE ('full') like the pavement, so every vertex
// lands on the terrain + kerb height of the ground under it, and the domain warp bends them with the streets.

import type { LayoutPreviewLayer, WorldGraph } from './types';
import { cityMetresPerUnit } from './types';
import { lotMeta } from './lot-meta';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

type C3 = [number, number, number];

/** The warm light of a lit shop interior on the pavement. */
export const SHOP_SPILL_COLOR: C3 = [1.0, 0.74, 0.46];
/** Layer-name prefix (WorldManager's glow pass keys on it). */
export const LIGHT_SPILL_LAYER = 'world:light-spill';

export interface LightSpillSource {
    /** Centre on the ground (layout XZ, city units). */
    x: number; z: number;
    /** Half-extents along `ax` (the facade) and across it (city units), and the unit facade direction. */
    a: number; b: number; ax: [number, number];
    color: C3;
    /** 0..1 brightness weight (high signs throw less light down). */
    weight: number;
}

/** Normalise a sign colour into a light colour: full value, a quarter mixed toward warm white (light on grey paving
 *  is never as saturated as the sign face), and near-greys read as warm white. */
export function spillColorFor(c: ArrayLike<number> | null | undefined): C3 {
    if (!c || c.length < 3) return [1.0, 0.86, 0.66];
    const mx = Math.max(c[0], c[1], c[2], 1e-3), mn = Math.min(c[0], c[1], c[2]);
    if (mx - mn < 0.12 * mx || mx < 0.12) return [1.0, 0.9, 0.74];   // white / grey / black boxes: a warm white glow
    const n: C3 = [c[0] / mx, c[1] / mx, c[2] / mx];
    return [n[0] * 0.75 + 0.25, n[1] * 0.75 + 0.22, n[2] * 0.75 + 0.18];
}

/** Bucket a light colour (so the spill is a handful of layers, not one per sign): 12 hue bins + one warm-white bin. */
export function spillBucket(c: C3): number {
    const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    if (mx - mn < 0.3 * Math.max(mx, 1e-3)) return 12;   // low saturation (the warm white of white / grey boxes)
    let h: number;
    const d = mx - mn;
    if (mx === c[0]) h = ((c[1] - c[2]) / d + 6) % 6;
    else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    return Math.floor(h * 2) % 12;
}

/** Every spill source of a graph's detailed lots (pure; reads lot meta only). Distances in metres → city units. */
export function lightSpillSources(graph: Pick<WorldGraph, 'lots' | 'params'>): LightSpillSource[] {
    const mpu = cityMetresPerUnit(graph.params.radius ?? 10), m = (v: number): number => v / mpu;
    const out: LightSpillSource[] = [];
    for (const lot of graph.lots) {
        const meta = lotMeta(lot);
        if (!meta || !meta.detailed) continue;
        // SHOPFRONT: a long warm pool centred ON the facade line (its inner half sits under the building, unseen), so
        // the light is brightest at the glass and fades ~3.5 m out across the pavement.
        if (meta.shopfront && meta.front) {
            const { a, b } = meta.front;
            const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
            if (len > m(1.5)) {
                out.push({ x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, a: len / 2 + m(0.8), b: m(3.6), ax: [dx / len, dz / len], color: SHOP_SPILL_COLOR, weight: 1 });
            }
        }
        // SIGNS: a coloured wash on the pavement under each sign low enough to light it (tenant signs, fascias, the
        // lower blade panels). High billboards / roof signs are skipped; brightness falls off with height.
        const base = meta.doorY ?? 0, cols = meta.signColors;
        for (const sl of meta.signSlots ?? []) {
            const h = (sl.pos[1] - base) * mpu;   // metres above the ground floor
            if (!(h > 0.5 && h < 9)) continue;
            const w = Math.max(m(1.8), Math.min(m(4.5), sl.width * 0.7));
            const ol = Math.hypot(sl.out[0], sl.out[1]) || 1, o: [number, number] = [sl.out[0] / ol, sl.out[1] / ol];
            const along: [number, number] = [-o[1], o[0]];
            const col = spillColorFor(cols ? cols[((sl.k ?? 0) % 3 + 3) % 3] : null);
            // white / grey boxes throw a dimmer wash (a pale pool reads as a grey sticker on dark paving)
            const wt = Math.max(0.35, 1 - Math.max(0, h - 3) / 9) * (spillBucket(col) === 12 ? 0.55 : 1);
            out.push({ x: sl.pos[0] + o[0] * m(0.9), z: sl.pos[2] + o[1] * m(0.9), a: w, b: Math.max(m(2.2), w * 0.8), ax: along, color: col, weight: wt });
        }
    }
    return out;
}

const GRID = 4;   // quads per side: the spill drapes per vertex over kerbs and gentle slopes

/** The spill layers for `sources` (one per colour bucket; [] when none). `y` = the layout ground height plus a lift
 *  (city units) above the pavement; `opacity` = the centre alpha (radialFade dissolves it to 0 at the rim). */
export function lightSpillLayers(sources: LightSpillSource[], y: number, opacity: { shop: number; sign: number } = SPILL_OPACITY): LayoutPreviewLayer[] {
    if (!sources.length) return [];
    const buckets = new Map<string, { col: C3; list: LightSpillSource[] }>();
    for (const s of sources) {
        // A layer's light level is one alpha, so the source WEIGHT picks a bright / dim class (dim = 0.6x alpha).
        const key = s.color === SHOP_SPILL_COLOR ? 'shop' : 's' + spillBucket(s.color) + (s.weight >= 0.7 ? '' : 'd');
        let bk = buckets.get(key);
        if (!bk) { bk = { col: [0, 0, 0], list: [] }; buckets.set(key, bk); }
        bk.list.push(s);
        // the bucket's colour = the weight-averaged colour of its members
        for (let i = 0; i < 3; i++) bk.col[i] += s.color[i] * s.weight;
    }
    const out: LayoutPreviewLayer[] = [];
    const vpq = (GRID + 1) * (GRID + 1), ipq = GRID * GRID * 6;
    for (const [key, bk] of buckets) {
        const wsum = bk.list.reduce((t, s) => t + s.weight, 0) || 1;
        const col: C3 = [bk.col[0] / wsum, bk.col[1] / wsum, bk.col[2] / wsum];
        const v = new Float32Array(bk.list.length * vpq * 12), idx = new Uint32Array(bk.list.length * ipq);
        let o = 0, q = 0;
        bk.list.forEach((s, n) => {
            const ca = s.ax[0], sa = s.ax[1];
            for (let j = 0; j <= GRID; j++) for (let i = 0; i <= GRID; i++) {
                const u = i / GRID, w = j / GRID, du = (u * 2 - 1) * s.a, dv = (w * 2 - 1) * s.b;
                v[o] = s.x + du * ca - dv * sa; v[o + 1] = y; v[o + 2] = s.z + du * sa + dv * ca;
                v[o + 3] = 0; v[o + 4] = 1; v[o + 5] = 0;
                v[o + 6] = u; v[o + 7] = w;
                v[o + 8] = 1; v[o + 9] = 0; v[o + 10] = 0; v[o + 11] = 1;
                o += 12;
            }
            const b0 = n * vpq;
            for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
                const p = b0 + j * (GRID + 1) + i, r = p + GRID + 1;
                idx[q++] = p; idx[q++] = r + 1; idx[q++] = p + 1; idx[q++] = p; idx[q++] = r; idx[q++] = r + 1;
            }
        });
        out.push({
            name: key === 'shop' ? LIGHT_SPILL_LAYER : `${LIGHT_SPILL_LAYER}-${key}`, color: col, y: 0,
            geometry: { vertices: v, indices: idx, format: '12float' } as MeshGeometry,
            opacity: key === 'shop' ? opacity.shop : opacity.sign * (key.endsWith('d') ? 0.6 : 1), radialFade: true, emissive: 0, excludeFromFrame: true, drape: 'full',
        } as LayoutPreviewLayer);
    }
    return out;
}

/** Centre alpha of the shop / sign spill layers (the glow pass sets their colour; radialFade softens the rim). */
export const SPILL_OPACITY = { shop: 0.45, sign: 0.38 };

/** The whole spill for a graph: sources from its lot meta, laid at groundY + 3 cm. */
export function buildLightSpill(graph: Pick<WorldGraph, 'lots' | 'params'>, opacity?: { shop: number; sign: number }): LayoutPreviewLayer[] {
    const mpu = cityMetresPerUnit(graph.params.radius ?? 10);
    return lightSpillLayers(lightSpillSources(graph), graph.params.groundY + 0.03 / mpu, opacity);
}
