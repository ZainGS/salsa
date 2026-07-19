// ── World generation — elevation ────────────────────────────────────────────────────────────────
// A gentle, deterministic terrain height field. Applied as a POST-transform over every layer's geometry
// (`applyHeightField`): flat map polygons DRAPE over the terrain (per-vertex), and rigid props (buildings,
// trees, poles) lift with their base — because a wall's base+top share the same (x,z), they rise together.
// Kept LOW-FREQUENCY so within one small building footprint the height barely changes (negligible warp);
// the whole city gets rolling hills / a raised side instead. Steeper terrain + per-building flat bases would
// be the follow-up. The deliberate canal lower-level + retaining walls + stairs also build on this later.

import type { MeshGeometry } from '../renderer/3d/mesh-generators';
import type { LayoutParams } from './types';
import { valueNoise2D } from './util';

/** Terrain height DELTA (± around 0), a pure function of world (x,z). `elevation` param scales the amplitude. */
export function makeHeightField(params: LayoutParams): (x: number, z: number) => number {
    const amp = (params.elevation ?? 0) * params.radius * 0.05;   // subtle rolling (was 0.18 = too dramatic)
    if (amp < 1e-4) return () => 0;
    const seed = (params.seed ^ 0xe1e7a7) >>> 0;
    const f0 = 1 / (params.radius * 0.7);
    return (x, z) => {
        const h = 0.72 * valueNoise2D(x * f0, z * f0, seed) + 0.28 * valueNoise2D(x * f0 * 2.3, z * f0 * 2.3, seed + 7);
        return (h - 0.5) * 2 * amp;
    };
}

/** Add the terrain delta to every vertex's Y in-place. */
export function applyHeightField(geo: MeshGeometry, fn: (x: number, z: number) => number): void {
    const v = geo.vertices;
    for (let i = 0; i < v.length; i += 12) v[i + 1] += fn(v[i], v[i + 2]);
}

/** The world height of one discrete terrace level. */
export function terraceStep(params: LayoutParams): number { return 0.16 * (params.radius / 10); }

/** The discrete terrace level at a world point (grid cell lookup; 0 for radial / no-terraces). */
export function cellLevelAt(graph: WorldGraphLite, x: number, z: number): number {
    const levels = graph.levels; if (!levels) return 0;
    const R = graph.radius, cols = graph.params.gridCols, rows = graph.params.gridRows;
    const ci = Math.floor((x + R) / (2 * R / cols)), ri = Math.floor((z + R) / (2 * R / rows));
    if (ci < 0 || ci >= cols || ri < 0 || ri >= rows) return 0;
    return levels[ci]?.[ri] ?? 0;
}

/** Full elevation = gentle smooth terrain + discrete terrace step. Every layer post-transforms with this. */
export function makeElevation(graph: WorldGraphLite): (x: number, z: number) => number {
    const smooth = makeHeightField(graph.params);
    if (!graph.levels || !(graph.params.terraces ?? true)) return smooth;
    const step = terraceStep(graph.params);
    return (x, z) => smooth(x, z) + cellLevelAt(graph, x, z) * step;
}

/** The bits of WorldGraph these helpers need (avoids importing the whole type here). */
interface WorldGraphLite { params: LayoutParams; radius: number; levels: number[][] | null; }
