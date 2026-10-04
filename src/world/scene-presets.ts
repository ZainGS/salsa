// ── World generation — CITY SCENE PRESETS (polish-round-3 T1.1) ─────────────────────────────────────
// ONE clean PBR look (the P5X Shibuya street shot: quiet surfaces, muted buildings under saturated signs,
// soft shadows, gentle bloom on signs only, subtle haze) lit at different TIMES OF DAY × WEATHER.
//
// A scene preset is DATA-ONLY, like a style pack, but it never touches the layout: it sets the time of day,
// the weather (+ cloud cover) and the full LOOK. Weather / clouds are selective params (they respawn the movers
// and re-dress the lights — no city rebuild), and every look field is a live material / uniform edit. The render
// style is the default PBR (the look's `cityStyle` is absent → cleared), except the opt-in GRAPHIC look (visual-polish
// #8: the 'graphic' preset, or any preset with the graphic modifier). The old style packs
// (CITY_STYLES) stay reachable through WorldManager.applyStyle.

import type { CityLook, CityGradeKeyPatch } from './styles';
import type { TimeGradePhase, SkyKey } from './day-night';
import type { LayoutParams } from './types';

type C3 = [number, number, number];

export interface CityScenePreset {
    name: string;
    label: string;
    /** 0 midnight · 0.25 sunrise · 0.5 noon · 0.75 sunset. */
    timeOfDay: number;
    weather: LayoutParams['weather'];
    /** Cloud cover 0..1 (the `cloudDensity` param). */
    cloudDensity: number;
    look: CityLook;
}

/** The clean-look sky: soft blue days, a PAINTED golden hour (violet zenith → orange horizon), lavender dawns. */
export const CLEAN_SKY: Record<TimeGradePhase, SkyKey> = {
    night: { top: [0.035, 0.045, 0.11], bottom: [0.13, 0.12, 0.24] },
    dawn:  { top: [0.40, 0.42, 0.66], bottom: [0.98, 0.76, 0.62] },
    noon:  { top: [0.40, 0.60, 0.86], bottom: [0.80, 0.86, 0.92] },
    dusk:  { top: [0.36, 0.25, 0.55], bottom: [1.00, 0.58, 0.30] },
};

/** Gentle grade: bloom only on the brightest (emissive) pixels, near-neutral colour, a soft vignette. */
export const CLEAN_GRADE: Record<TimeGradePhase, CityGradeKeyPatch> = {
    // persona-polish A4: warmer highlights, less blue in the shadows (the review's "cool blue cast"), a touch more contrast.
    noon:  { bloomThreshold: 0.95, bloomIntensity: 0.28, brightness: 0.01, contrast: 0.09, saturation: 0.02, tint: [1.01, 1.0, 0.98], vignette: 0.12,
             shadowTint: [0.92, 0.94, 1.0], highlightTint: [1.05, 1.0, 0.93] },
    dawn:  { bloomThreshold: 0.85, bloomIntensity: 0.4, brightness: 0.0, contrast: 0.06, saturation: 0.02, tint: [1.04, 0.99, 0.97], vignette: 0.16,
             shadowTint: [0.8, 0.8, 1.0], highlightTint: [1.04, 0.97, 0.9] },
    dusk:  { bloomThreshold: 0.8, bloomIntensity: 0.5, brightness: 0.0, contrast: 0.08, saturation: 0.06, tint: [1.08, 0.97, 0.9], vignette: 0.18,
             shadowTint: [0.86, 0.82, 1.0], highlightTint: [1.1, 0.95, 0.76] },
    night: { bloomThreshold: 0.6, bloomIntensity: 0.95, brightness: -0.02, contrast: 0.08, saturation: 0.06, tint: [0.94, 0.95, 1.06], vignette: 0.26,
             shadowTint: [0.62, 0.62, 1.0], highlightTint: [1.04, 0.96, 0.88] },
};

/** Coloured shadows for the clean look: cool blue by day, violet at golden hour, indigo at night. */
export const CLEAN_SHADOW_TINTS: Record<TimeGradePhase, C3> = {
    noon:  [0.88, 0.91, 1.00],   // persona-polish A4: was [0.78, 0.84, 1.00] - cool, but not a blue wash
    dawn:  [0.86, 0.80, 1.00],
    dusk:  [0.84, 0.76, 1.00],
    night: [0.55, 0.55, 1.00],
};

/** The CLEAN PBR baseline (T1.2) every scene preset starts from. */
export const CITY_CLEAN_LOOK: CityLook = {
    grade: CLEAN_GRADE,
    sky: CLEAN_SKY,
    shadowTints: CLEAN_SHADOW_TINTS,
    ssao: false,
    skyLighting: true,
    reflections: false,
    heightFog: 0.2,
    lampColor: [1.0, 0.84, 0.6],
    groundFinish: 'clean',
    paving: 'tiles',
    buildingMute: 0.35,
    paintedClouds: true,
    shadowSoftness: 1.9,
    sunWarmth: 0.8,
    keyFill: 1,       // persona-polish A4: warm strong key over a cool, lower, less blue fill
    aerialHaze: 1,    // persona-polish A5: street-scale aerial perspective
    // visual-polish #5 / #7c (2026-10-03): night light spill + soft coloured lamp pools, and the Play player light. Both
    // are gated by the night level, so they show only after dusk; on in every scene preset (new / re-applied cities).
    nightSpill: 1,
    playerLight: 1,
    // visual-polish #9: the stylised sky dome — night gradient + city glow, moon + halo, stars, anime cumulus. The
    // presets differ only by time / weather (overcast / rain / snow hide the sun, moon, stars and painted clouds).
    skyDome: {},
    // visual-polish #11 (2026-10-04): the district palette + roof variety (geometry: a 'World Streets' rebuild the first
    // time a preset meets a city without them; a saved city keeps its own until a preset is applied).
    districtPalette: true,
    roofVariety: true,
    // visual-polish #11 tail (2026-10-04): fewer, larger, coloured roof plant clustered at the back of the roof.
    roofEquipment: 'clustered',
};

const merge = (over: CityLook): CityLook => {
    const out: CityLook = { ...CITY_CLEAN_LOOK, ...over };
    // Per-phase maps merge per phase (a preset can retune one phase and keep the rest).
    out.grade = { ...CLEAN_GRADE } as CityLook['grade'];
    for (const k of Object.keys(over.grade ?? {}) as TimeGradePhase[]) out.grade![k] = { ...CLEAN_GRADE[k], ...over.grade![k] };
    out.sky = { ...CLEAN_SKY } as CityLook['sky'];
    for (const k of Object.keys(over.sky ?? {}) as TimeGradePhase[]) out.sky![k] = { ...CLEAN_SKY[k], ...over.sky![k] };
    out.shadowTints = { ...CLEAN_SHADOW_TINTS, ...(over.shadowTints ?? {}) };
    return out;
};

/** visual-polish #8: the GRAPHIC look — the built toon parts composed into one Persona-style frame: the cel-hd render
 *  style with toon shadows + rim light, ink outlines that thin and fade with distance (2 px near -> 1 px / faint past
 *  ~180 m, so far poles and window grids never break into dashes) and cool, low-saturation shadow tints. Opt-in: it
 *  is layered over a scene preset ({@link withGraphicLook}); the clean PBR default stays the P5X reference. */
export const GRAPHIC_LOOK: Pick<CityLook, 'cityStyle' | 'toonShadows' | 'outlines' | 'shadowTints'> = {
    cityStyle: { renderStyle: 'cel-hd', toonShadow: true, rimLight: true },
    toonShadows: { bands: 2, softness: 0.04, shadowValue: 0.6, shadowTint: [0.74, 0.78, 1.0], saturation: 0.12 },
    // visual-polish #3: a silhouette-only line round tree canopies (no scribbles between leaf cards) and crease ink that
    // fades out over 15-70 m, so mid-range ledges no longer break into dashes (silhouettes keep the depth fade above).
    outlines: { color: [0.05, 0.03, 0.06, 1], threshold: 2, depthFade: { near: 30, far: 180, minAlpha: 0.2 }, foliage: 'silhouette', creaseFade: { near: 15, far: 70, minAlpha: 0.1, thinPx: 3 } },   // thinPx: visual-polish #3b (no dashed mid-range ledges)
    shadowTints: { noon: [0.84, 0.88, 1.0], dawn: [0.84, 0.82, 1.0], dusk: [0.80, 0.84, 1.0], night: [0.62, 0.62, 1.0] },
};
/** `look` with the GRAPHIC look layered on top (render style, toon shadows, ink outlines, cool shadow tints). */
export function withGraphicLook(look: CityLook): CityLook {
    return {
        ...look,
        cityStyle: { ...GRAPHIC_LOOK.cityStyle },
        toonShadows: { ...GRAPHIC_LOOK.toonShadows, shadowTint: [...GRAPHIC_LOOK.toonShadows!.shadowTint!] as C3 },
        outlines: { ...GRAPHIC_LOOK.outlines!, color: [...GRAPHIC_LOOK.outlines!.color] as [number, number, number, number], depthFade: { ...GRAPHIC_LOOK.outlines!.depthFade! }, creaseFade: { ...GRAPHIC_LOOK.outlines!.creaseFade! } },
        shadowTints: { ...(look.shadowTints ?? {}), ...GRAPHIC_LOOK.shadowTints },
    };
}

export const CITY_SCENE_PRESETS: CityScenePreset[] = [
    { name: 'morning', label: 'Morning', timeOfDay: 0.3, weather: 'clear', cloudDensity: 0.3,
      look: merge({ heightFog: 0.3 }) },
    { name: 'noon', label: 'Noon', timeOfDay: 0.5, weather: 'clear', cloudDensity: 0.35,
      // visual-polish #4: the facades kept a blue-grey cast — a touch warmer grade, neutral-cool (not blue) shade.
      look: merge({ heightFog: 0.15, shadowSoftness: 1.6,
          grade: { noon: { tint: [1.03, 1.0, 0.96], shadowTint: [0.95, 0.96, 1.0], highlightTint: [1.06, 1.0, 0.92] } } }) },
    { name: 'golden', label: 'Golden Hour', timeOfDay: 0.7, weather: 'clear', cloudDensity: 0.4,
      // visual-polish #4 (2026-10-03): COMPLEMENTARY light. The 2026-09-30 tune (warm shadows + a [1.14, 1, 0.82] frame
      // tint) escaped the lavender but overshot into one sepia mass. The warmth now lives in the SUN only (sunWarmth +
      // a gold highlight split-tone); shadows and the shade-side fill go cool blue-violet, the frame tint is near neutral
      // and a mild saturation lift lets the signs pop over the muted buildings.
      look: merge({ heightFog: 0.3, shadowSoftness: 2.1, sunWarmth: 1, coolFill: 1, buildingMute: 0.22,   // less grey-down: the sun's gold needs some wall colour to land on
          shadowTints: { dusk: [0.80, 0.86, 1.0] },
          sky: { dusk: { top: [0.40, 0.42, 0.70], bottom: [1.00, 0.64, 0.36] } },
          // after-shot tune (2026-10-03): [1.04, 1, 0.95] + a [1.12, .97, .78] split read GREY (no golden hour left);
          // a little frame warmth back and a stronger gold highlight split, shadows stay cool.
          grade: { dusk: { saturation: 0.14, tint: [1.07, 1.0, 0.92], shadowTint: [0.86, 0.9, 1.0], highlightTint: [1.18, 0.96, 0.72] } } }) },
    { name: 'dusk', label: 'Dusk', timeOfDay: 0.755, weather: 'clear', cloudDensity: 0.4,
      look: merge({ heightFog: 0.4, grade: { dusk: { bloomThreshold: 0.7, bloomIntensity: 0.7 } } }) },
    { name: 'night', label: 'Night', timeOfDay: 0.93, weather: 'clear', cloudDensity: 0.25,
      // Tuned 2026-09-30: street level was near-black with blown-out white windows — lift the blacks, bloom later.
      look: merge({ heightFog: 0.35, reflections: true, wetSheen: 0.6,   // visual-polish #5: damp asphalt so lamps + signs streak
          grade: { night: { brightness: 0.09, contrast: 0.02, bloomThreshold: 0.78, bloomIntensity: 0.7, shadowTint: [0.72, 0.72, 1.0] } } }) },
    { name: 'rainyEvening', label: 'Rainy Evening', timeOfDay: 0.775, weather: 'rain', cloudDensity: 0.7,
      look: merge({ heightFog: 0.55, reflections: true, paintedClouds: false, wetSheen: 1,   // visual-polish #5: rain-slick, reflections read
          grade: { night: { saturation: 0.02, tint: [0.92, 0.96, 1.04], brightness: 0.08, bloomThreshold: 0.78, bloomIntensity: 0.7 }, dusk: { saturation: 0.0, tint: [1.0, 0.97, 0.96], brightness: 0.03 } } }) },
    { name: 'snowyMorning', label: 'Snowy Morning', timeOfDay: 0.33, weather: 'snow', cloudDensity: 0.6,
      look: merge({ heightFog: 0.45, paintedClouds: false, shadowSoftness: 2.4,
          grade: { dawn: { tint: [0.98, 1.0, 1.04], saturation: -0.04 }, noon: { tint: [0.97, 0.99, 1.03], saturation: -0.04 } } }) },
    { name: 'overcast', label: 'Overcast', timeOfDay: 0.52, weather: 'overcast', cloudDensity: 0.8,
      look: merge({ heightFog: 0.4, paintedClouds: false, shadowSoftness: 2.6,
          sky: { noon: { top: [0.62, 0.66, 0.72], bottom: [0.80, 0.82, 0.85] } },
          grade: { noon: { saturation: -0.05, contrast: 0.03, bloomThreshold: 0.98, bloomIntensity: 0.2 } } }) },
];

// visual-polish #8: the one-click GRAPHIC look — Golden Hour with the toon parts composed on top (also reachable as a
// modifier on any preset: WorldManager.applyScenePreset(name, { graphic: true })).
{
    const golden = CITY_SCENE_PRESETS.find((p) => p.name === 'golden')!;
    CITY_SCENE_PRESETS.push({ name: 'graphic', label: 'Graphic', timeOfDay: golden.timeOfDay, weather: 'clear', cloudDensity: golden.cloudDensity, look: withGraphicLook(golden.look) });
}

export const CITY_SCENE_PRESET_NAMES = CITY_SCENE_PRESETS.map((p) => p.name);
export const cityScenePreset = (name: string): CityScenePreset | undefined => CITY_SCENE_PRESETS.find((p) => p.name === name);
