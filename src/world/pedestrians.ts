// ── World generation — pedestrians (static crowd v1) ────────────────────────────────────────────
// Tiny low-poly people scattered on the sidewalks, the shotengai corridor and the plaza, so streets read
// POPULATED at diorama scale. Each is just a clothing-coloured body prism + a skin head blob (merged per
// clothing colour → a handful of draws). Position-hash deterministic, canal-skipping, region-filterable,
// count-capped. MOVING crowds are a later `src/game/` sim tick (these anchors double as spawn hints).

import type { WorldGraph, LayoutPreviewLayer, V2 } from './types';
import { hash2, pointInPolygon } from './util';
import { Accum3D } from './meshbuild';
import { makeWaterTest } from './elevation';
import { regionAt } from './layout';

const CLOTHES: [number, number, number][] = [
    [0.82, 0.30, 0.28], [0.24, 0.38, 0.62], [0.92, 0.86, 0.78], [0.28, 0.50, 0.38], [0.20, 0.20, 0.24], [0.85, 0.62, 0.32],
];
const NAMES = ['red', 'blue', 'cream', 'green', 'black', 'amber'];
const SKIN: [number, number, number] = [0.92, 0.78, 0.66];

export function buildPedestrians(graph: WorldGraph, keep?: ((region: number) => boolean) | null): LayoutPreviewLayer[] {
    const p = graph.params;
    if (!(p.pedestrians ?? true)) return [];
    const gy = p.groundY, s = p.radius / 10, half = p.streetWidth * 0.5;
    const H = (a: number, b: number, salt: number): number => hash2(a, b, (p.seed ^ salt) >>> 0);
    const border = graph.border, bridges = graph.bridges;
    const onBridge = (x: number, z: number): boolean => { for (const deck of bridges) if (pointInPolygon([x, z], deck)) return true; return false; };
    const isWater = makeWaterTest(graph);   // canals + ponds + water-zoned lots — pedestrians don't walk on water
    const ok = (x: number, z: number): boolean =>
        (onBridge(x, z) || (!isWater(x, z) && (border.length < 3 || pointInPolygon([x, z], border)))) &&   // off the water / inside the border, but bridges are fine
        (!keep || keep(regionAt(graph, x, z) ?? -1));

    const bodies = CLOTHES.map(() => new Accum3D());
    const heads = new Accum3D();
    let count = 0;
    const dens = Math.max(0.1, p.pedestrianDensity ?? 1);   // crowd multiplier (finer scatter + higher cap)
    const CAP = Math.round(700 * dens);

    const person = (x: number, z: number, h1: number, h2: number): void => {
        if (count >= CAP) return;
        count++;
        // Real human height: body+head ≈ 0.108·s ≈ 1.6 m (X·s = 15·X m). Was ~0.055·s ≈ 0.85 m — half-scale, which
        // made the correctly-sized 1.8 m vending machines and 2.0 m doors read as "too big" next to the crowd.
        const bh = (0.078 + h1 * 0.024) * s, br = 0.0092 * s;
        const b = bodies[(h2 * CLOTHES.length) | 0];
        b.prism([x, gy, z], br, br * 0.8, bh, 5, h1 * Math.PI);
        heads.blob([x, gy + bh + 0.009 * s, z], 0.0088 * s, 0.0098 * s, 0.0088 * s, 0, 0);
    };

    // Sidewalk strollers along the streets (both sides, sparse), clear of the junction mouths.
    graph.roads.forEach((road, ri) => {
        if (road.klass === 'alley' || road.klass === 'ring') return;
        const a = road.a, dx = road.b[0] - a[0], dz = road.b[1] - a[1], len = Math.hypot(dx, dz);
        if (len < 0.6 * s) return;
        const px = -dz / len, pz = dx / len, n = Math.floor(len * dens / (0.16 * s));   // finer scatter with density
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n;
            if (t * len < half + 0.1 * s || (1 - t) * len < half + 0.1 * s) continue;
            if (H(ri, i, 0x9ed1) > 0.16) continue;
            const side = H(ri, i, 0x44a7) < 0.5 ? 1 : -1;
            const wob = (H(ri, i, 0x71c3) - 0.5) * 0.04 * s;   // drift across the sidewalk band
            const x = a[0] + dx * t + px * (half + 0.045 * s + wob) * side, z = a[1] + dz * t + pz * (half + 0.045 * s + wob) * side;
            if (!ok(x, z)) continue;
            person(x, z, H(ri, i, 0x1357), H(ri, i, 0x2468));
        }
    });

    // The shotengai corridor is BUSY (it is the pedestrian street, after all).
    const sg = graph.shotengai;
    if (sg && (!keep || keep(sg.region))) {
        const dx = sg.spine[1][0] - sg.spine[0][0], dz = sg.spine[1][1] - sg.spine[0][1], L = Math.hypot(dx, dz) || 1;
        const px = -dz / L, pz = dx / L, n = Math.floor(L * dens / (0.08 * s));
        for (let i = 0; i < n; i++) {
            if (H(i, 7, 0x5e0f) > 0.5) continue;
            const t = (i + 0.5) / n, u = (H(i, 8, 0x66d2) - 0.5) * sg.width * 0.7;
            const x = sg.spine[0][0] + dx * t + px * u, z = sg.spine[0][1] + dz * t + pz * u;
            if (!ok(x, z)) continue;
            person(x, z, H(i, 9, 0x1948), H(i, 10, 0x3b7a));
        }
    }

    // A few on the plaza.
    if (graph.plaza && graph.plaza.length >= 3) {
        const R = p.radius * p.plazaRadius;
        for (let i = 0; i < Math.round(14 * dens); i++) {
            const ang = H(i, 11, 0x0f5a) * Math.PI * 2, r = Math.sqrt(H(i, 12, 0x7d31)) * R * 0.85;
            const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
            if (!pointInPolygon([x, z], graph.plaza) || !ok(x, z)) continue;
            person(x, z, H(i, 13, 0x24bd), H(i, 14, 0x59c6));
        }
    }

    const out: LayoutPreviewLayer[] = [];
    bodies.forEach((acc, i) => { if (!acc.empty) out.push({ name: 'world:ped-' + NAMES[i], color: CLOTHES[i], y: gy, geometry: acc.geometry() }); });
    if (!heads.empty) out.push({ name: 'world:ped-skin', color: SKIN, y: gy, geometry: heads.geometry() });
    return out;
}
