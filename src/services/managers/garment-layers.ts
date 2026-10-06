/**
 * garment-layers.ts — a STRICT LAYER ORDER for a character's garments (clothing fit round 2, 2026-10-04).
 *
 *     underpants · undershirt · socks  <  trousers / skirt (bottom)  <  top
 *
 * Every garment is fitted to the BODY on its own, so where two overlap (a tee's hem over a skirt's waistband, trousers
 * over a crew sock) nothing decided which one is outside: the skirt waist showed through the shirt hem, a sock cuff
 * poked through the trouser leg. layerOutfit() pushes every OUTER garment vertex that sits inside / too close to an
 * INNER garment out to `gap` over it (along the inner surface's normal) and blends its skin weights toward the inner
 * garment's there, so the two move together and the order holds when posed. Pure + deterministic: Scene3DCharacter
 * applies it to the raw generated garments after every change, and the character worker (character-parts.ts) builds
 * the hair's collision soup from the same layered result.
 * Skirts are never moved (their leg-follow steer rewrites their weights every frame); a skirt is only ever an INNER
 * layer (under a top).
 */

import { TriRayGrid } from './body-hide-mask';

export type LayerSlot = 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants';

/** Which inner slots each outer slot is layered over, in processing order (inner layers first). */
export const LAYER_OVER: readonly [LayerSlot, readonly LayerSlot[]][] = [
    ['bottom', ['socks', 'underpants']],
    ['top', ['bottom', 'undershirt']],
];

export interface LayerGarment {
    geometry: { vertices: Float32Array; indices: Uint32Array };
    jointIndices: Uint8Array;
    jointWeights: Float32Array;
}

/** Clearance an outer layer keeps over an inner one (m). */
export const LAYER_GAP = 0.006;
// BLEND: the weight hand-over fades out this far above the gap — small, so a tee that merely hangs near an undershirt
// keeps its own weights; only the overlap band follows the layer under it.
const REACH = 0.08, BLEND = 0.006, MAX_PUSH = 0.08;

/** The skeleton's LEFT / RIGHT limb joints (by the `_L` / `_R` name suffix) — layerOver's side mask. */
export interface LimbSides { L: ReadonlySet<number>; R: ReadonlySet<number> }
export function limbSidesFromNames(names: readonly string[]): LimbSides {
    const L = new Set<number>(), R = new Set<number>();
    names.forEach((n, i) => { if (n.endsWith('_L')) L.add(i); else if (n.endsWith('_R')) R.add(i); });
    return { L, R };
}
/** 1 = bound mostly (> 50 %) to left-limb joints, 2 = right, 0 = neither (hips / spine / a mixed crotch vert). */
function sideOf(ji: ArrayLike<number>, jw: ArrayLike<number>, i: number, sides: LimbSides): 0 | 1 | 2 {
    let l = 0, r = 0;
    for (let k = 0; k < 4; k++) { const j = ji[i * 4 + k], w = jw[i * 4 + k]; if (sides.L.has(j)) l += w; else if (sides.R.has(j)) r += w; }
    return l > 0.5 ? 1 : r > 0.5 ? 2 : 0;
}

/**
 * Push `outer` (a copy is returned; the input is untouched) over `inners`. Returns the moved vertex count too.
 * `movable` (optional) limits it to some vertices (the hair: only head-bound card / cap verts below the nape).
 * `sides` (optional, the trousers-web fix 2026-10-04): a LEFT-limb outer vertex never layers over a RIGHT-limb inner
 * surface or takes its weights (and vice versa). Without it the inner hem of a trouser leg, whose normal points at the
 * other leg, ray-hit the OTHER leg's sock, read as "inside" it, was pushed through it and took its foot / shin weights:
 * in a stride the two hems were joined by a long web of triangles (measured: 12-16 hem verts at foot_R 1.0 on the left
 * leg, edges stretched 40-380x on a side split).
 */
export function layerOver(outer: LayerGarment, inners: LayerGarment[], gap = LAYER_GAP, movable?: (vertex: number) => boolean, alongInner = false, sides?: LimbSides): { garment: LayerGarment; moved: number } {
    const V = new Float32Array(outer.geometry.vertices), ji = new Uint8Array(outer.jointIndices), jw = new Float32Array(outer.jointWeights);
    const garment: LayerGarment = { geometry: { vertices: V, indices: outer.geometry.indices }, jointIndices: ji, jointWeights: jw };
    if (!inners.length) return { garment, moved: 0 };
    // Spatial hash over every inner vertex.
    const cell = REACH, inv = 1 / cell, map = new Map<string, [number, number][]>();
    inners.forEach((g, gi) => {
        const P = g.geometry.vertices;
        for (let i = 0; i < P.length / 12; i++) {
            const k = `${Math.floor(P[i * 12] * inv)},${Math.floor(P[i * 12 + 1] * inv)},${Math.floor(P[i * 12 + 2] * inv)}`;
            let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push([gi, i]);
        }
    });
    const grid = new TriRayGrid(inners.map((g) => ({ verts: g.geometry.vertices, indices: g.geometry.indices })), 0.03);
    // Side mask: per inner vertex its limb side, and a ray grid per outer side without the opposite limb's triangles.
    const innerSide = sides ? inners.map((g) => { const n = g.geometry.vertices.length / 12, a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = sideOf(g.jointIndices, g.jointWeights, i, sides); return a; }) : null;
    const gridWithout = (drop: 1 | 2) => new TriRayGrid(inners.map((g, gi) => {
        const I = g.geometry.indices, keep: number[] = [];
        for (let t = 0; t + 2 < I.length; t += 3) if (innerSide![gi][I[t]] !== drop && innerSide![gi][I[t + 1]] !== drop && innerSide![gi][I[t + 2]] !== drop) keep.push(I[t], I[t + 1], I[t + 2]);
        return { verts: g.geometry.vertices, indices: Uint32Array.from(keep) };
    }), 0.03);
    const sideGrids: (TriRayGrid | null)[] = [grid, null, null];   // [neutral, left outer (no right tris), right outer (no left tris)], built on demand
    let moved = 0;
    const acc = new Map<number, number>();
    for (let o = 0; o < V.length / 12; o++) {
        if (movable && !movable(o)) continue;
        const x = V[o * 12], y = V[o * 12 + 1], z = V[o * 12 + 2];
        const os = sides ? sideOf(ji, jw, o, sides) : 0, opp = os === 1 ? 2 : os === 2 ? 1 : 0;
        const g = os === 0 ? grid : (sideGrids[os] ??= gridWithout(opp as 1 | 2));
        const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
        let best: [number, number] | null = null, bd = REACH * REACH;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
            for (const e of map.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
                const P = inners[e[0]].geometry.vertices, i = e[1];
                if (opp && innerSide![e[0]][i] === opp) continue;   // never the other limb's layer
                const d = (P[i * 12] - x) ** 2 + (P[i * 12 + 1] - y) ** 2 + (P[i * 12 + 2] - z) ** 2;
                if (d < bd) { bd = d; best = e; }
            }
        }
        // Height over the inner layer along the OUTER vertex's own normal, against the inner TRIANGLES (a nearest-vertex
        // plane misses on a sparse skirt ring): the inner surface out in front = this vertex is inside it (d < 0); behind
        // it within gap + BLEND = too close (0 ≤ d).
        // (alongInner: the nearest INNER vertex's normal instead — hair cards are double-sided, their own normals point
        // either way.)
        const src = alongInner && best ? inners[best[0]].geometry.vertices : V, si = alongInner && best ? best[1] : o;
        if (alongInner && !best) continue;
        let nx = src[si * 12 + 3], ny = src[si * 12 + 4], nz = src[si * 12 + 5];
        const nl = Math.hypot(nx, ny, nz); if (nl < 1e-8) continue;
        nx /= nl; ny /= nl; nz /= nl;
        let d: number;
        const tOut = g.raycast(x, y, z, nx, ny, nz, MAX_PUSH);
        if (tOut < Infinity) d = -tOut;
        else {
            const tIn = g.raycast(x, y, z, -nx, -ny, -nz, gap + BLEND);
            if (tIn === Infinity) continue;
            d = tIn;
        }
        if (d < gap) {
            let push = gap - d, px = x + nx * push, py = y + ny * push, pz = z + nz * push;
            // A second inner surface right behind the first (a skirt waistband's folded rim) — keep going, at most twice more.
            for (let k = 0; k < 2; k++) {
                const t2 = g.raycast(px, py, pz, nx, ny, nz, MAX_PUSH);
                if (t2 === Infinity || push + t2 + gap > 2 * MAX_PUSH) break;
                push += t2 + gap; px = x + nx * push; py = y + ny * push; pz = z + nz * push;
            }
            V[o * 12] = px; V[o * 12 + 1] = py; V[o * 12 + 2] = pz;
            moved++;
        }        if (!best) continue;
        const ig = inners[best[0]], i = best[1];
        // Weights: fully the inner layer's where pushed, fading back to the garment's own over BLEND above the gap.
        const bl = d <= gap ? 1 : 1 - (d - gap) / BLEND;
        if (bl <= 0) continue;
        acc.clear();
        for (let k = 0; k < 4; k++) { const w = jw[o * 4 + k] * (1 - bl); if (w > 0) acc.set(ji[o * 4 + k], (acc.get(ji[o * 4 + k]) ?? 0) + w); }
        for (let k = 0; k < 4; k++) { const w = ig.jointWeights[i * 4 + k] * bl; if (w > 0) acc.set(ig.jointIndices[i * 4 + k], (acc.get(ig.jointIndices[i * 4 + k]) ?? 0) + w); }
        const top = [...acc].sort((p, q) => (q[1] - p[1]) || (p[0] - q[0])).slice(0, 4);
        const sum = top.reduce((s, r) => s + r[1], 0) || 1;
        for (let k = 0; k < 4; k++) { ji[o * 4 + k] = top[k]?.[0] ?? 0; jw[o * 4 + k] = (top[k]?.[1] ?? 0) / sum; }
    }
    return { garment, moved };
}

/** The whole outfit in layer order. `isSkirt(slot)` marks a skirt bottom (never moved). Returns layered copies only for
 *  the garments that changed; the rest are the inputs themselves. */
export function layerOutfit<T extends LayerGarment>(bySlot: Partial<Record<LayerSlot, T>>, isSkirt: (slot: LayerSlot) => boolean, sides?: LimbSides): Partial<Record<LayerSlot, T | LayerGarment>> {
    const out: Partial<Record<LayerSlot, T | LayerGarment>> = { ...bySlot };
    for (const [outerSlot, innerSlots] of LAYER_OVER) {
        const outer = out[outerSlot];
        if (!outer || isSkirt(outerSlot)) continue;
        const inners = innerSlots.map((s) => out[s]).filter((g): g is T | LayerGarment => !!g);
        if (!inners.length) continue;
        const r = layerOver(outer, inners, LAYER_GAP, undefined, false, sides);
        if (r.moved > 0 || weightsChanged(outer, r.garment)) out[outerSlot] = r.garment;
    }
    return out;
}

function weightsChanged(a: LayerGarment, b: LayerGarment): boolean {
    for (let i = 0; i < a.jointWeights.length; i++) if (a.jointWeights[i] !== b.jointWeights[i] || a.jointIndices[i] !== b.jointIndices[i]) return true;
    return false;
}
