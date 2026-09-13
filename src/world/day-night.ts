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

export interface DayNightInputs {
    /** 'clear' | 'rain' | 'snow' (anything else = clear). */
    weather?: string;
    /** Lightning strobe level 0..1 (storm ticker). */
    flash?: number;
    /** Base sun bearing (radians) the daily east→west sweep adds to. */
    sunAzimuth?: number;
    /** Sky palette keyframes (default: DEFAULT_SKY). */
    skyKeys?: Record<TimeGradePhase, SkyKey>;
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
}

/** All day/night lighting values at time `t` — pure; the caller applies them to the scene. */
export function computeDayNight(t: number, inputs: DayNightInputs = {}): DayNightLighting {
    const ang = (t - 0.25) * Math.PI * 2;                       // sun sweep (0.25 = sunrise on the horizon)
    const elev = Math.sin(ang);                                 // -1..1 sun elevation
    const day = clamp01((elev + 0.12) / 0.45);                  // 0 night → 1 day (soft twilight band)
    const dusk = Math.exp(-((elev / 0.16) ** 2)) * clamp01(day * 3);   // warm burst near sunrise/sunset
    const night = 1 - day;
    const weather = inputs.weather ?? 'clear';
    const rain = weather === 'rain', snow = weather === 'snow'; // overcast: dimmer, flatter, closer fog
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
    if (flash > 0) lc = lerp3(lc, [0.9, 0.93, 1.0], flash * 0.8);
    const sunIntensity = (0.18 + 0.92 * day) * (rain ? 0.72 : snow ? 0.88 : 1) * (1 + flash * 2.2);

    let ac = lerp3([0.16, 0.20, 0.34], [0.55, 0.62, 0.72], day);
    ac = lerp3(ac, [0.75, 0.50, 0.40], dusk * 0.4);
    if (flash > 0) ac = lerp3(ac, [0.85, 0.9, 1.0], flash * 0.6);
    const ambientIntensity = (0.28 + 0.5 * day) * (rain ? 0.85 : 1) * (1 + flash * 1.1);

    // DISTANCE FOG: blue-grey by day, warm at dusk, deep navy at night; weather closes it in (rain haze /
    // bright white winter haze) but with a doubled near→far ramp so it builds half as fast as it once did.
    let fc = lerp3([0.05, 0.07, 0.14], [0.74, 0.81, 0.88], day);
    fc = lerp3(fc, [0.85, 0.58, 0.42], dusk * 0.6);
    if (rain) fc = lerp3(fc, [0.52, 0.56, 0.62], 0.5);
    if (snow) fc = lerp3(fc, [0.82, 0.84, 0.90], 0.55);
    const fogNearMult = rain ? 1.9 : snow ? 2.0 : 2.4;
    const fogFarMult  = rain ? 9.3 : snow ? 10.0 : 7.5;

    const lampOn = night > 0.35 ? Math.min(1, (night - 0.35) / 0.3) : 0;

    return {
        day, night, dusk,
        sunDir: [dirX, dirY, dirZ],
        sunColor: lc, sunIntensity,
        ambientColor: ac, ambientIntensity,
        sky: skyAt(t, inputs.skyKeys ?? DEFAULT_SKY),
        fogColor: fc, fogNearMult, fogFarMult,
        lampOn,
    };
}
