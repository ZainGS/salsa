/**
 * src/world/ground-surfaces.ts — the procedural-ground SURFACE LIBRARY (procedural-ground.md §11, P6).
 *
 * Lives in `src/world` rather than beside `applyGroundMaterial3D` because it has TWO consumers now: the
 * ShapeManager (applying a surface to one mesh) and the CITY generator (`world/preview.ts`, stamping a
 * surface onto every road / sidewalk / plaza / park layer it emits). Services may import world; world must
 * never import services — so the shared table belongs here, and shape-manager re-exports it.
 *
 * A surface = a `groundMode` (which WGSL branch shades it) + its recipe defaults. ★ Several LOOKS share
 * one mode on purpose: brick, granite, slate and sandstone are all the **ashlar tiler** with a different
 * stone size, colour, seam and jitter, because those materials differ in *appearance*, not in geometry —
 * so four extra surfaces cost zero extra shader code. Only a genuinely different LAYOUT earns a mode.
 */

/** One surface recipe. `grout` is optional — most surfaces use the shared grey-brown seam. */
export interface GroundSurfaceSpec {
    /** WGSL `groundSurface` branch: 0 ashlar · 1 radial · 2 border · 3 grass · 4 asphalt · 5 concrete ·
     *  6 dirt · 7 cobble · 8 plank. ⚠ Saves store this NUMBER — never renumber an existing mode, append. */
    mode: number;
    /** Tile LONG dimension in mm (0 for the organic surfaces, which have no cells). */
    tileMm: number;
    /** Tile width ÷ height (brick 215 × 65 → 215/65). */
    aspect: number;
    /** Seam width in mm (0 for the organic surfaces). */
    groutMm: number;
    tint: [number, number, number];
    /** Per-tile colour variation multiplier. */
    jitter: number;
    rough: number;
    grout?: [number, number, number];
}

export const GROUND_SURFACES = {
    //                 mode  tileMm  aspect      groutMm  tint (base albedo)          jitter  rough  grout/seam
    ashlar:          { mode: 0, tileMm: 900,  aspect: 1.5,      groutMm: 15, tint: [0.80, 0.74, 0.62] as [number, number, number], jitter: 1.00, rough: 0.55 },
    brick:           { mode: 0, tileMm: 215,  aspect: 215 / 65, groutMm: 10, tint: [0.55, 0.26, 0.19] as [number, number, number], jitter: 1.50, rough: 0.70, grout: [0.74, 0.72, 0.68] as [number, number, number] },
    granite:         { mode: 0, tileMm: 800,  aspect: 1.0,      groutMm: 8,  tint: [0.52, 0.51, 0.53] as [number, number, number], jitter: 0.65, rough: 0.34 },
    slate:           { mode: 0, tileMm: 600,  aspect: 2.0,      groutMm: 8,  tint: [0.26, 0.28, 0.31] as [number, number, number], jitter: 1.25, rough: 0.42 },
    sandstone:       { mode: 0, tileMm: 700,  aspect: 1.4,      groutMm: 14, tint: [0.76, 0.62, 0.42] as [number, number, number], jitter: 1.15, rough: 0.62 },
    radialMedallion: { mode: 1, tileMm: 600,  aspect: 1.0,      groutMm: 12, tint: [0.80, 0.74, 0.62] as [number, number, number], jitter: 1.00, rough: 0.55 },
    borderStrip:     { mode: 2, tileMm: 900,  aspect: 1.0,      groutMm: 12, tint: [0.78, 0.72, 0.60] as [number, number, number], jitter: 1.00, rough: 0.55 },
    grass:           { mode: 3, tileMm: 0,    aspect: 1.0,      groutMm: 0,  tint: [0.33, 0.49, 0.21] as [number, number, number], jitter: 1.00, rough: 0.90 },
    asphalt:         { mode: 4, tileMm: 0,    aspect: 1.0,      groutMm: 0,  tint: [0.19, 0.19, 0.20] as [number, number, number], jitter: 1.00, rough: 0.84 },
    concrete:        { mode: 5, tileMm: 3000, aspect: 1.0,      groutMm: 12, tint: [0.63, 0.62, 0.59] as [number, number, number], jitter: 1.00, rough: 0.80, grout: [0.50, 0.49, 0.47] as [number, number, number] },
    dirt:            { mode: 6, tileMm: 0,    aspect: 1.0,      groutMm: 0,  tint: [0.36, 0.27, 0.18] as [number, number, number], jitter: 1.00, rough: 0.95 },
    cobble:          { mode: 7, tileMm: 150,  aspect: 1.0,      groutMm: 18, tint: [0.48, 0.46, 0.43] as [number, number, number], jitter: 1.30, rough: 0.62, grout: [0.34, 0.33, 0.30] as [number, number, number] },
    plank:           { mode: 8, tileMm: 1800, aspect: 12.0,     groutMm: 5,  tint: [0.50, 0.35, 0.21] as [number, number, number], jitter: 1.00, rough: 0.55, grout: [0.16, 0.12, 0.08] as [number, number, number] },
} satisfies Record<string, GroundSurfaceSpec>;

/** Every surface name the ground material accepts — feed a picker straight from `Object.keys`. */
export type GroundSurfaceName = keyof typeof GROUND_SURFACES;

/** Weathering profile name → the index the WGSL `gr_profile` switch expects. */
export const GROUND_WEATHER: Record<string, number> = { new: 0, worn: 1, ancient: 2, mossy: 3, dirty: 4 };

/** Caller overrides for a recipe. Anything omitted falls back to the surface's own value. */
export interface GroundRecipeOverrides {
    tileMm?: number; groutMm?: number; tint?: [number, number, number];
    wedges?: number; ringMm?: number; jitter?: number;
}

/** The resolved, shader-ready numbers — METRES throughout (see `gr_uvMetres`: the shader derives
 *  world-metres-per-uv per fragment, so these are physical sizes on any mesh at any scale). */
export interface GroundRecipe {
    mode: number;
    /** Mode-multiplexed: tilers = [tileW, tileH] m · radial = [ringSpacing m, wedgeCount] ·
     *  border = [stoneLength m, rowCount] · cobble = [cellSize m, —] · plank = [boardLen m, boardW m] ·
     *  organic (grass/asphalt/dirt) = [0, 0], no cells. */
    tile: [number, number];
    groutM: number;
    tint: [number, number, number];
    seam: [number, number, number];
    jitter: number;
    rough: number;
}

/** Turn a surface name + overrides into the numbers both consumers stamp onto a material. ONE source of
 *  truth — `applyGroundMaterial3D` and the city generator must not each do this arithmetic. */
export function resolveGroundRecipe(surface: GroundSurfaceName | undefined, o?: GroundRecipeOverrides): GroundRecipe {
    const preset: GroundSurfaceSpec = GROUND_SURFACES[surface ?? 'ashlar'] ?? GROUND_SURFACES.ashlar;
    const tileM = (o?.tileMm ?? preset.tileMm) / 1000;
    const groutM = (o?.groutMm ?? preset.groutMm) / 1000;
    let tile: [number, number];
    if (preset.mode === 1) {
        tile = [(o?.ringMm ?? o?.tileMm ?? preset.tileMm) / 1000, o?.wedges ?? 12];
    } else if (preset.mode === 2) {
        tile = [tileM, 1.0];
    } else if (preset.mode === 3 || preset.mode === 4 || preset.mode === 6) {
        tile = [0, 0];                                            // organic — no cell layout
    } else {
        // LANDSCAPE pavers via the preset's aspect (ashlar 900 × 600, brick 215 × 65, …). Ashlar was
        // PORTRAIT once, which put the courses 1.5× further apart than the column seams and made the
        // running-bond offset read as a stray line inside each stone.
        tile = [tileM, tileM / preset.aspect];
    }
    return {
        mode: preset.mode, tile, groutM,
        tint: o?.tint ?? preset.tint,
        seam: preset.grout ?? [0.47, 0.45, 0.41],
        jitter: o?.jitter ?? preset.jitter,
        rough: preset.rough,
    };
}
