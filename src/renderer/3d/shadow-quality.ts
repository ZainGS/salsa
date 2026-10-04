/**
 * SHADOW QUALITY PRESETS (engine-roadmap step 7, docs/specs/performance-plan.md P14, docs/ui/performance.md §Shadow
 * quality). One choice that sets every shadow cost knob together:
 *   - the PCF kernel of every receiving fragment (3×3 = 9 taps, 5×5 = 25: P6 measured −3.2 ms at 2.5 K for 3×3);
 *   - the cascade count (1 = the far map only; −2 ms at 2.5 K against 2), and the cascade map size;
 *   - the far map's size and its refresh throttle (a multiple of the scene's own interval).
 * 'high' is today's city default exactly (5×5, 2 cascades at 2048, far map 2048, the scene's interval).
 */

export type ShadowQualityPreset = 'low' | 'medium' | 'high' | 'ultra';
export const SHADOW_QUALITY_PRESETS: readonly ShadowQualityPreset[] = ['low', 'medium', 'high', 'ultra'];
export const DEFAULT_SHADOW_QUALITY: ShadowQualityPreset = 'high';

export interface ShadowQualitySpec {
  /** PCF kernel ('3x3' = setShadowQuality radius 1). */
  pcf: '5x5' | '3x3';
  /** Total cascades incl. the far map (ShadowCascadeSettings.cascades). */
  cascades: 1 | 2 | 3;
  /** Near cascade map size per layer. */
  cascadeMapSize: number;
  /** Near cascade refresh: every N rendered frames for the moving casters (ShadowCascadeSettings.updateInterval). */
  cascadeInterval: number;
  /** Far map size. */
  farMapSize: number;
  /** The far map's refresh interval is the scene's own (city: 3, tiled: 30) times this. */
  farIntervalScale: number;
}

const SPECS: Record<ShadowQualityPreset, ShadowQualitySpec> = {
  low:    { pcf: '3x3', cascades: 1, cascadeMapSize: 1024, cascadeInterval: 3, farMapSize: 1024, farIntervalScale: 2 },
  medium: { pcf: '3x3', cascades: 2, cascadeMapSize: 1024, cascadeInterval: 2, farMapSize: 2048, farIntervalScale: 1 },
  high:   { pcf: '5x5', cascades: 2, cascadeMapSize: 2048, cascadeInterval: 2, farMapSize: 2048, farIntervalScale: 1 },
  ultra:  { pcf: '5x5', cascades: 3, cascadeMapSize: 2048, cascadeInterval: 1, farMapSize: 4096, farIntervalScale: 1 },
};

export function isShadowQualityPreset(v: unknown): v is ShadowQualityPreset {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'ultra';
}

/** The settings of a preset (a copy); an unknown value = the default ('high'). */
export function shadowQualitySpec(q: unknown): ShadowQualitySpec {
  return { ...SPECS[isShadowQualityPreset(q) ? q : DEFAULT_SHADOW_QUALITY] };
}

/** The preset a panel shows: `q` while the PCF kernel and cascade count still match it, else 'custom' (one of them
 *  was changed on its own afterwards). */
export function shadowQualityShown(q: ShadowQualityPreset, pcf: '5x5' | '3x3', cascades: number): ShadowQualityPreset | 'custom' {
  const s = SPECS[q];
  return s.pcf === pcf && s.cascades === cascades ? q : 'custom';
}
