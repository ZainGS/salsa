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
];

/** Palette names for a host dropdown ('auto' = seeded pick). */
export const CITY_PALETTE_NAMES = ['auto', ...PALETTES.map(p => p.name)] as const;

/** The harmonized palette for a seed — seeded pick, or forced by NAME (the panel's palette dropdown). */
export function cityPalette(seed: number, pick?: string): CityPalette {
    const chosen = (pick && pick !== 'auto' && PALETTES.find(p => p.name === pick)) || PALETTES[Math.abs(seed | 0) % PALETTES.length];
    const nudge = (hash2(seed, 17, 0x9a55) - 0.5) * 0.05;   // ±2.5% warmth — same palette never reads identical
    const warm = (c: C3): C3 => [Math.min(1, Math.max(0, c[0] + nudge)), c[1], Math.min(1, Math.max(0, c[2] - nudge))];
    return { ...chosen, residential: warm(chosen.residential), commercial: warm(chosen.commercial), civic: warm(chosen.civic) };
}
