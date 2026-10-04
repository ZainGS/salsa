/**
 * src/world/day-night.ts
 *
 * Day/night cycle LIGHTING MATH — the pure half of WorldManager's `_applyTimeOfDay` (audit C3):
 * time-of-day + weather + lightning-flash → sun direction/colour/intensity, ambient, sky gradient,
 * fog colour + camera-relative distance multipliers, and the street-lamp night level. WorldManager
 * keeps the APPLICATION (setDirectionalLight/setFog3D/lamp candidates/glow) and the tickers.
 *
 * All formulas moved VERBATIM — these curves were hand-tuned in the City-mode sessions (sun azimuth
 * sweep so shadows rake the full compass; capped noon elevation so noon still casts a readable
 * shadow; the dusk gaussian for the warm burst; weather greys; lightning strobe lifts).
 *
 * t convention: 0 = midnight · 0.25 = sunrise · 0.5 = noon · 0.75 = sunset.
 */

export type TimeGradePhase = 'night' | 'dawn' | 'noon' | 'dusk';

/** One SKY-gradient keyframe: the zenith (top) + horizon (bottom) colour at one phase of the day. */
export interface SkyKey {
    top: [number, number, number];      // zenith colour (0..1)
    bottom: [number, number, number];   // horizon colour (0..1)
}

/** Default sky keyframes: deep-navy night → cool lavender dawn → clear blue noon → golden dusk. These reproduce
 *  the old hardcoded gradient (dawn/dusk now DISTINCT — the old formula made them identical at elev 0). */
export const DEFAULT_SKY: Record<TimeGradePhase, SkyKey> = {
    night: { top: [0.03, 0.05, 0.12], bottom: [0.10, 0.12, 0.22] },
    dawn:  { top: [0.30, 0.28, 0.42], bottom: [0.62, 0.52, 0.60] },
    noon:  { top: [0.45, 0.65, 0.88], bottom: [0.82, 0.88, 0.94] },
    dusk:  { top: [0.42, 0.24, 0.34], bottom: [1.00, 0.60, 0.34] },
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const lerp3 = (a: [number, number, number], b: [number, number, number], k: number): [number, number, number] =>
    [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** The sky gradient at time `t`: lerped around the four phase keyframes (night→dawn→noon→dusk→night). */
export function skyAt(t: number, keys: Record<TimeGradePhase, SkyKey>): SkyKey {
    const order: TimeGradePhase[] = ['night', 'dawn', 'noon', 'dusk'];
    const x = ((t % 1) + 1) % 1 * 4;
    const i = Math.floor(x) % 4, k = x - Math.floor(x);
    const a = keys[order[i]], b = keys[order[(i + 1) % 4]];
    const L = (p: number, q: number): number => p + (q - p) * k;
    return {
        top:    [L(a.top[0], b.top[0]),       L(a.top[1], b.top[1]),       L(a.top[2], b.top[2])],
        bottom: [L(a.bottom[0], b.bottom[0]), L(a.bottom[1], b.bottom[1]), L(a.bottom[2], b.bottom[2])],
    };
}

/**
 * How much of each keyframe PHASE the light is in, from the SUN (not the clock) — city-quality L8. Keyed by the same
 * `day` / `dusk` values that drive the sun + ambient, so the sky, the colour grade and the fog always agree with the
 * light (clock-lerped keys left e.g. a 32 % dusk-orange horizon at t = 0.92 against a navy night fog). The twilight
 * share goes to 'dawn' before noon and 'dusk' after. Weights sum to 1. Pure.
 */
export function phaseWeights(t: number, day: number, dusk: number): Record<TimeGradePhase, number> {
    const tt = ((t % 1) + 1) % 1;
    const morning = tt < 0.5;
    const tw = clamp01(dusk);
    const w: Record<TimeGradePhase, number> = {
        night: (1 - day) * (1 - tw),
        noon: day * (1 - tw),
        dawn: morning ? tw : 0,
        dusk: morning ? 0 : tw,
    };
    const sum = w.night + w.noon + w.dawn + w.dusk || 1;
    for (const k of Object.keys(w) as TimeGradePhase[]) w[k] /= sum;
    return w;
}

/** The sky gradient for a set of phase weights (see {@link phaseWeights}). Pure. */
export function skyByWeights(w: Record<TimeGradePhase, number>, keys: Record<TimeGradePhase, SkyKey>): SkyKey {
    const top: [number, number, number] = [0, 0, 0], bottom: [number, number, number] = [0, 0, 0];
    for (const k of Object.keys(w) as TimeGradePhase[]) {
        for (let i = 0; i < 3; i++) { top[i] += keys[k].top[i] * w[k]; bottom[i] += keys[k].bottom[i] * w[k]; }
    }
    return { top, bottom };
}

/** The COLOURED-SHADOW tint per phase (city-quality L3): cool blue by day, violet at dusk / dawn, indigo at night —
 *  the anime shadow cue. Blended by the phase weights; the shader normalises its luminance (hue only). */
export const SHADOW_TINTS: Record<TimeGradePhase, [number, number, number]> = {
    noon:  [0.72, 0.80, 1.00],
    dawn:  [0.82, 0.70, 1.00],
    dusk:  [0.78, 0.60, 1.00],
    night: [0.55, 0.55, 1.00],
};

export interface DayNightInputs {
    /** 'clear' | 'rain' | 'snow' | 'overcast' (anything else = clear). */
    weather?: string;
    /** Lightning strobe level 0..1 (storm ticker). */
    flash?: number;
    /** Base sun bearing (radians) the daily east→west sweep adds to. */
    sunAzimuth?: number;
    /** Sky palette keyframes (default: DEFAULT_SKY). */
    skyKeys?: Record<TimeGradePhase, SkyKey>;
    /** 0..1 GOLDEN-HOUR warmth (polish-round-3 T1.3): near sunrise / sunset the sun goes deeper gold and brighter
     *  while the fill drops, so lit facades glow against cool shadows. 0 / absent = the original curves. */
    sunWarmth?: number;
    /** 0..1 KEY/FILL contrast (persona-polish A4): by day a warmer, stronger sun over a cooler, LOWER and less blue sky
     *  fill — lit faces pop against their shade. 0 / absent = the original curves (saved cities unchanged). */
    keyFill?: number;
    /** 0..1 COOL FILL (visual-polish #4): at golden hour / dusk the shade-side fill goes cool blue-violet instead of the
     *  warm dusk ambient, so a gold-lit facade sits against cool shadow (complementary light). 0 / absent = the
     *  original warm dusk fill (saved cities unchanged). */
    coolFill?: number;
}

export interface DayNightLighting {
    day: number;                                  // 0 night → 1 day (soft twilight band)
    night: number;                                // 1 − day
    dusk: number;                                 // warm burst near sunrise/sunset (gaussian on elevation)
    sunDir: [number, number, number];             // unit-ish direction TOWARD the scene (y down)
    sunColor: [number, number, number];
    sunIntensity: number;
    ambientColor: [number, number, number];
    ambientIntensity: number;
    sky: SkyKey;                                  // zenith + horizon gradient at t
    fogColor: [number, number, number];
    /** Camera-relative fog distances = these × the world extent R (weather closes them in). */
    fogNearMult: number;
    fogFarMult: number;
    /** Street-lamp point-light level: 0 by day, ramping 0→1 as night deepens past 0.35. */
    lampOn: number;
    /** How much of each keyframe phase the light is in (sun-driven; sums to 1) — for the grade keys too. */
    weights: Record<TimeGradePhase, number>;
    /** Suggested coloured-shadow tint (blue day / violet dusk / indigo night). */
    shadowTint: [number, number, number];
}

/** All day/night lighting values at time `t` — pure; the caller applies them to the scene. */
export function computeDayNight(t: number, inputs: DayNightInputs = {}): DayNightLighting {
    const ang = (t - 0.25) * Math.PI * 2;                       // sun sweep (0.25 = sunrise on the horizon)
    const elev = Math.sin(ang);                                 // -1..1 sun elevation
    const day = clamp01((elev + 0.12) / 0.45);                  // 0 night → 1 day (soft twilight band)
    const dusk = Math.exp(-((elev / 0.16) ** 2)) * clamp01(day * 3);   // warm burst near sunrise/sunset
    const night = 1 - day;
    const weather = inputs.weather ?? 'clear';
    const rain = weather === 'rain', snow = weather === 'snow', overcast = weather === 'overcast';   // overcast: dimmer, flatter, closer fog
    const flash = inputs.flash ?? 0;                            // lightning strobe (storms; set by the ticker)

    // SUN: a proper AZIMUTH+ELEVATION direction — azimuth = base bearing + the daily east→west sweep, so
    // shadows rake the full compass over a day. Elevation peaks at noon but is CAPPED off vertical so noon
    // still casts a readable shadow, and flattens (long shadows) at dawn/dusk. Night keeps a low fill.
    const sunAz = (inputs.sunAzimuth ?? 0) + ang;
    const dirY  = -Math.min(0.85, Math.max(0.1, elev * 0.9 + 0.1));   // downward; capped so noon isn't shadowless
    const horiz = Math.sqrt(Math.max(0.02, 1 - dirY * dirY));         // horizontal length of the unit direction
    const dirX  = -Math.sin(sunAz) * horiz;
    const dirZ  = -Math.cos(sunAz) * horiz;

    let lc = lerp3([0.30, 0.40, 0.62], [1.0, 0.97, 0.90], day);
    lc = lerp3(lc, [1.0, 0.55, 0.30], dusk * 0.7);
    if (rain) lc = lerp3(lc, [0.55, 0.58, 0.64], 0.55);         // grey key light under the rain deck
    if (snow) lc = lerp3(lc, [0.80, 0.83, 0.90], 0.4);          // cold pale winter light
    if (overcast) lc = lerp3(lc, [0.78, 0.80, 0.84], 0.6);      // flat white-grey light under the cloud deck
    // GOLDEN HOUR (sunWarmth): a BROADER bell than the dusk burst (the sun stays gold up to ~20 deg elevation), weighted
    // by the look's warmth. It also widens the dusk PHASE below, so the sky / grade / shadow hue agree with the light.
    const warm = clamp01(inputs.sunWarmth ?? 0) * (rain || snow || overcast ? 0.3 : 1);
    const golden = warm > 0 ? Math.exp(-((elev / 0.4) ** 2)) * clamp01(day * 3) * warm : 0;
    if (golden > 0) lc = lerp3(lc, [1.0, 0.60, 0.28], Math.min(1, golden * 1.2));
    // KEY/FILL (A4): weather-damped (a cloud deck flattens the light anyway) and daytime-only.
    const kd = clamp01(inputs.keyFill ?? 0) * (rain || snow || overcast ? 0.35 : 1) * day;
    if (kd > 0) lc = lerp3(lc, [1.0, 0.9, 0.74], 0.5 * kd * (1 - Math.min(1, golden * 1.2)));
    if (flash > 0) lc = lerp3(lc, [0.9, 0.93, 1.0], flash * 0.8);
    const sunIntensity = (0.18 + 0.92 * day) * (rain ? 0.72 : snow ? 0.88 : overcast ? 0.55 : 1) * (1 + flash * 2.2)
        * (1 + 0.8 * golden) * (1 + 0.22 * kd);

    // ★ city-quality L1: the city no longer self-lights at 45 % (the flat-map emissive floor is gone), so the ambient
    // carries the shadow side on its own. Night is a deeper INDIGO fill that still reads silhouettes — the lamps and
    // neon do the real lighting; day lifts slightly so shadowed faces aren't muddy.
    let ac = lerp3([0.20, 0.20, 0.42], [0.58, 0.64, 0.74], day);
    const cf = clamp01(inputs.coolFill ?? 0) * (rain || snow || overcast ? 0.3 : 1);
    ac = lerp3(ac, [0.75, 0.50, 0.46], dusk * 0.4 * (1 - cf));
    if (cf > 0) ac = lerp3(ac, [0.50, 0.56, 0.80], cf * Math.min(1, Math.max(dusk, golden)) * 0.55);   // visual-polish #4: cool shade fill
    if (flash > 0) ac = lerp3(ac, [0.85, 0.9, 1.0], flash * 0.6);
    if (overcast) ac = lerp3(ac, [0.66, 0.68, 0.72], 0.5 * day);   // the sky dome carries the light → brighter, greyer fill
    if (kd > 0) ac = lerp3(ac, [0.60, 0.63, 0.69], 0.55 * kd);   // A4: cool but no longer sky-BLUE (the blue cast)
    const ambientIntensity = (0.34 + 0.5 * day) * (rain ? 0.85 : overcast ? 1.15 : 1) * (1 + flash * 1.1)
        * (1 - 0.35 * golden) * (1 - 0.2 * kd);

    // DISTANCE FOG: blue-grey by day, warm at dusk, deep navy at night; weather closes it in (rain haze /
    // bright white winter haze) but with a doubled near→far ramp so it builds half as fast as it once did.
    // Sky + fog from the SUN-driven phase weights (L8): fog leans into the sky's horizon colour, so the fogged city
    // meets the sky with no visible band, and custom sky keys reach the fog.
    const weights = phaseWeights(t, day, Math.max(dusk, golden * 0.85));
    const sky = skyByWeights(weights, inputs.skyKeys ?? DEFAULT_SKY);
    let fc = lerp3([0.05, 0.07, 0.14], [0.74, 0.81, 0.88], day);
    fc = lerp3(fc, [0.85, 0.58, 0.42], dusk * 0.6);
    fc = lerp3(fc, sky.bottom, 0.6);
    if (rain) fc = lerp3(fc, [0.52, 0.56, 0.62], 0.5);
    if (snow) fc = lerp3(fc, [0.82, 0.84, 0.90], 0.55);
    if (overcast) fc = lerp3(fc, [0.74, 0.76, 0.80], 0.45 * day + 0.1);
    const fogNearMult = rain ? 1.9 : snow ? 2.0 : overcast ? 2.1 : 2.4;
    const fogFarMult  = rain ? 9.3 : snow ? 10.0 : overcast ? 8.5 : 7.5;

    const lampOn = night > 0.35 ? Math.min(1, (night - 0.35) / 0.3) : 0;

    return {
        day, night, dusk,
        sunDir: [dirX, dirY, dirZ],
        sunColor: lc, sunIntensity,
        ambientColor: ac, ambientIntensity,
        sky,
        weights,
        shadowTint: ((): [number, number, number] => {
            const c: [number, number, number] = [0, 0, 0];
            for (const k of Object.keys(weights) as TimeGradePhase[]) for (let i = 0; i < 3; i++) c[i] += SHADOW_TINTS[k][i] * weights[k];
            return c;
        })(),
        fogColor: fc, fogNearMult, fogFarMult,
        lampOn,
    };
}
