import { type ProceduralSkyParams } from './procedural-sky';

/**
 * Curated procedural-sky PRESETS — one-tap atmosphere (the on-brand "anime-sky" / golden-hour angle from
 * docs/specs/environment-and-reflections.md §P5). A preset is a full sky param set plus an OPTIONAL sun placement +
 * tint, so applying it sets both the dome AND the key light coherently (noon = high white sun; sunset = low red sun).
 * Pure data — the apply/bake lives in scene3d-manager (`applySkyPreset3D`). Colours are LINEAR 0..1.
 */

/** A suggested sun placement + colour that ships with a preset (drives the directional light). */
export interface SkyPresetSun {
  /** Compass angle: 0 = front (+Z), +90 = +X side, 180 = behind. */
  azimuthDeg: number;
  /** Height above horizon: 0 = level, 90 = overhead, negative = below. */
  elevationDeg: number;
  color: [number, number, number];
  intensity: number;
}

export interface SkyPreset {
  /** Human label for a picker. */
  label: string;
  sky: ProceduralSkyParams;
  /** If present, applying the preset also aims + tints the key light. */
  sun?: SkyPresetSun;
}

export const SKY_PRESETS = {
  noon: {
    label: 'Clear Noon',
    sky: { model: 'gradient', zenith: [0.14, 0.32, 0.72], horizon: [0.70, 0.78, 0.88], ground: [0.18, 0.18, 0.20], sunColor: [1.0, 0.96, 0.88], sunSizeDeg: 2.6, sunHalo: 0.3, gradientBias: 0.55, intensity: 1.0 },
    sun: { azimuthDeg: -25, elevationDeg: 66, color: [1.0, 0.98, 0.94], intensity: 1.05 },
  },
  goldenHour: {
    label: 'Golden Hour',
    sky: { model: 'gradient', zenith: [0.20, 0.30, 0.55], horizon: [0.98, 0.72, 0.42], ground: [0.16, 0.13, 0.12], sunColor: [1.0, 0.78, 0.45], sunSizeDeg: 4.0, sunHalo: 0.7, gradientBias: 0.7, intensity: 1.0 },
    sun: { azimuthDeg: -60, elevationDeg: 12, color: [1.0, 0.80, 0.55], intensity: 1.1 },
  },
  sunset: {
    label: 'Sunset',
    sky: { model: 'gradient', zenith: [0.14, 0.12, 0.34], horizon: [0.95, 0.42, 0.30], ground: [0.10, 0.08, 0.10], sunColor: [1.0, 0.55, 0.32], sunSizeDeg: 5.0, sunHalo: 0.85, gradientBias: 0.85, intensity: 0.95 },
    sun: { azimuthDeg: -80, elevationDeg: 3, color: [1.0, 0.58, 0.36], intensity: 1.0 },
  },
  overcast: {
    label: 'Overcast',
    sky: { model: 'gradient', zenith: [0.62, 0.64, 0.68], horizon: [0.74, 0.75, 0.78], ground: [0.24, 0.24, 0.26], sunColor: [0.85, 0.86, 0.88], sunSizeDeg: 8.0, sunHalo: 0.15, gradientBias: 0.4, intensity: 0.9 },
    sun: { azimuthDeg: -20, elevationDeg: 55, color: [0.86, 0.88, 0.92], intensity: 0.55 },
  },
  night: {
    label: 'Clear Night',
    sky: { model: 'gradient', zenith: [0.015, 0.03, 0.09], horizon: [0.06, 0.09, 0.16], ground: [0.01, 0.01, 0.02], sunColor: [0.7, 0.78, 0.95], sunSizeDeg: 3.5, sunHalo: 0.4, gradientBias: 0.6, intensity: 1.0 },
    sun: { azimuthDeg: 40, elevationDeg: 50, color: [0.55, 0.62, 0.85], intensity: 0.35 },   // a cool "moon" key
  },
  studio: {
    label: 'Studio Softbox',
    sky: { model: 'gradient', zenith: [0.85, 0.85, 0.88], horizon: [0.92, 0.92, 0.94], ground: [0.55, 0.55, 0.57], sunColor: [1.0, 1.0, 1.0], sunSizeDeg: 14.0, sunHalo: 0.1, gradientBias: 0.45, intensity: 1.0 },
    sun: { azimuthDeg: -30, elevationDeg: 45, color: [1.0, 1.0, 1.0], intensity: 0.9 },
  },
} satisfies Record<string, SkyPreset>;

export type SkyPresetName = keyof typeof SKY_PRESETS;

/** All preset keys (for a picker). */
export function skyPresetNames(): SkyPresetName[] {
  return Object.keys(SKY_PRESETS) as SkyPresetName[];
}
