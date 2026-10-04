// ── World generation — CONTACT SHADOWS (persona-polish-plan A3) ─────────────────────────────────────────────
// Soft dark blobs on the ground under the things that stand on it (people, parked cars, benches, vending machines,
// bins, bikes, stalls …), so nothing looks pasted on — at night and under overcast skies too, where there is no sun
// shadow to do it. Cheapest robust option: ONE transparent layer of radial-fade quads per build group (the same
// `radialFade` material the lamp pools and the packaging stage blob use), derived from the finished layer geometry —
// no builder has to know about it, and it runs on the main-thread, worker and streamed-tile paths alike.
//
// How a footprint is found: vertices of the eligible layers are joined into connected parts (shared triangle
// indices), parts whose ground boxes overlap are merged (a person's legs, torso and head; a car's body and wheels),
// and each merged cluster's footprint is its principal axes in the ground plane (so a car on a diagonal street gets
// a diagonal blob). Instanced layers get one blob per instance from the canonical footprint.

import type { LayoutPreviewLayer } from './types';
import { cityMetresPerUnit } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';

/** Layer names that stand on the ground and should be grounded by a blob (name-keyed, like every city rule). */
export const CONTACT_SHADOW_LAYERS = /world:ped-|world:traffic-walker|world:car-(?!glass|chrome|sign|lens|band)|world:bench|world:vending-body|world:postbox$|world:bicycle-(tyre|frame)|world:trash|world:stall$|world:busstop$|world:a-board|world:crate|world:planter|world:metro-kiosk|world:local-xing-prop$|world:local-prop$/;

export interface ContactFootprint {
    /** Centre on the ground (world XZ) and the height the blob sits at (the cluster's lowest point). */
    x: number; z: number; y: number;
    /** Half-extents along the principal axis (a) and across it (b), and the axis angle (radians, from +X toward +Z). */
    a: number; b: number; angle: number;
}

export interface ContactShadowOptions {
    /** Blob size relative to the footprint (it spreads a little past the object). Default 1.35. */
    spread?: number;
    /** Blob opacity at its centre (radialFade dissolves it to 0 at the rim). Default 0.55. */
    opacity?: number;
    /** Lift above the contact point, in world units (avoids z-fighting with the ground). */
    lift?: number;
    /** Ignore clusters whose ground footprint is smaller than this half-extent (world units) — pebble-sized parts. */
    minHalf?: number;
    /** Cap on a blob's half-size (world units) — a bus shelter should not get a 10 m stain. */
    maxHalf?: number;
    /** Floor on a blob's half-size (world units): a person's footprint is only their feet, but the soft contact
     *  darkening P5 puts under a character is ~0.7 m across. */
    minBlob?: number;
}

const strideOf = (g: MeshGeometry): number => (g.format === '8float' ? 8 : g.format === '12float' ? 12 : (g.vertices.length % 12 === 0 ? 12 : 8));

/** Principal-axis footprint of a point set (xz arrays), sitting at `y`. */
function footprintOf(xs: number[], zs: number[], y: number): ContactFootprint | null {
    const n = xs.length;
    if (n === 0) return null;
    let mx = 0, mz = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; mz += zs[i]; }
    mx /= n; mz /= n;
    let sxx = 0, szz = 0, sxz = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dz = zs[i] - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
    const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const ca = Math.cos(angle), sa = Math.sin(angle);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dz = zs[i] - mz;
        const u = dx * ca + dz * sa, v = -dx * sa + dz * ca;
        if (u < a0) a0 = u; if (u > a1) a1 = u; if (v < b0) b0 = v; if (v > b1) b1 = v;
    }
    const cu = (a0 + a1) / 2, cv = (b0 + b1) / 2;
    return { x: mx + cu * ca - cv * sa, z: mz + cu * sa + cv * ca, y, a: (a1 - a0) / 2, b: (b1 - b0) / 2, angle };
}

/** Footprints of every grounded object in `layers` (the eligible ones by name). Pure; O(vertices). */
export function contactFootprints(layers: LayoutPreviewLayer[], opts: ContactShadowOptions = {}): ContactFootprint[] {
    const minHalf = opts.minHalf ?? 0;
    const out: ContactFootprint[] = [];
    // ── Instanced layers: one canonical footprint, stamped per instance ──
    const merged: { L: LayoutPreviewLayer; base: number }[] = [];
    let total = 0;
    for (const L of layers) {
        if (!CONTACT_SHADOW_LAYERS.test(L.name) || !L.geometry || L.geometry.vertices.length === 0 || L.noContact) continue;   // (P12: the instanced crowd's AUX footprint layer stands in for its copies)
        if (L.nearTwin?.uvFromNear && L.nearTwin.role !== 'near') continue;   // P9 prop far twin: a copy of its near twin
        const inst = (L as { instances?: { x: number; y: number; z: number; ry: number; s?: number }[] }).instances;
        if (inst?.length) {
            const st = strideOf(L.geometry), v = L.geometry.vertices, xs: number[] = [], zs: number[] = [];
            let minY = Infinity;
            for (let i = 0; i < v.length; i += st) { xs.push(v[i]); zs.push(v[i + 2]); if (v[i + 1] < minY) minY = v[i + 1]; }
            const f = footprintOf(xs, zs, minY);
            if (!f || Math.max(f.a, f.b) < minHalf) continue;
            for (const t of inst) {
                const s = t.s ?? 1, c = Math.cos(t.ry), sn = Math.sin(t.ry);
                // Mesh3D rotation about Y by ry: x' = x cos + z sin, z' = -x sin + z cos.
                out.push({ x: t.x + (f.x * c + f.z * sn) * s, z: t.z + (-f.x * sn + f.z * c) * s, y: t.y + f.y * s,
                    a: f.a * s, b: f.b * s, angle: f.angle - t.ry });
            }
            continue;
        }
        merged.push({ L, base: total });
        total += L.geometry.vertices.length / strideOf(L.geometry);
    }
    if (total === 0) return out;
    // ── Connected parts over all eligible (world-baked) layers ──
    const parent = new Int32Array(total);
    for (let i = 0; i < total; i++) parent[i] = i;
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a: number, b: number): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const X = new Float32Array(total), Y = new Float32Array(total), Z = new Float32Array(total);
    for (const { L, base } of merged) {
        const g = L.geometry, st = strideOf(g), v = g.vertices, n = v.length / st;
        for (let i = 0; i < n; i++) { X[base + i] = v[i * st]; Y[base + i] = v[i * st + 1]; Z[base + i] = v[i * st + 2]; }
        const idx = g.indices;
        for (let t = 0; t + 2 < idx.length; t += 3) { union(base + idx[t], base + idx[t + 1]); union(base + idx[t], base + idx[t + 2]); }
    }
    // Part boxes (ground plane + lowest point).
    const partOf = new Map<number, number>();
    const boxes: number[][] = [];   // [minX, minZ, maxX, maxZ, minY]
    const partIdx = new Int32Array(total);
    for (let i = 0; i < total; i++) {
        const r = find(i);
        let p = partOf.get(r);
        if (p === undefined) { p = boxes.length; partOf.set(r, p); boxes.push([Infinity, Infinity, -Infinity, -Infinity, Infinity]); }
        partIdx[i] = p;
        const b = boxes[p];
        if (X[i] < b[0]) b[0] = X[i]; if (Z[i] < b[1]) b[1] = Z[i]; if (X[i] > b[2]) b[2] = X[i]; if (Z[i] > b[3]) b[3] = Z[i]; if (Y[i] < b[4]) b[4] = Y[i];
    }
    // Merge parts whose ground boxes overlap (sweep on minX).
    const np = boxes.length;
    const pp = new Int32Array(np);
    for (let i = 0; i < np; i++) pp[i] = i;
    const pfind = (i: number): number => { while (pp[i] !== i) { pp[i] = pp[pp[i]]; i = pp[i]; } return i; };
    const order = Array.from({ length: np }, (_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
    const active: number[] = [];
    for (const i of order) {
        const bi = boxes[i];
        for (let k = active.length - 1; k >= 0; k--) {
            const j = active[k], bj = boxes[j];
            if (bj[2] < bi[0]) { active.splice(k, 1); continue; }   // ended before this one starts
            if (bj[1] <= bi[3] && bi[1] <= bj[3]) { const ri = pfind(i), rj = pfind(j); if (ri !== rj) pp[ri] = rj; }
        }
        active.push(i);
    }
    // Gather each merged cluster's points → its footprint.
    const clusters = new Map<number, { xs: number[]; zs: number[]; y: number }>();
    for (let i = 0; i < total; i++) {
        const c = pfind(partIdx[i]);
        let e = clusters.get(c);
        if (!e) { e = { xs: [], zs: [], y: Infinity }; clusters.set(c, e); }
        e.xs.push(X[i]); e.zs.push(Z[i]); if (Y[i] < e.y) e.y = Y[i];
    }
    for (const e of clusters.values()) {
        const f = footprintOf(e.xs, e.zs, e.y);
        if (f && Math.max(f.a, f.b) >= minHalf) out.push(f);
    }
    return out;
}

/** The blob layer for a set of footprints (null when there are none). Quads with unit radial UVs; `radialFade` fades
 *  each to nothing at its rim, so the centre is the darkest. Transparent → never a shadow caster. */
export function contactShadowLayer(fps: ContactFootprint[], opts: ContactShadowOptions = {}): LayoutPreviewLayer | null {
    if (!fps.length) return null;
    const spread = opts.spread ?? 1.35, lift = opts.lift ?? 0, maxHalf = opts.maxHalf ?? Infinity, minBlob = opts.minBlob ?? 0;
    const v = new Float32Array(fps.length * 4 * 12);
    const idx = new Uint32Array(fps.length * 6);
    let o = 0, q = 0;
    fps.forEach((f, n) => {
        // A round-ish minimum: a thin person still gets a soft disc, a car an elongated oval.
        const a = Math.max(minBlob, Math.min(maxHalf, Math.max(f.a, f.b * 0.6)) * spread);
        const b = Math.max(minBlob, Math.min(maxHalf, Math.max(f.b, f.a * 0.45)) * spread);
        const ca = Math.cos(f.angle), sa = Math.sin(f.angle);
        const corners: [number, number, number, number][] = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
        for (const [cu, cv, u, w] of corners) {
            const du = cu * a, dv = cv * b;
            v[o] = f.x + du * ca - dv * sa; v[o + 1] = f.y + lift; v[o + 2] = f.z + du * sa + dv * ca;
            v[o + 3] = 0; v[o + 4] = 1; v[o + 5] = 0;           // up normal
            v[o + 6] = u; v[o + 7] = w;
            v[o + 8] = 1; v[o + 9] = 0; v[o + 10] = 0; v[o + 11] = 1;
            o += 12;
        }
        const b0 = n * 4;
        idx[q++] = b0; idx[q++] = b0 + 2; idx[q++] = b0 + 1; idx[q++] = b0; idx[q++] = b0 + 3; idx[q++] = b0 + 2;
    });
    return {
        name: 'world:contact-shadow', color: [0, 0, 0], y: 0,
        geometry: { vertices: v, indices: idx, format: '12float' } as MeshGeometry,
        opacity: opts.opacity ?? 0.55, radialFade: true, emissive: 0, excludeFromFrame: true, drape: 'baked', noWarp: true,
    } as LayoutPreviewLayer;
}

/** `layers` plus their contact-shadow layer (when any eligible object is present). */
export function withContactShadows(layers: LayoutPreviewLayer[], opts: ContactShadowOptions = {}): LayoutPreviewLayer[] {
    if (!layers.some((L) => CONTACT_SHADOW_LAYERS.test(L.name))) return layers;
    const layer = contactShadowLayer(contactFootprints(layers, opts), opts);
    return layer ? [...layers, layer] : layers;
}

/** The city's contact-shadow options for a city of `radius` (metres → world units) — ONE source for the main-thread
 *  staging (WorldManager._withContactShadows) and the worker builds (centre / selective), so both make the same blobs. */
export function cityContactShadowOptions(radius: number, opacity: number): ContactShadowOptions {
    const mpu = cityMetresPerUnit(radius);
    return { lift: 0.03 / mpu, minHalf: 0.1 / mpu, maxHalf: 3.5 / mpu, minBlob: 0.38 / mpu, spread: 1.45, opacity };
}

/** Marker a WORKER build stamps on a group's layers once its contact blobs are built (performance-plan P3.2): the
 *  blobs must be computed over the WHOLE group (a person's colour layers cluster into ONE blob) — the main-thread
 *  reassembly splits a group into jobs, so recomputing there would split every person into per-part blobs. */
export const CONTACT_DONE = '__contactDone';
export function markContactDone(layers: LayoutPreviewLayer[]): void { for (const L of layers) (L as unknown as Record<string, unknown>)[CONTACT_DONE] = true; }
export function isContactDone(layers: readonly LayoutPreviewLayer[]): boolean { return layers.length > 0 && layers.every(L => (L as unknown as Record<string, unknown>)[CONTACT_DONE] === true); }

/** withContactShadows over a WHOLE group, then mark it done. Never throws (a grounding nicety must not break a build). */
export function groupWithContactShadows(layers: LayoutPreviewLayer[], opts: ContactShadowOptions): LayoutPreviewLayer[] {
    let out = layers;
    try { out = withContactShadows(layers, opts); } catch { out = layers; }
    markContactDone(out);
    return out;
}
