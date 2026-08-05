// ── World generation — ROAD SIGNS (regulatory text + warning pictograms) ─────────────────────────────
// Small pole-mounted signs on a free junction corner. REGULATORY plates carry real rasterized TEXT (NO PARKING /
// ONE WAY / DO NOT ENTER / SPEED) through the signtext rasterizer; WARNING signs are yellow-diamond PICTOGRAMS
// wired as a GARP pool so a world can swap in stylized skins (pedestrian / construction / curve / generic). One
// sign per selected junction, placed on the corner the signals/vending/corner-props DON'T use, so it never fights
// the curb-furniture reservation. The pole is baked; the warning face is GARP-instanced — BOTH bake the terrain
// lift here (like the poles in furniture.ts) so they never separate or sink on a slope.

import type { WorldGraph, LayoutPreviewLayer, V2, InstanceXform } from './types';
import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { GarpPool } from './garp';
import type { TextSignSpec } from './signtext';
import { cityMetresPerUnit, metalScaleFor } from './types';
import { Accum3D } from './meshbuild';
import { signQuad } from './signtext';
import { regionAt } from './layout';
import { cellLevelAt, makeElevation } from './elevation';
import { inShotengai } from './shotengai';
import { hash2, pointInPolygon } from './util';
import { METAL_GALVANISED } from './palette';

type V3 = [number, number, number];
type RGB = [number, number, number];

const POLE: RGB = [0.62, 0.63, 0.66];        // galvanised sign pole
const REG_RED: RGB = [0.72, 0.15, 0.15];     // regulatory red (no parking / do not enter)
const REG_WHITE: RGB = [0.90, 0.90, 0.92];   // white regulatory plate (speed)

const nrm2 = (d: V2): V2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };

// Regulatory labels + plate colour (the rasterizer draws cream lettering on the plate colour).
const REGULATORY: { label: string; color: RGB }[] = [
    { label: 'NO PARKING', color: REG_RED },
    { label: 'ONE WAY', color: [0.10, 0.10, 0.12] },
    { label: 'DO NOT ENTER', color: REG_RED },
    { label: 'SPEED 30', color: REG_WHITE },
];

export interface RoadSignBuild { layers: LayoutPreviewLayer[]; textSigns: TextSignSpec[]; }

// ── Warning GARP pool (a yellow-diamond pictogram face) ───────────────────────────────────────────────
export const WARNING_CANON_M = 0.6;   // diamond width (m)
export const WARNING_SKINS = ['pedestrian', 'construction', 'curve', 'generic'];
export function warningSkinKey(name: string): string { return `warning/${name}/face`; }
export function warningGarpPool(): GarpPool {
    return {
        id: 'salsa/warning', name: 'Warning signs', version: 1, size: [512, 512], slots: ['face'],
        defaults: { face: warningSkinKey('generic') },
        skins: WARNING_SKINS.map((n) => ({ name: n, slots: { face: warningSkinKey(n) } })),
    };
}
/** ONE canonical warning face — a diamond (45°-rotated square) quad with 0..1 UV, standing vertical facing +Z.
 *  The corners map to the square-texture edge midpoints so a skin (a drawn pictogram) reads upright on it. */
export function warningCanonicalGeometry(worldPerMetre: number): MeshGeometry {
    const a = new Accum3D();
    const h = WARNING_CANON_M * 0.5 * worldPerMetre;
    a.quadUV4([0, h, 0], [h, 0, 0], [0, -h, 0], [-h, 0, 0], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]);   // top/right/bottom/left
    return a.geometry();
}
/** One warning-diamond instance at `base` (its centre), facing `dir` (V2, up the road toward oncoming traffic). */
export function warningInstanceTransform(base: V3, dir: V2, _worldPerMetre: number): InstanceXform {
    return { x: base[0], y: base[1], z: base[2], ry: Math.atan2(dir[0], dir[1]), s: 1 };
}

/** Regulatory + warning road signs for a graph. Returns baked layers (poles + warning GARP) and the regulatory
 *  TEXT specs (the WorldManager rasterizes their labels). Deterministic per (intersection, seed). */
export function buildRoadSigns(graph: WorldGraph, keep?: ((region: number) => boolean) | null): RoadSignBuild {
    const p = graph.params;
    if (!(p.streetFurniture ?? true)) return { layers: [], textSigns: [] };
    const gy = p.groundY, s = p.radius / 10, half = p.streetWidth * 0.5;
    const wpm = 1 / cityMetresPerUnit(p.radius);
    const lift = makeElevation(graph);
    const pole = new Accum3D();
    const warnInst: InstanceXform[] = [];
    const textSigns: TextSignSpec[] = [];
    const border = graph.border;
    const overWater = (x: number, z: number): boolean =>
        cellLevelAt(graph, x, z) < 0 || (border.length >= 3 && !pointInPolygon([x, z], border));   // canal OR past the border (sea)
    let idx = 0;

    graph.intersections.forEach((it, ii) => {
        if (keep && !keep(regionAt(graph, it.pos[0], it.pos[1]) ?? -1)) return;
        if (overWater(it.pos[0], it.pos[1]) || inShotengai(graph, it.pos[0], it.pos[1])) return;
        const roll = hash2(ii * 7.1, 3.3, (p.seed ^ 0x2b71) >>> 0);
        if (roll > 0.4) return;   // ~40% of junctions get a road sign

        const d0 = nrm2(it.arms[0]), pd: V2 = [-d0[1], d0[0]];
        // The FREE corner — signals take (+pW,−dW), vending (+d0,+pd), corner-props (+d0,−pd); this is (−d0,−pd).
        const cOff = half + 0.05 * s;
        const fx = it.pos[0] + (-d0[0] - pd[0]) * cOff, fz = it.pos[1] + (-d0[1] - pd[1]) * cOff;
        if (overWater(fx, fz)) return;
        const cy = gy + lift(fx, fz);                          // bake the slope into BOTH pole + face
        const poleH = 0.16 * s, r = 0.006 * s;                 // ~2.4 m pole
        pole.prism([fx, cy, fz], r, r, poleH, 6);
        const face: V2 = [d0[0], d0[1]];                       // sign faces up the road toward oncoming traffic

        if (roll < 0.22) {
            warnInst.push(warningInstanceTransform([fx, cy + poleH + 0.02 * s, fz], face, wpm));   // warning diamond (GARP)
        } else {
            const reg = REGULATORY[(hash2(ii * 3.9, 9.2, (p.seed ^ 0x77c3) >>> 0) * REGULATORY.length) | 0];
            const c: V3 = [fx, cy + poleH + 0.02 * s, fz];
            textSigns.push({
                label: reg.label,
                layer: {
                    name: 'world:roadsign-reg' + idx, color: reg.color, y: gy, emissive: 0.4, singleSided: true,
                    geometry: signQuad(c, pd, face, 0.028 * s, 0.020 * s),
                },
            });
        }
        idx++;
    });

    const layers: LayoutPreviewLayer[] = [];
    if (!pole.empty) layers.push({
        name: 'world:roadsign-pole', color: POLE, y: gy, geometry: pole.geometry(), drape: 'baked',
        metal: { ...METAL_GALVANISED, scale: metalScaleFor(p.radius) },
    });
    if (warnInst.length) layers.push({
        name: 'world:warning', color: [1, 1, 1], y: gy, geometry: warningCanonicalGeometry(wpm), instances: warnInst,
        arrayGroup: true, drape: 'baked', singleSided: false, garp: { pool: warningGarpPool().id, slot: 'face', seed: p.seed },
    });
    return { layers, textSigns };
}
