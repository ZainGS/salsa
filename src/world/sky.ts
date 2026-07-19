// ── World generation — night sky dressing ───────────────────────────────────────────────────────
// STARS + a MOON: tiny emissive blobs scattered on a high dome over the diorama, plus one pale moon disc.
// Built once with the city; the day/night cycle toggles their VISIBILITY (they only show at night, and hide
// under an overcast rain/snow deck) and cranks their glow — see world-manager._applyTimeOfDay.

import type { WorldGraph, LayoutPreviewLayer } from './types';
import { Accum3D } from './meshbuild';
import { hash2 } from './util';

/** Stars on an upper dome (radius ≈ 2.2R) + a moon. Layer names world:sky-* route BAKED (no terrain lift). */
export function buildSky(graph: WorldGraph): LayoutPreviewLayer[] {
    const p = graph.params, R = p.radius, gy = p.groundY, s = R / 10;
    const stars = new Accum3D(), moon = new Accum3D();
    const H = (a: number, b: number): number => hash2(a * 12.9898, b * 78.233, (p.seed ^ 0x57a2) >>> 0);

    const dome = 2.2 * R;
    for (let i = 0; i < 70; i++) {
        // Upper-hemisphere points, biased high (elevation angle 25°–85°) so stars sit above the skyline.
        const az = H(i, 1) * Math.PI * 2, el = (0.44 + H(i, 2) * 1.05);
        const x = Math.cos(az) * Math.cos(el) * dome, z = Math.sin(az) * Math.cos(el) * dome, y = gy + Math.sin(el) * dome;
        const r = (0.008 + H(i, 3) * 0.01) * s;
        stars.blob([x, y, z], r, r, r, 0, 0);
    }
    // One moon, high in the north-east quadrant.
    moon.blob([dome * 0.45, gy + dome * 0.72, -dome * 0.5], 0.1 * s, 0.1 * s, 0.1 * s, 0, 0);

    return [
        { name: 'world:sky-stars', color: [0.95, 0.96, 1.0], y: gy, geometry: stars.geometry(), emissive: 1.3 },
        { name: 'world:sky-moon', color: [0.92, 0.93, 0.86], y: gy, geometry: moon.geometry(), emissive: 1.1 },
    ];
}
