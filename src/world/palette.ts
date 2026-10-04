// ── World generation — city palette harmonization ───────────────────────────────────────────────
// Each seed picks one of a few CURATED colour palettes (plus a tiny seeded hue nudge), so every city has a
// coherent "grade" instead of one fixed terracotta look — walls by zone, roofs, sidewalks and park greens all
// pull from the same palette. Pure + deterministic; consumed by preview.ts (map) and streets.ts (massing).

import { hash2 } from './util';

type C3 = [number, number, number];
export interface CityPalette {
    name: string;
    residential: C3; commercial: C3; civic: C3;   // wall colours by zone
    roof: C3;                                      // slate/tile massing tops
    sidewalk: C3; sidewalkJoint: C3;               // concrete band + slab-joint line
    park: C3; parkMottle: C3;                      // grass + its dot mottle
    /** city-quality P2 (optional — consumers fall back to their built-in lists): bright sign / neon colours, an accent
     *  colour (awnings, trim, signature red), and the lit-window glow colours (tungsten / fluorescent / TV). */
    neon?: C3[];
    accent?: C3;
    windowLit?: C3[];
}

const PALETTES: CityPalette[] = [
    { name: 'terracotta',   // the original warm look
      residential: [0.855, 0.773, 0.643], commercial: [0.859, 0.612, 0.529], civic: [0.761, 0.486, 0.420],
      roof: [0.42, 0.40, 0.45], sidewalk: [0.70, 0.68, 0.63], sidewalkJoint: [0.55, 0.53, 0.49],
      park: [0.663, 0.773, 0.545], parkMottle: [0.55, 0.68, 0.44] },
    { name: 'slate',        // cool overcast metropolis
      residential: [0.72, 0.73, 0.76], commercial: [0.60, 0.64, 0.70], civic: [0.52, 0.56, 0.64],
      roof: [0.32, 0.34, 0.40], sidewalk: [0.66, 0.67, 0.68], sidewalkJoint: [0.52, 0.53, 0.55],
      park: [0.60, 0.72, 0.52], parkMottle: [0.49, 0.63, 0.42] },
    { name: 'pastel',       // cream seaside town
      residential: [0.93, 0.87, 0.78], commercial: [0.88, 0.78, 0.72], civic: [0.80, 0.72, 0.68],
      roof: [0.52, 0.46, 0.48], sidewalk: [0.78, 0.76, 0.71], sidewalkJoint: [0.63, 0.61, 0.57],
      park: [0.70, 0.80, 0.58], parkMottle: [0.59, 0.71, 0.47] },
    { name: 'brick',        // dusk red-brick industrial
      residential: [0.72, 0.55, 0.47], commercial: [0.63, 0.44, 0.38], civic: [0.55, 0.40, 0.36],
      roof: [0.30, 0.28, 0.30], sidewalk: [0.64, 0.61, 0.57], sidewalkJoint: [0.50, 0.48, 0.44],
      park: [0.62, 0.71, 0.50], parkMottle: [0.51, 0.61, 0.41] },
    { name: 'mint',         // retro mint-and-sand
      residential: [0.84, 0.82, 0.72], commercial: [0.68, 0.79, 0.72], civic: [0.56, 0.70, 0.66],
      roof: [0.38, 0.44, 0.46], sidewalk: [0.73, 0.72, 0.66], sidewalkJoint: [0.58, 0.57, 0.52],
      park: [0.66, 0.78, 0.55], parkMottle: [0.55, 0.68, 0.45] },
    // ── city-quality P2: dark, high-contrast palettes (never seeded-picked by 'auto' — see AUTO_COUNT) ──
    { name: 'phantom',      // Persona 5: charcoal / navy walls, black roofs, signature red + white accents, hot neon
      residential: [0.36, 0.37, 0.42], commercial: [0.30, 0.31, 0.38], civic: [0.42, 0.40, 0.44],
      roof: [0.10, 0.10, 0.12], sidewalk: [0.40, 0.40, 0.43], sidewalkJoint: [0.28, 0.28, 0.31],
      park: [0.36, 0.46, 0.36], parkMottle: [0.28, 0.38, 0.30],
      neon: [[1.0, 0.12, 0.18], [1.0, 0.95, 0.95], [0.20, 0.85, 1.0], [1.0, 0.78, 0.10], [0.95, 0.20, 0.75]],
      accent: [0.86, 0.08, 0.12],
      windowLit: [[1.0, 0.78, 0.48], [0.80, 0.90, 1.0], [0.55, 0.70, 1.0]] },
    { name: 'inaba',        // Persona 4: warm ochre / cream small town, rust roofs, soft yellow light
      residential: [0.86, 0.78, 0.60], commercial: [0.82, 0.66, 0.46], civic: [0.74, 0.60, 0.46],
      roof: [0.46, 0.30, 0.24], sidewalk: [0.72, 0.68, 0.58], sidewalkJoint: [0.58, 0.54, 0.46],
      park: [0.62, 0.72, 0.42], parkMottle: [0.52, 0.62, 0.36],
      neon: [[1.0, 0.82, 0.25], [1.0, 0.55, 0.20], [0.95, 0.95, 0.85], [0.35, 0.80, 0.55]],
      accent: [0.95, 0.72, 0.10],
      windowLit: [[1.0, 0.80, 0.50], [1.0, 0.88, 0.62]] },
];
/** How many palettes the seeded 'auto' pick draws from — the ORIGINAL five, so adding palettes never recolours an
 *  existing auto-palette city. */
const AUTO_COUNT = 5;

/** Palette names for a host dropdown ('auto' = seeded pick). */
export const CITY_PALETTE_NAMES = ['auto', ...PALETTES.map(p => p.name)] as const;

/** The harmonized palette for a seed — seeded pick, or forced by NAME (the panel's palette dropdown). */
export function cityPalette(seed: number, pick?: string): CityPalette {
    const chosen = (pick && pick !== 'auto' && PALETTES.find(p => p.name === pick)) || PALETTES[Math.abs(seed | 0) % AUTO_COUNT];
    const nudge = (hash2(seed, 17, 0x9a55) - 0.5) * 0.05;   // ±2.5% warmth — same palette never reads identical
    const warm = (c: C3): C3 => [Math.min(1, Math.max(0, c[0] + nudge)), c[1], Math.min(1, Math.max(0, c[2] - nudge))];
    return { ...chosen, residential: warm(chosen.residential), commercial: warm(chosen.commercial), civic: warm(chosen.civic) };
}


// ── PAINTED METAL recipes (material bit 23) ─────────────────────────────────────────────────────
// The city's metalwork was ~70k triangles of one flat grey. These are the shared recipes so a railing
// in water.ts and a railing in terraces.ts weather identically. `scale` is CYCLES PER WORLD UNIT and the
// city is a diorama (1 unit = CITY_FLOOR_M / (0.2*s) metres), so callers pass it derived, never hardcoded.
export interface MetalRecipe {
    tint: [number, number, number]; streak: [number, number, number];
    roughness: number; streakAmount: number; grime: number;
}
/** Dark painted steel — railings, guardrails, poles, signal housings. Streaks hard, stays fairly sharp. */
export const METAL_PAINTED: MetalRecipe = {
    tint: [0.22, 0.23, 0.26], streak: [0.11, 0.11, 0.12], roughness: 0.42, streakAmount: 0.75, grime: 0.35,
};
/** Galvanised / bare plant — rooftop units, vents, ducting. Dull, filthy on top, streaked down the sides. */
export const METAL_GALVANISED: MetalRecipe = {
    tint: [0.52, 0.54, 0.57], streak: [0.26, 0.27, 0.28], roughness: 0.66, streakAmount: 0.85, grime: 0.85,
};
/** Light utility grey — lamp columns, thinner poles. Cleaner than plant, less streaked than rails. */
export const METAL_POLE: MetalRecipe = {
    tint: [0.34, 0.35, 0.38], streak: [0.17, 0.17, 0.19], roughness: 0.50, streakAmount: 0.6, grime: 0.4,
};

// ── FACADE MATERIALS + MUTED WALL SWATCHES (persona polish B4) ───────────────────────────────────────────────────
// The city's detailed buildings all wore their archetype's one material + one warm tan, so every street read as the
// same tiled grid ("graph paper"). Real Shibuya mixes tile, bare concrete, painted render, metal-panel cladding and
// the odd brick front, in NEUTRAL values — the signs carry the colour. facadeFor() picks a material per lot (district
// weighted × archetype affinity) and a muted swatch for it; the region tint index leans the swatch pick so a
// neighbourhood stays coherent. Swatches are DISCRETE (a handful per material) so walls still merge into few draws.
export type FacadeMaterial = 'tile' | 'concrete' | 'plaster' | 'panel' | 'brick';
/** Muted wall swatches per facade material (sRGB 0..1), ordered cool → warm so the region tint index (0 cool …
 *  5 warm) can lean the pick. */
export const FACADE_SWATCHES: Record<FacadeMaterial, C3[]> = {
    tile:     [[0.70, 0.71, 0.70], [0.62, 0.67, 0.65], [0.80, 0.80, 0.78], [0.56, 0.58, 0.56], [0.84, 0.81, 0.75], [0.72, 0.68, 0.60], [0.58, 0.54, 0.49]],
    concrete: [[0.60, 0.61, 0.62], [0.70, 0.70, 0.69], [0.52, 0.52, 0.51], [0.66, 0.65, 0.62], [0.74, 0.72, 0.68]],
    plaster:  [[0.70, 0.72, 0.73], [0.84, 0.83, 0.80], [0.78, 0.77, 0.73], [0.88, 0.84, 0.76], [0.78, 0.72, 0.65], [0.80, 0.69, 0.61], [0.74, 0.68, 0.60]],
    panel:    [[0.40, 0.42, 0.45], [0.47, 0.51, 0.55], [0.62, 0.63, 0.65], [0.52, 0.53, 0.55], [0.70, 0.69, 0.66], [0.64, 0.60, 0.53]],
    brick:    [[0.46, 0.40, 0.38], [0.52, 0.38, 0.32], [0.58, 0.46, 0.37], [0.47, 0.34, 0.29]],
};
/** Which facade materials an archetype can wear (its own identity first) — absent = keep the archetype's material
 *  (timber machiya, siding houses, glass towers, the white konbini, the warehouse's corrugated sheet). */
const FACADE_AFFINITY: Record<string, Partial<Record<FacadeMaterial, number>>> = {
    'zakkyo':            { tile: 3, panel: 2.5, plaster: 1.5, concrete: 1.5 },
    'mansion':           { tile: 3, plaster: 2, concrete: 2 },
    'neon-arcade':       { panel: 3, concrete: 2, tile: 1.5 },
    'retro-shophouse':   { tile: 2.5, plaster: 2.5, concrete: 1, brick: 0.8 },
    'office-block':      { concrete: 3, panel: 2.5, tile: 1.5 },
    'apartment-balcony': { concrete: 2.5, tile: 2, plaster: 1.5 },
    'mall':              { panel: 2, concrete: 2, tile: 1 },
    'izakaya':           { plaster: 3, concrete: 0.6 },
    'suburban-house':    { plaster: 3 },
};
/** District character multipliers (downtown = cladding + tile, market = render + tile, residential = tile + render). */
const DISTRICT_MUL: Record<string, Partial<Record<FacadeMaterial, number>>> = {
    downtown:    { panel: 1.6, tile: 1.2, concrete: 1.1, plaster: 0.5, brick: 0.3 },
    market:      { plaster: 1.5, tile: 1.2, concrete: 0.8, panel: 0.5, brick: 1.2 },
    residential: { tile: 1.3, plaster: 1.3, concrete: 0.9, panel: 0.4, brick: 0.8 },
};
/** Pick a facade material + muted wall colour for one lot, or null to keep the archetype's own. `h1`/`h2` are two
 *  independent 0..1 lot hashes; `lean` = the region's tint index (0..5, cool → warm). Pure + deterministic. */
export function facadeFor(archetype: string, district: string, h1: number, h2: number, lean: number, wide?: { h3: number } | null): { material: FacadeMaterial; color: C3 } | null {
    const aff = FACADE_AFFINITY[archetype];
    if (!aff) return null;
    const mul = DISTRICT_MUL[district] ?? {};
    const opts = (Object.keys(aff) as FacadeMaterial[]).map(m => [m, (aff[m] ?? 0) * (mul[m] ?? 1)] as const).filter(([, w]) => w > 0);
    let tot = 0; for (const [, w] of opts) tot += w;
    let r = h1 * tot, material = opts[opts.length - 1][0];
    for (const [m, w] of opts) { r -= w; if (r <= 0) { material = m; break; } }
    if (wide) return { material, color: districtSwatch(material, district, h2, wide.h3, lean) };
    const sw = FACADE_SWATCHES[material];
    // region lean: centre the pick on the region's position along the cool→warm order, ±1 swatch for life
    const centre = Math.round((Math.max(0, Math.min(5, lean)) / 5) * (sw.length - 1));
    const off = h2 < 0.5 ? 0 : h2 < 0.75 ? 1 : -1;
    const idx = Math.max(0, Math.min(sw.length - 1, centre + off));
    return { material, color: sw[idx] };
}

// ── DISTRICT PALETTE (visual-polish #11) ─────────────────────────────────────────────────────────────────────────────
// From above, the B4 swatches read as one tan / grey mass: every swatch sat between ~0.5 and ~0.85 luminance with the
// hue squeezed out, so the value range collapsed. Real Tokyo from the air mixes white tile, dark brick, charcoal
// cladding and coloured render. The wide palette is a 3 × 3 grid per material — VALUE band (dark / mid / light) ×
// HUE family (cool / neutral / warm) — still low-saturation (the signs keep the colour). The region's tint lean picks
// the hue family (a neighbourhood stays coherent), a lot hash picks the value band with district weights (downtown:
// contrasty, both ends; market: warm renders, mostly mid-light; residential: pale with dark brick). DISCRETE (45
// colours) so walls still merge into few draws.
/** [value band dark, mid, light][hue cool, neutral, warm] per facade material (sRGB 0..1). */
export const DISTRICT_SWATCHES: Record<FacadeMaterial, C3[][]> = {
    tile: [
        [[0.30, 0.34, 0.37], [0.35, 0.33, 0.31], [0.43, 0.31, 0.25]],    // slate-blue mosaic · umber · brown tile
        [[0.55, 0.62, 0.62], [0.62, 0.61, 0.58], [0.71, 0.59, 0.46]],    // celadon · stone · tan
        [[0.84, 0.87, 0.88], [0.91, 0.90, 0.87], [0.93, 0.87, 0.75]],    // blue-white · white tile · cream
    ],
    concrete: [
        [[0.36, 0.38, 0.41], [0.41, 0.41, 0.40], [0.45, 0.41, 0.37]],
        [[0.58, 0.61, 0.64], [0.64, 0.64, 0.62], [0.67, 0.63, 0.57]],
        [[0.78, 0.80, 0.82], [0.83, 0.82, 0.79], [0.85, 0.81, 0.73]],
    ],
    plaster: [
        [[0.31, 0.40, 0.44], [0.41, 0.37, 0.35], [0.53, 0.31, 0.27]],    // teal slate · cocoa · oxblood render
        [[0.55, 0.67, 0.72], [0.65, 0.70, 0.58], [0.80, 0.58, 0.50]],    // powder blue · sage · terracotta pink
        [[0.80, 0.86, 0.89], [0.91, 0.89, 0.81], [0.95, 0.83, 0.66]],    // pale blue · off-white · apricot cream
    ],
    panel: [
        [[0.18, 0.21, 0.27], [0.24, 0.24, 0.26], [0.31, 0.27, 0.24]],    // navy charcoal · graphite · bronze
        [[0.40, 0.48, 0.58], [0.52, 0.53, 0.55], [0.59, 0.53, 0.45]],    // steel blue · aluminium · champagne
        [[0.76, 0.79, 0.83], [0.83, 0.83, 0.81], [0.85, 0.79, 0.69]],
    ],
    brick: [
        [[0.30, 0.23, 0.22], [0.35, 0.24, 0.20], [0.41, 0.24, 0.18]],
        [[0.50, 0.37, 0.33], [0.57, 0.38, 0.30], [0.65, 0.42, 0.30]],
        [[0.70, 0.59, 0.52], [0.75, 0.61, 0.48], [0.81, 0.67, 0.52]],    // pale / yellow brick
    ],
};
/** Value-band weights [dark, mid, light] per district. */
const DISTRICT_VALUE: Record<string, [number, number, number]> = {
    downtown:    [0.26, 0.34, 0.40],
    market:      [0.18, 0.40, 0.42],
    residential: [0.14, 0.32, 0.54],
    civic:       [0.16, 0.38, 0.46],
    mixed:       [0.20, 0.38, 0.42],
};
/** The district-palette wall colour for one lot. `h2` jitters the hue family, `h3` picks the value band, `lean` = the
 *  region tint index (0 cool … 5 warm). Pure + deterministic. */
export function districtSwatch(material: FacadeMaterial, district: string, h2: number, h3: number, lean: number): C3 {
    const grid = DISTRICT_SWATCHES[material];
    const w = DISTRICT_VALUE[district] ?? DISTRICT_VALUE.mixed;
    const band = h3 < w[0] ? 0 : h3 < w[0] + w[1] ? 1 : 2;
    const hue0 = Math.round((Math.max(0, Math.min(5, lean)) / 5) * 2);
    const hue = Math.max(0, Math.min(2, hue0 + (h2 < 0.72 ? 0 : h2 < 0.86 ? 1 : -1)));
    return grid[band][hue];
}

/** ROOF VARIETY (visual-polish #11): per-lot roof finishes. Flat / parapet decks — waterproofing sheet, metal and
 *  membrane colours; pitched roofs — kawara and sheet colours. Ordered with district weights. */
export const ROOF_FLAT: { c: C3; w: Record<string, number> }[] = [
    { c: [0.22, 0.23, 0.25], w: { downtown: 1.6, market: 1.4, residential: 0.9, mixed: 1.3 } },  // dark tar / asphalt sheet
    { c: [0.34, 0.52, 0.42], w: { downtown: 2.2, market: 2.4, residential: 2.8, mixed: 2.4 } },  // green waterproofing
    { c: [0.36, 0.50, 0.64], w: { downtown: 2.2, market: 1.4, residential: 2.0, mixed: 1.8 } },  // blue-grey sheet
    { c: [0.71, 0.70, 0.67], w: { downtown: 1.4, market: 1.1, residential: 1.0, mixed: 1.2 } },  // pale concrete
    { c: [0.86, 0.86, 0.84], w: { downtown: 1.0, market: 0.5, residential: 0.7, mixed: 0.7 } },  // white membrane
    { c: [0.56, 0.28, 0.22], w: { downtown: 1.0, market: 1.8, residential: 1.2, mixed: 1.2 } },  // red-oxide metal
    { c: [0.52, 0.50, 0.47], w: { downtown: 0.7, market: 0.7, residential: 0.6, mixed: 0.7 } },  // warm grey
];
export const ROOF_PITCHED: { c: C3; w: number }[] = [
    { c: [0.20, 0.22, 0.27], w: 4 },     // ibushi kawara (dark silver-grey)
    { c: [0.22, 0.31, 0.44], w: 2 },     // glazed blue tile
    { c: [0.36, 0.29, 0.25], w: 1.4 },   // brown sheet
    { c: [0.56, 0.25, 0.20], w: 1 },     // red sheet metal
    { c: [0.56, 0.33, 0.25], w: 0.6 },   // terracotta
    { c: [0.37, 0.51, 0.45], w: 0.6 },   // weathered copper green
];
/** The roof colour for one lot under roof variety (`h` = a lot hash 0..1). Pure + deterministic. */
export function roofFor(pitched: boolean, district: string, h: number): C3 {
    if (pitched) {
        let tot = 0; for (const r of ROOF_PITCHED) tot += r.w;
        let x = h * tot;
        for (const r of ROOF_PITCHED) { x -= r.w; if (x <= 0) return r.c; }
        return ROOF_PITCHED[ROOF_PITCHED.length - 1].c;
    }
    const key = district in ROOF_FLAT[0].w ? district : 'mixed';
    let tot = 0; for (const r of ROOF_FLAT) tot += r.w[key] ?? 1;
    let x = h * tot;
    for (const r of ROOF_FLAT) { x -= r.w[key] ?? 1; if (x <= 0) return r.c; }
    return ROOF_FLAT[ROOF_FLAT.length - 1].c;
}
/** A turf roof garden's deck colour. */
export const ROOF_TURF: C3 = [0.40, 0.54, 0.29];
/** Share of flat mid-rise roofs that become turf gardens, per district. */
const ROOF_GARDEN_CHANCE: Record<string, number> = { downtown: 0.1, market: 0.14, residential: 0.24, civic: 0.18, mixed: 0.16 };
/** ROOF VARIETY on one building's params (in place): its roof colour from the flat / pitched finish lists, and on some
 *  flat 2–10 storey roofs a turf garden (green deck + the planter boxes). The warehouse sawtooth keeps its sheet.
 *  `h` / `h2` = two lot hashes 0..1. Pure + deterministic. */
export function applyRoofVariety(b: { roofStyle: string; roofColor: C3; roofGarden: boolean; helipad?: boolean }, district: string, floors: number, h: number, h2: number): void {
    const rs = b.roofStyle;
    const pitched = rs === 'hip' || rs === 'gable' || rs === 'tiled-hip' || rs === 'mansard';
    const flat = rs === 'flat' || rs === 'parapet';
    if (!pitched && !flat) return;
    b.roofColor = roofFor(pitched, district, h);
    if (flat && !b.helipad && floors >= 2 && floors <= 10 && h2 < (ROOF_GARDEN_CHANCE[district] ?? ROOF_GARDEN_CHANCE.mixed)) {
        b.roofColor = ROOF_TURF;
        b.roofGarden = true;
    }
}
