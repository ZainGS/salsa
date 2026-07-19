// ── World generation — CITY STYLE PACKS ─────────────────────────────────────────────────────────
// A style pack = one named, DATA-ONLY look: layout params (palette / warp / elevation / densities) plus a
// render style and a time of day. One dropdown swaps the whole aesthetic; every knob stays individually
// tweakable afterwards (the pack just merges onto the current params via updateCity). Add new packs freely —
// this is the "achieve any stylized look" surface.

import type { LayoutParams } from './types';

export interface CityStylePack {
    name: string;
    label: string;
    params: Partial<LayoutParams>;
    /** World-wide mesh render style ('cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'); null = default PBR. */
    renderStyle?: 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud' | null;
    /** Time of day the pack looks best at (0 midnight · 0.25 dawn · 0.5 noon · 0.75 dusk). */
    timeOfDay?: number;
}

export const CITY_STYLES: CityStylePack[] = [
    {
        name: 'tokyo', label: 'Tokyo Backstreet',
        params: { palette: 'terracotta', warp: 0.22, elevation: 0.45, powerLines: true, signage: true, lanterns: true, railway: true },
        renderStyle: null, timeOfDay: 0.72,
    },
    {
        name: 'oldtown', label: 'Euro Old Town',
        params: { palette: 'brick', warp: 0.9, elevation: 0.8, junctionVariety: 0.55, powerLines: false, railway: false, signage: false, parkedCars: false, streetTrees: true, shotengai: false },
        renderStyle: null, timeOfDay: 0.45,
    },
    {
        name: 'seaside', label: 'Pastel Seaside',
        params: { palette: 'pastel', warp: 0.55, elevation: 0.65, waterChance: 0.14, powerLines: false, streetTrees: true },
        renderStyle: null, timeOfDay: 0.4,
    },
    {
        name: 'noir', label: 'Noir Night',
        params: { palette: 'slate', warp: 0.15, fog: true, signage: true },
        renderStyle: 'ink', timeOfDay: 0.92,
    },
    {
        name: 'toon', label: 'Toon Town',
        params: { palette: 'mint', warp: 0.5, elevation: 0.55 },
        renderStyle: 'cel', timeOfDay: 0.5,
    },
    {
        name: 'retro', label: 'PS1 Retro',
        params: { palette: 'terracotta', warp: 0.3 },
        renderStyle: 'gouraud', timeOfDay: 0.55,
    },
    {
        name: 'cyber', label: 'Neon Cyber',
        params: { palette: 'slate', warp: 0.18, holograms: true, signage: true, powerLines: true, cloudDensity: 0.2, fog: true },
        renderStyle: null, timeOfDay: 0.95,
    },
    {
        name: 'storm', label: 'Rainy Dusk',
        params: { palette: 'slate', warp: 0.3, weather: 'rain', fog: true, signage: true },
        renderStyle: null, timeOfDay: 0.78,
    },
    {
        name: 'winter', label: 'First Snow',
        params: { palette: 'mint', warp: 0.3, weather: 'snow', cloudDensity: 0.6, fog: true },
        renderStyle: null, timeOfDay: 0.42,
    },
];

export const CITY_STYLE_NAMES = CITY_STYLES.map(sp => sp.name);
export const cityStyle = (name: string): CityStylePack | undefined => CITY_STYLES.find(sp => sp.name === name);
