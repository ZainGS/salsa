// ── World generation — CITY STYLE PACKS ─────────────────────────────────────────────────────────
// A style pack = one named, DATA-ONLY look: layout params (palette / warp / elevation / densities) plus a
// render style and a time of day. One dropdown swaps the whole aesthetic; every knob stays individually
// tweakable afterwards (the pack just merges onto the current params via updateCity). Add new packs freely —
// this is the "achieve any stylized look" surface.

import type { LayoutParams } from './types';
import type { TimeGradePhase, SkyKey } from './day-night';

type C3 = [number, number, number];
/** One grade keyframe patch (mirrors WorldManager's TimeGradeKey — world/ can't import services). */
export interface CityGradeKeyPatch {
    bloomThreshold?: number; bloomIntensity?: number; brightness?: number; contrast?: number; saturation?: number;
    tint?: C3; vignette?: number;
    /** Split-tone (city-quality P7): the tint the SHADOWS / HIGHLIGHTS take (1,1,1 = none). */
    shadowTint?: C3; highlightTint?: C3;
}

/** The city's screen-space ink outlines. `threshold` = the line width in px (1–8). `depthFade` (visual-polish #8,
 *  absent = the constant ink of older saves): in METRES from the camera, the ink thins to 1 px and fades to
 *  `minAlpha` (default 0.25) of its alpha between `near` and `far`. */
export interface CityOutlines {
    color: [number, number, number, number];
    threshold: number;
    depthFade?: { near: number; far: number; minAlpha?: number };
    /** visual-polish #3 (absent = 'full', the ink of older saves): how the ink treats FOLIAGE (leaf-card / foliage-shade
     *  materials). 'silhouette' = one outline round each canopy and none between its leaf cards; 'off' = no ink on
     *  foliage at all. */
    foliage?: 'full' | 'silhouette' | 'off';
    /** visual-polish #3 (absent = off): in METRES from the camera, CREASE ink (normal edges — ledges, window reveals,
     *  sills; not silhouettes) fades from full at `near` to `minAlpha` (default 0) at `far`, so mid-range ledges stop
     *  breaking into short dashes while building silhouettes keep their line. */
    creaseFade?: { near: number; far: number; minAlpha?: number;
        /** visual-polish #3b (absent = off): past `near`, crease ink only where BOTH faces are at least this many pixels
         *  thick (2–4; an occlusion edge always counts), so sub-pixel ledge undersides at 30–40 m stop inking dashes. */
        thinPx?: number };
}

/**
 * A pack's LOOK (city-quality P1) — everything beyond layout that makes a style read: the time-of-day grade + sky,
 * coloured shadows, toon shadows, the city's render style, ink outlines, SSAO, sky lighting, wet reflections, lamp
 * colour. Fields a pack omits are RESET to the engine defaults when it's applied (so switching packs never leaves
 * a previous pack's violet shadows behind). All persisted with the city.
 */
export interface CityLook {
    grade?: Partial<Record<TimeGradePhase, CityGradeKeyPatch>>;
    sky?: Partial<Record<TimeGradePhase, Partial<SkyKey>>>;
    /** Coloured cast-shadow hue per phase (default: blue day / violet dusk / indigo night). */
    shadowTints?: Partial<Record<TimeGradePhase, C3>>;
    /** Scene-wide toon-shadow look (bands / softness / shadowValue / shadowTint / saturation). */
    toonShadows?: { bands?: number; softness?: number; shadowValue?: number; shadowTint?: C3; saturation?: number };
    /** The CITY's render style / toon shadows / rim (setCityStyle3D semantics). */
    cityStyle?: { renderStyle?: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'; toonShadow?: boolean; rimLight?: boolean };
    /** Screen-space ink edge outlines over the whole view (null / absent = off). `threshold` is the LINE WIDTH in px (1–8). */
    outlines?: CityOutlines | null;
    /** Screen-space ambient occlusion (contact shadows in street canyons). */
    ssao?: boolean;
    /** Light the city from its own sky (image-based: blue from above, warm from the sun side). */
    skyLighting?: boolean;
    /** Screen-space reflections on wet / night streets and water. */
    reflections?: boolean;
    /** Street-lamp light colour. */
    lampColor?: C3;
    /** Ground-hugging HEIGHT FOG strength (0 / absent = off; ~0.4-1). Thickest at dusk / dawn / night + rain. */
    heightFog?: number;
    // ── polish-round-3 T1: the CLEAN PBR baseline (all live material edits — no regeneration) ──
    /** Road / pavement finish: 'clean' = fresh crack-free asphalt, no grime / wear masks, quiet slabs
     *  (absent / 'weathered' = the built-in worn look). */
    groundFinish?: 'weathered' | 'clean';
    /** Pavement surface: 'tiles' = large pale ~50 cm square tiles with thin joints (the P5X pavement);
     *  absent / 'slabs' = the palette-tinted 1.2 m concrete slabs. */
    paving?: 'slabs' | 'tiles';
    /** 0..1 — desaturate building walls / trim / roofs toward a warm grey (signage stays saturated). 0 / absent = off. */
    buildingMute?: number;
    /** Painted horizon cloud banks (soft blobs lit by the sun, tinted by the sky). Absent = off. */
    paintedClouds?: boolean;
    /** PCF penumbra width (1 = tight … ~2.5 soft). Absent = the city default 1.3. */
    shadowSoftness?: number;
    /** 0..1 golden-hour warmth: near sunrise / sunset the sun goes deeper gold and brighter over a lower fill. Absent = 0. */
    sunWarmth?: number;
    /** 0..1 key/fill contrast (persona-polish A4): warmer stronger sun over a cooler, lower, less blue fill. Absent = 0. */
    keyFill?: number;
    /** 0..1 cool shade fill at golden hour / dusk (visual-polish #4): the fill + sky light go blue-violet instead of the
     *  warm dusk ambient, so the gold sun reads against cool shadow. Absent = 0 (the original warm fill). */
    coolFill?: number;
    /** visual-polish #8: lit-window GLOW multiplier for the city's window facades (0.1..2; the glass emission of lit
     *  cells and shop windows at night). < 1 keeps lit windows from clipping to white blobs under bloom so the frames
     *  and rooms read. Absent = 1 (the built glow, bit-identical). */
    windowGlow?: number;
    /** 0..1 aerial perspective (persona-polish A5): distance haze that fades contrast toward the horizon colour at
     *  street scale. Absent = 0 (off). */
    aerialHaze?: number;
    /** E2 edge wear (chipped / worn stone arrises, near chunks only). Unlike the other fields it is GEOMETRY and is
     *  applied only when present: absent leaves the city's current setting (LayoutParams.edgeWear) alone. */
    edgeWear?: 'off' | 'subtle' | 'heavy';
    /** visual-polish #11: the DISTRICT PALETTE (wide facade value / hue range per district) and ROOF VARIETY (per-lot roof
     *  finishes + turf gardens). Geometry like edgeWear: applied only when the look names them (LayoutParams
     *  districtPalette / roofVariety, a 'World Streets' rebuild); absent leaves the city's setting alone. On in every
     *  scene preset. */
    districtPalette?: boolean;
    roofVariety?: boolean;
    /** visual-polish #11 tail: ROOF EQUIPMENT style (LayoutParams.roofEquipment). Geometry like the two above: applied
     *  only when named; 'clustered' in every scene preset. */
    roofEquipment?: LayoutParams['roofEquipment'];
    /** visual-polish #5: 0..1.5 NIGHT LIGHT SPILL. Warm light patches on the pavement in front of lit shop windows and
     *  sign-coloured patches under shop signs, and the street-lamp pools drawn as soft light in `lampColor` (they came
     *  out as flat grey-white discs: the old pool emission clipped every channel to 1). Night only, faded in with the
     *  night level. Absent / 0 = off (the legacy pools, no spill). */
    nightSpill?: number;
    /** visual-polish #5: 0..1 WET SHEEN. Rain-slick roads get glossier (roughness 0.35 -> 0.08 at 1) so the SSR
     *  reflections and the lamp highlights streak; on a DRY night the asphalt goes damp (roughness 1 -> 0.4 at 1).
     *  Absent / 0 = the legacy finish (0.35 in rain, matte when dry). */
    wetSheen?: number;
    /** visual-polish #7c: 0..2 PLAYER LIGHT. In Play, a small unshadowed key light rides with the player (camera side,
     *  above the shoulder, about one body height of reach) so the character stays readable at night. Scaled by the
     *  night level (nothing by day). Absent / 0 = off. */
    playerLight?: number;
    /** visual-polish #9: the stylised SKY DOME (a view-direction sky: horizon glow, sun, moon + halo, stars, painted anime
     *  clouds). Present = on; absent / null = the legacy flat screen gradient with the blob stars / moon and the soft
     *  cloud cards (older saves and the packs without a look keep exactly that). */
    skyDome?: CitySkyDome | null;
}

/** The SKY DOME's look knobs (visual-polish #9). Every field is optional (absent = the default in brackets). */
export interface CitySkyDome {
    /** Star brightness 0..1 [1]. Stars show on clear nights only and fade near the city glow. */
    stars?: number;
    /** Moon visibility 0..1 [1] (clear nights). */
    moon?: number;
    /** Moon bearing in degrees, added to the sun's base azimuth [200], and its elevation in degrees [24]. */
    moonAzimuthDeg?: number;
    moonElevationDeg?: number;
    /** City light-pollution glow along the horizon at night 0..1 [0.6]. */
    cityGlow?: number;
    /** The glow's colour [warm sodium 1, 0.55, 0.32]. */
    cityGlowColor?: C3;
    /** 'anime' = painted cumulus in the dome [default]; 'cards' = the legacy soft cloud cards (horizon banks + drifting
     *  cards). Both follow the look's paintedClouds + the Clouds toggle + clear weather. */
    clouds?: 'anime' | 'cards';
}

export interface CityStylePack {
    name: string;
    label: string;
    params: Partial<LayoutParams>;
    /** World-wide mesh render style ('cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'); null = default PBR. */
    renderStyle?: 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud' | null;
    /** Time of day the pack looks best at (0 midnight · 0.25 dawn · 0.5 noon · 0.75 dusk). */
    timeOfDay?: number;
    /** The full look (city-quality P1). Absent = the engine defaults. */
    look?: CityLook;
}

export const CITY_STYLES: CityStylePack[] = [
    // ── city-quality P3: the Persona packs ──
    {
        name: 'persona5', label: 'Phantom Night (P5)',
        // visual-polish #8 (2026-10-03) retune: the old pack drowned the frame in saturated blue (blue-violet shadow /
        // toon / grade tints on top of an indigo night fill), clipped the lit windows to pink-white blobs (bloom 1.7 at
        // threshold 0.55) and lost white lettering on white boxes. Now: the P5 red / black / white — a neutral near-black
        // night sky with a faint red city glow, near-neutral charcoal shadows, a red-leaning highlight split, bloom only
        // on real lights, a slightly warm lamp, the clean ground + muted facades of the clean look, and no cyber grid.
        params: { palette: 'phantom', warp: 0.16, elevation: 0.4, powerLines: true, signage: true, lanterns: true, railway: true, fog: true, shotengai: true, streetTrees: true, voidGrid: false, borderGlow: false,
            clouds: false },   // the procedural cloud deck read as an unlit blue polygon across the black night sky
        renderStyle: null, timeOfDay: 0.9,
        look: {
            cityStyle: { renderStyle: 'cel-hd', toonShadow: true, rimLight: true },
            toonShadows: { bands: 2, softness: 0.04, shadowValue: 0.55, shadowTint: [0.80, 0.74, 0.84], saturation: 0.1 },
            shadowTints: { noon: [0.86, 0.88, 1.0], dawn: [0.92, 0.84, 0.92], dusk: [0.92, 0.82, 0.90], night: [0.78, 0.74, 0.86] },
            sky: {
                night: { top: [0.025, 0.022, 0.03], bottom: [0.17, 0.08, 0.09] },
                dusk: { top: [0.20, 0.12, 0.20], bottom: [0.86, 0.32, 0.22] },
            },
            grade: {
                night: { brightness: 0.05, contrast: 0.16, saturation: 0.08, tint: [1.03, 0.97, 0.97], bloomThreshold: 0.82, bloomIntensity: 0.75, vignette: 0.36,
                         shadowTint: [0.86, 0.82, 0.88], highlightTint: [1.08, 0.94, 0.92] },
                dusk: { contrast: 0.14, saturation: 0.12, tint: [1.05, 0.96, 0.95], shadowTint: [0.88, 0.82, 0.9], highlightTint: [1.08, 0.9, 0.8] },
                noon: { contrast: 0.12, saturation: 0.06, shadowTint: [0.9, 0.9, 0.96] },
            },
            // visual-polish #3: one ink line round each tree canopy (none between its leaf cards) + crease ink fading out
            // over 15-70 m (no dashed mid-range ledges).
            outlines: { color: [0.04, 0.02, 0.03, 1], threshold: 2, depthFade: { near: 30, far: 180, minAlpha: 0.2 }, foliage: 'silhouette', creaseFade: { near: 15, far: 70, minAlpha: 0.1, thinPx: 3 } },   // threshold = line width in px; thinPx: visual-polish #3b
            ssao: true, skyLighting: true, reflections: true, heightFog: 0.35,
            lampColor: [1.0, 0.82, 0.62],
            groundFinish: 'clean', buildingMute: 0.3,
            windowGlow: 0.7,   // lit windows stop clipping to white blobs (frames + rooms read); opt-in look field
            nightSpill: 1, wetSheen: 0.6, playerLight: 1,   // visual-polish #5 / #7c (opt-in look fields)
            // visual-polish #9: the sky dome — a red P5 city glow on the black night, fewer stars, a big moon (clouds off:
            // params.clouds is false, so the dome draws none either)
            skyDome: { cityGlow: 0.55, cityGlowColor: [0.95, 0.24, 0.2], stars: 0.55 },
        },
    },
    {
        name: 'persona4', label: 'Inaba Dusk (P4)',
        params: { palette: 'inaba', warp: 0.35, elevation: 0.55, powerLines: true, signage: true, lanterns: true, shotengai: true, streetTrees: true, fog: true },
        renderStyle: null, timeOfDay: 0.72,
        look: {
            cityStyle: { renderStyle: 'cel-hd', toonShadow: true },
            toonShadows: { bands: 2, softness: 0.08, shadowValue: 0.66, shadowTint: [0.95, 0.62, 0.55], saturation: 0.25 },
            shadowTints: { noon: [0.85, 0.80, 1.0], dusk: [1.0, 0.62, 0.70], dawn: [0.95, 0.75, 0.85], night: [0.6, 0.55, 0.95] },
            grade: {
                dusk: { contrast: 0.06, saturation: 0.18, tint: [1.14, 0.98, 0.82], bloomThreshold: 0.5, bloomIntensity: 1.3, vignette: 0.3,
                        shadowTint: [0.95, 0.7, 0.75], highlightTint: [1.05, 0.95, 0.75] },
                noon: { saturation: 0.1, tint: [1.06, 1.0, 0.9], shadowTint: [0.9, 0.85, 1.0] },
            },
            ssao: true, skyLighting: true, heightFog: 0.8,
            lampColor: [1.0, 0.86, 0.6],
            skyDome: {},   // visual-polish #9: the sky dome (dusk gradient + sun halo; its clouds stay the pack's 3D puffs)
        },
    },
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
        // the cyber void grid + border wall belong HERE (visual-polish #1a turned them off by default for every Tokyo look)
        params: { palette: 'slate', warp: 0.18, holograms: true, signage: true, powerLines: true, cloudDensity: 0.2, fog: true, voidGrid: true, borderGlow: true },
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
