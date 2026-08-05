// ── World generation — BIKE RACK generator ──────────────────────────────────────────────────────
// A Sheffield-style cycle stand: a row of rounded inverted-U hoops in galvanised steel. The second prop
// rebuilt as a parametric generator (after vending) and the first with a MINIMAL manager — proof that a new
// creator costs a generator + ~8-line manager + a schema entry, nothing more (docs/specs/creator-modes.md
// §5.2 / city-props-garp.md Tier-2). Authored in real METRES; the caller supplies world-units-per-metre.
//
// One material family: it is all galvanised metal, so it's a single sub-layer. (Contrast the vending machine,
// which needed metal + glass + glow + products split across layers.) A minimal generator is a good schema
// stress-test — it proves the schema-driven panel handles a 4-knob prop as cleanly as an 8-knob one.

import type { LayoutPreviewLayer, V2 } from './types';
import { Accum3D } from './meshbuild';
import { METAL_GALVANISED } from './palette';

type V3 = [number, number, number];

export interface BikeRackParams {
    hoops: number;      // number of inverted-U hoops (2..8)
    lengthM: number;    // run length the hoops are spread across (metres)
    widthM: number;     // hoop width — the span a bike leans across (metres)
    heightM: number;    // hoop height (metres)
    seed: number;
}

export const DEFAULT_BIKE_RACK_PARAMS: BikeRackParams = {
    hoops: 3, lengthM: 1.8, widthM: 0.7, heightM: 0.75, seed: 1,
};

export function resolveBikeRackParams(p: Partial<BikeRackParams> = {}): BikeRackParams {
    return {
        ...DEFAULT_BIKE_RACK_PARAMS, ...p,
        hoops: Math.max(1, Math.min(8, Math.round(p.hoops ?? DEFAULT_BIKE_RACK_PARAMS.hoops))),
        lengthM: Math.max(0.3, p.lengthM ?? DEFAULT_BIKE_RACK_PARAMS.lengthM),
        widthM: Math.max(0.3, p.widthM ?? DEFAULT_BIKE_RACK_PARAMS.widthM),
        heightM: Math.max(0.4, p.heightM ?? DEFAULT_BIKE_RACK_PARAMS.heightM),
    };
}

export interface BikeRackMeta { height: number; footprint: [number, number][]; }

const TUBE_R = 0.021;   // ~42 mm steel tube, metres

/** Emit ONE bike rack into `acc` (a metal accumulator).
 *  @param base foot centre (world units) · @param dir unit facing (the run is PERPENDICULAR to this, so hoops
 *  face the direction bikes approach from) · @param worldPerMetre scale bridge (1 for a 1:1 preview). */
export function emitBikeRack(acc: Accum3D, base: V3, dir: V2, params: BikeRackParams, worldPerMetre: number): void {
    const f: V3 = [dir[0], 0, dir[1]];               // a bike leans across this axis (hoop width)
    const up: V3 = [0, 1, 0];
    const r: V3 = [-dir[1], 0, dir[0]];              // the RUN — hoops repeat along here

    const s = worldPerMetre;
    const h = params.heightM * s, w = params.widthM * s, len = params.lengthM * s, tr = TUBE_R * s;
    const cr = Math.min(0.12 * s, w * 0.3, h * 0.3); // rounded-corner radius

    // Local (run u along r, height v along up, lean f along f) → world point.
    const P = (u: number, v: number, d: number): V3 => [
        base[0] + r[0] * u + up[0] * v + f[0] * d,
        base[1] + r[1] * u + up[1] * v + f[1] * d,
        base[2] + r[2] * u + up[2] * v + f[2] * d,
    ];

    const n = params.hoops;
    for (let i = 0; i < n; i++) {
        const u = n > 1 ? -len / 2 + (i / (n - 1)) * len : 0;   // hoop position along the run
        // A rounded inverted-U in the (up, f) plane at run position u: post → chamfer → top → chamfer → post.
        acc.beam(P(u, 0, -w / 2), P(u, h - cr, -w / 2), tr, 6);                 // left post
        acc.beam(P(u, h - cr, -w / 2), P(u, h, -w / 2 + cr), tr, 6);           // left chamfer
        acc.beam(P(u, h, -w / 2 + cr), P(u, h, w / 2 - cr), tr, 6);            // top rail
        acc.beam(P(u, h, w / 2 - cr), P(u, h - cr, w / 2), tr, 6);             // right chamfer
        acc.beam(P(u, h - cr, w / 2), P(u, 0, w / 2), tr, 6);                  // right post
    }
}

/** The rack as one galvanised-metal layer. `metalScale` = detail frequency in cycles per WORLD UNIT. */
export function bikeRackLayers(acc: Accum3D, metalScale: number): LayoutPreviewLayer[] {
    if (acc.empty) return [];
    return [{ name: 'world:bike-rack', color: [0.62, 0.64, 0.66], y: 0, geometry: acc.geometry(),
        metal: { ...METAL_GALVANISED, scale: metalScale } }];
}

/** Standalone: build ONE rack at the origin, authored 1:1 in METRES, as layers + meta (the creator entry). */
export function buildBikeRack(params: Partial<BikeRackParams> = {}): { layers: LayoutPreviewLayer[]; meta: BikeRackMeta } {
    const p = resolveBikeRackParams(params);
    const acc = new Accum3D();
    emitBikeRack(acc, [0, 0, 0], [0, 1], p, 1);      // 1 world unit = 1 m
    const layers = bikeRackLayers(acc, 3);           // ~3 cycles/m metal detail at 1:1
    const hw = p.lengthM / 2, hd = p.widthM / 2;
    return { layers, meta: { height: p.heightM, footprint: [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] } };
}
