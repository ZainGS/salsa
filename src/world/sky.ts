// ── World generation — night sky dressing ───────────────────────────────────────────────────────
// STARS + a MOON: tiny emissive blobs scattered on a high dome over the diorama, plus one pale moon disc.
// Built once with the city; the day/night cycle toggles their VISIBILITY (they only show at night, and hide
// under an overcast rain/snow deck) and cranks their glow — see world-manager._applyTimeOfDay.

import type { WorldGraph, LayoutPreviewLayer } from './types';
import type { DayNightLighting } from './day-night';
import type { CitySkyDome } from './styles';
import type { SkyDomeParams } from '../types/armature-3d';
import { Accum3D } from './meshbuild';
import { hash2 } from './util';
import { tiledWorldExtent } from './tiled';

type V3 = [number, number, number];

// ── visual-polish #9: the SKY DOME look per time of day ─────────────────────────────────────────────────────────
// With CityLook.skyDome on, the city sky is drawn by the view-direction dome backdrop (renderer/3d/sky-dome-pass.ts)
// instead of the flat screen gradient: the stars + moon + painted clouds live IN it (the blob stars / moon and, for
// cloud style 'anime', the soft cloud cards are hidden). It is a BACKDROP only: the sky lighting (IBL) is still baked
// from the sky keys alone (WorldManager._applySkyLighting), so the moon, stars, clouds and city glow never light the
// city — the night-lighting work owns the ground light.

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix3 = (a: readonly number[], b: readonly number[], t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale3 = (a: readonly number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add3 = (...v: (readonly number[])[]): V3 => { const o: V3 = [0, 0, 0]; for (const c of v) { o[0] += c[0]; o[1] += c[1]; o[2] += c[2]; } return o; };
const norm3 = (a: readonly number[]): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Hue-keeping normalise to a max channel of `m`. */
const toMax = (a: readonly number[], m = 1): V3 => { const k = m / Math.max(1e-4, a[0], a[1], a[2]); return [a[0] * k, a[1] * k, a[2] * k]; };

/** The SKY DOME defaults (CitySkyDome fields absent). */
export const SKY_DOME_DEFAULTS: Required<CitySkyDome> = {
    stars: 1, moon: 1, moonAzimuthDeg: 200, moonElevationDeg: 24, cityGlow: 0.6, cityGlowColor: [1.0, 0.55, 0.32], clouds: 'anime',
};

/** A validated copy of a look's sky-dome block (null = off / malformed). Only the fields present are kept, so a saved
 *  marker round-trips byte-identical. */
export function cleanSkyDome(v: unknown): CitySkyDome | null {
    if (!v || typeof v !== 'object') return null;
    const s = v as Record<string, unknown>, out: CitySkyDome = {};
    const num = (k: 'stars' | 'moon' | 'cityGlow', lo: number, hi: number): void => { const x = s[k]; if (typeof x === 'number' && isFinite(x)) out[k] = Math.max(lo, Math.min(hi, x)); };
    num('stars', 0, 1); num('moon', 0, 1); num('cityGlow', 0, 1);
    if (typeof s.moonAzimuthDeg === 'number' && isFinite(s.moonAzimuthDeg)) out.moonAzimuthDeg = ((s.moonAzimuthDeg % 360) + 360) % 360;
    if (typeof s.moonElevationDeg === 'number' && isFinite(s.moonElevationDeg)) out.moonElevationDeg = Math.max(5, Math.min(80, s.moonElevationDeg));
    const g = s.cityGlowColor;
    if (Array.isArray(g) && g.length === 3 && g.every((c) => typeof c === 'number' && isFinite(c))) out.cityGlowColor = [clamp01(g[0]), clamp01(g[1]), clamp01(g[2])];
    if (s.clouds === 'anime' || s.clouds === 'cards') out.clouds = s.clouds;
    return out;
}

export interface SkyDomeInputs {
    /** Time of day 0..1 (0 midnight · 0.25 sunrise · 0.5 noon · 0.75 sunset). */
    t: number;
    /** computeDayNight at t (the sky keys, sun colour, phase weights, fog colour). */
    L: DayNightLighting;
    /** The city's base sun bearing (radians), as passed to computeDayNight. */
    sunAzimuth: number;
    weather: string;
    dome: CitySkyDome;
    /** Painted clouds wanted in the dome (look paintedClouds + the Clouds toggle + cloud style 'anime'). */
    clouds: boolean;
    /** Cloud cover 0..1 (LayoutParams.cloudDensity). */
    cloudDensity: number;
    seed: number;
}

/** The dome's uniforms for one moment of the day (pure; unit-tested). Weather other than clear hides the sun disc,
 *  moon, stars and painted clouds (the weather deck covers the sky) and spreads the city glow onto the deck. */
export function skyDomeParams(inp: SkyDomeInputs): SkyDomeParams {
    const { L, dome } = inp, d = { ...SKY_DOME_DEFAULTS, ...dome };
    const clear = inp.weather === 'clear' || !inp.weather;
    const w = L.weights, n = L.night;
    // the TRUE sun position (the light's elevation is capped off vertical and never below 0.1 down; the disc is not)
    const ang = (inp.t - 0.25) * Math.PI * 2, elev = Math.sin(ang);
    const hx = -L.sunDir[0], hz = -L.sunDir[2], hl = Math.hypot(hx, hz) || 1, ch = Math.sqrt(Math.max(0, 1 - elev * elev));
    const sunDir: V3 = [hx / hl * ch, elev, hz / hl * ch];
    const ma = inp.sunAzimuth + d.moonAzimuthDeg * Math.PI / 180, me = d.moonElevationDeg * Math.PI / 180;
    const moonDir: V3 = [Math.sin(ma) * Math.cos(me), Math.sin(me), Math.cos(ma) * Math.cos(me)];
    const zen = L.sky.top, hor = L.sky.bottom;

    const glowAmount = d.cityGlow * clamp01((n - 0.25) / 0.6) * (clear ? 1 : 1.15);
    const below = clamp01((elev + 0.25) / 0.25);       // the sun's horizon band fades once it is ~15 deg under
    const low = w.dawn + w.dusk;
    const sunc = toMax(L.sunColor);
    // golden (the sun up) vs the after-sunset silhouette, inside the dawn / dusk phases
    const golden = clamp01((elev + 0.03) / 0.15);

    // CLOUD tones: noon white over blue-grey shade; golden = peach tops, violet shade, gold rims; after sunset = dark
    // violet silhouettes with lit orange undersides; night = moonlit blue-grey over a shade just lighter than the sky.
    const litNoon = mix3([0.98, 0.98, 0.99], sunc, 0.12), shadeNoon = mix3(zen, [0.80, 0.84, 0.92], 0.62);
    const litGold = mix3(sunc, [1, 1, 1], 0.16), shadeGold = mix3(mix3(zen, hor, 0.35), [0.66, 0.52, 0.70], 0.45);
    const rimGold = toMax([Math.pow(sunc[0], 1.6), Math.pow(sunc[1], 1.6), Math.pow(sunc[2], 1.6)], 1);
    const litDusk = mix3(hor, sunc, 0.55), shadeDusk = add3(scale3(zen, 0.62), [0.02, 0.01, 0.03]), rimDusk = toMax(sunc, 0.95);
    const shadeNight = add3(scale3(mix3(zen, hor, 0.5), 1.05), [0.01, 0.012, 0.025]), litNight = [0.22, 0.25, 0.36], rimNight = [0.52, 0.56, 0.70];
    const litLow = mix3(litDusk, litGold, golden), shadeLow = mix3(shadeDusk, shadeGold, golden), rimLow = mix3(rimDusk, rimGold, golden);
    // the clouds lean into the low-sun look sooner than the sky does (a golden-hour sky is still half noon-blue)
    const wl = Math.min(1, low * 1.6), wsum = w.noon + wl + w.night || 1;
    const tone = (a: readonly number[], b: readonly number[], c: readonly number[]): V3 => add3(scale3(a, w.noon / wsum), scale3(b, wl / wsum), scale3(c, w.night / wsum));
    const toMoon = clamp01((n - 0.4) / 0.2);
    return {
        zenith: [zen[0], zen[1], zen[2]], horizon: [hor[0], hor[1], hor[2]], ground: [L.fogColor[0], L.fogColor[1], L.fogColor[2]],
        gradientBias: 3,
        glowColor: [d.cityGlowColor[0], d.cityGlowColor[1], d.cityGlowColor[2]], glowAmount, glowHeight: clear ? 0.12 : 0.3,
        sunDir, sunColor: [sunc[0], sunc[1], sunc[2]],
        sunDisc: clear ? clamp01((elev + 0.03) / 0.06) * (1 - 0.5 * n) : 0,
        sunHalo: clear ? (0.12 + 0.55 * low) * below : 0,
        moonDir, moonColor: [0.96, 0.95, 0.86], moon: clear ? d.moon * clamp01((n - 0.45) / 0.3) : 0, moonSize: 0.042, moonHalo: 0.55,
        stars: clear ? d.stars * clamp01((n - 0.55) / 0.3) * 0.9 : 0,
        clouds: clear && inp.clouds ? 1 : 0,
        cloudLit: tone(litNoon, litLow, litNight), cloudShade: tone(shadeNoon, shadeLow, shadeNight), cloudRim: tone(litNoon, rimLow, rimNight),
        cloudRimAmount: (0.3 * w.noon + 1.4 * wl + 0.6 * w.night) / wsum,
        cloudLightDir: norm3(mix3(sunDir, moonDir, toMoon)),
        cloudGlow: scale3(d.cityGlowColor, glowAmount * 0.3),
        cloudSeed: inp.seed | 0, cloudCoverage: clamp01(inp.cloudDensity), cloudDrift: 0.0025,
    };
}

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

    const clouds = buildHorizonClouds(graph);
    // E1: soft painted cloud CARDS (radial alpha fade, transparent pass). The body takes the sky tint in its shade, the
    // RIM cards (raised, just behind) take the sun colour — golden hour gets warm lit crowns (WorldManager glow walk).
    const card = (name: string, acc: Accum3D, color: V3, opacity: number): LayoutPreviewLayer[] => acc.empty ? []
        : [{ name, color, y: gy, geometry: acc.geometry(), emissive: 0.3, opacity, radialFade: true, excludeFromFrame: true, noWarp: true, noFog: 'hardEdge' }];
    // noFog 'hardEdge' (fog-horizon follow-up): under the soft fog the banks and stars keep blending into the haze (the
    // look they were tuned for); under Hard fog edge, past Far, they would be fog-coloured blobs, so they skip the fog.
    return [
        // ★ Order matters: transparent meshes draw in list order (no depth sort), so the body goes FIRST and the rim
        // blends over its upper part — sunlit crown on top, sky-shaded underside below.
        ...card('world:sky-clouds', clouds.body, [0.96, 0.95, 0.97], 0.93),
        ...card('world:sky-clouds-rim', clouds.rim, [1.0, 0.98, 0.95], 0.72),
        { name: 'world:sky-stars', color: [0.95, 0.96, 1.0], y: gy, geometry: stars.geometry(), emissive: 1.3, excludeFromFrame: true, noFog: 'hardEdge' },   // L7: the 2.2R dome must not drag the auto-frame out (the city looked tiny)
        { name: 'world:sky-moon', color: [0.92, 0.93, 0.86], y: gy, geometry: moon.geometry(), emissive: 1.1, excludeFromFrame: true, noFog: 'hardEdge' },
    ];
}

/** PAINTED HORIZON CLOUD BANKS (polish-round-3 T1.3 → persona-polish E1): a ring of long cumulus banks low on the
 *  horizon — what an eye-level street view actually sees of the sky. Each bank is a row of big SOFT CARDS facing the
 *  city (unit radial UVs → the radialFade flag dissolves every card to nothing at its rim), crowned taller in the
 *  middle, over one long thin BASE card that closes the flat-ish underside. Overlapping cards build a dense core with
 *  feathered edges: the painted P5 sky, not the faceted ellipsoid puffs they replace. The rim set sits a little
 *  higher and just behind each crown puff, so the sunlit edge reads above the shaded body. Hidden unless the look
 *  turns painted clouds on (and the weather is clear). */
function buildHorizonClouds(graph: WorldGraph): { body: Accum3D; rim: Accum3D } {
    const p = graph.params, R = p.worldMode === 'tiled' ? tiledWorldExtent(p) : p.radius, gy = p.groundY;
    const body = new Accum3D(), rim = new Accum3D();
    const H = (a: number, b: number): number => hash2(a * 3.17 + 0.5, b * 9.41, (p.seed ^ 0x6c1d) >>> 0);
    const banks = 10;
    for (let i = 0; i < banks; i++) {
        const az = (i + H(i, 1) * 0.7) / banks * Math.PI * 2;
        // 2.6-3.1 R out: past the city + apron from anywhere inside, yet near enough that the haze leaves them contrast
        // (and inside the camera's far plane — at ~5 R the far plane sliced the banks into straight edges).
        // visual-polish #9 FIX (the sliced card in tiled-golden-roof): a TILED world's far plane (autoFar = |eye - target|
        // + 2 x scene radius, ~2.8 x the tiled extent) cut the far-side banks at 2.6-3.1 x the extent into a straight
        // diagonal edge. Tiled banks sit at 1.7-1.9 x the extent (always inside the far plane from anywhere in the
        // world) and shrink with the distance, so their apparent size is unchanged. Single cities keep 2.6-3.1 R.
        const tiled = p.worldMode === 'tiled';
        const dist = tiled ? R * (1.7 + H(i, 2) * 0.2) : R * (2.6 + H(i, 2) * 0.5);
        const sz = tiled ? dist / (R * (2.6 + H(i, 2) * 0.5)) : 1;   // keep the apparent (angular) size
        const cx = Math.cos(az) * dist, cz = Math.sin(az) * dist;
        const tangent: V3 = [-Math.sin(az), 0, Math.cos(az)], radial: V3 = [Math.cos(az), 0, Math.sin(az)];
        const baseY = gy + dist * (0.02 + H(i, 3) * 0.035);  // base ~1-3 deg above the horizon
        const width = R * (0.6 + H(i, 4) * 0.8) * sz;
        const tall = 0.8 + H(i, 8) * 0.9;                   // some banks tower (crowns up to ~12 deg), some lie low
        // The long flat underside.
        cloudCard(body, [cx, baseY + width * 0.04, cz], tangent, radial, width * 0.8, width * 0.1, width * 0.07, 0);
        cloudCard(body, [cx, baseY + width * 0.04, cz], tangent, radial, width * 0.66, width * 0.08, width * 0.06, 0);
        const puffs = 7 + ((H(i, 5) * 5) | 0);
        for (let k = 0; k < puffs; k++) {
            const u = (k / Math.max(1, puffs - 1) - 0.5) * 2;             // -1..1 along the bank
            const crown = 1 - Math.abs(u) * 0.65;                           // taller in the middle
            const rx = width * (0.22 + H(i * 17 + k, 6) * 0.1) * (0.7 + crown * 0.4);
            const ry = Math.min(dist * 0.12, rx * (0.75 + H(i * 17 + k, 9) * 0.35) * tall * (0.65 + crown * 0.6));
            const off = u * width * 0.5 + (H(i * 17 + k, 7) - 0.5) * width * 0.06;
            const cy = baseY + ry * 0.55;
            const c: V3 = [cx + tangent[0] * off, cy, cz + tangent[2] * off];
            cloudCard(body, c, tangent, radial, rx, ry, ry * 0.8, 0);
            cloudCard(body, c, tangent, radial, rx * 0.82, ry * 0.82, ry * 0.66, 0);   // concentric core: stacked alpha steepens the edge (a painted rim, not a blur)
            // Sunlit crown: a slightly smaller card raised on the puff (drawn over the body — see buildSky).
            cloudCard(rim, [c[0], cy + ry * 0.3, c[2]], tangent, radial, rx * 0.88, ry * 0.8, ry * 0.65, -dist * 0.004);
        }
    }
    return { body, rim };
}

/** One soft cloud card: a quad facing the city centre (normal = -radial), rx wide either side along `tangent`, ryTop
 *  above and ryBot below its centre c along `up` (default world up; the high clouds tilt it to face the street), with
 *  UVs scaled so the uv centre (0.5, 0.5) sits at c and the fade ellipse is rx by ryTop (a shorter ryBot just clips the
 *  soft tail of the underside). push moves it outward along radial (behind). */
export function cloudCard(acc: Accum3D, c: V3, tangent: V3, radial: V3, rx: number, ryTop: number, ryBot: number, push: number, up: V3 = [0, 1, 0]): void {
    const o: V3 = [c[0] + radial[0] * push, c[1] + radial[1] * push, c[2] + radial[2] * push];
    const P = (x: number, y: number): V3 => [o[0] + tangent[0] * x + up[0] * y, o[1] + tangent[1] * x + up[1] * y, o[2] + tangent[2] * x + up[2] * y];
    const vb = 0.5 - 0.5 * (ryBot / ryTop);
    acc.quadUV4(P(-rx, -ryBot), P(rx, -ryBot), P(rx, ryTop), P(-rx, ryTop), [0, vb], [1, vb], [1, 1], [0, 1]);
}
