import { type FogConfig, DEFAULT_FOG_CONFIG } from '../../renderer/3d/renderer-3d';
import { type ProceduralSkyParams, DEFAULT_SKY, normalizeSkyParams } from '../../renderer/3d/procedural-sky';

/**
 * EnvironmentManager — the single owner of the scene's ENVIRONMENT (sun, ambient, fog, and — in later phases — the
 * procedural sky, cubemap reflections, and height fog). See docs/specs/environment-and-reflections.md.
 *
 * Today these live scattered + independent (directional light, a flat ambient color, and fog are each set through
 * separate renderer calls and can drift out of sync — the sky doesn't feed the ambient, the reflections are a
 * separate static image). This gathers them into ONE `EnvironmentState` so they stay coherent, round-trip as one
 * block, and give the sky→cubemap bake a natural owner. This is a decomposition of the world-manager god-object's
 * lighting/fog cluster (the eval's recommended slice), following the ManagerContext pattern.
 *
 * P0 (this phase): pure state container + normalize + serialize/restore + `applyAll` — a MIRROR of today's sun/
 * ambient/fog. The per-field renderer calls are unchanged (scene3d-manager still applies each on set), so there is
 * NO behavior or save-format change; this just establishes the owner + the shape + the apply seam. The typed `sky`/
 * `reflections`/`heightFog` fields are the P1–P3 roadmap and are INERT until those phases.
 */

export interface SunState {
  /** World-space direction the light travels (points away from the sun). */
  direction: [number, number, number];
  color: [number, number, number];
  intensity: number;
}
export interface AmbientState {
  color: [number, number, number];
  intensity: number;
}

// ── P1+ roadmap fields (typed so the shape is visible; INERT until their phase) ──────────────────────────────
/** The procedural-sky preset (P1). Owned here; the sky math + defaults live in renderer/3d/procedural-sky.ts. */
export type SkyState = ProceduralSkyParams;
export interface ReflectionsState {
  /** Screen-space reflections on (P2) — surfaces reflect the actual on-screen SCENE, composited over the cubemap. */
  ssr: boolean;
  /** SSR ray-march step count (higher = longer/more accurate reflections, costlier). */
  ssrMaxSteps: number;
  /** SSR world-space step length per march iteration (world units). */
  ssrStride: number;
  /** SSR hit tolerance — how far behind a surface a ray may pass and still count as a hit (world units). */
  ssrThickness: number;
  /** SSR contribution scale over the cubemap fallback (0 = cubemap only, 1 = full scene reflection). */
  ssrIntensity: number;
  /** SSR roughness cutoff — surfaces rougher than this skip SSR (a blurred scene reflection isn't worth the march). */
  ssrMaxRoughness: number;
  /** Prefiltered environment cubemap resolution (P1). */
  cubemapRes: number;
}
export interface HeightFogState {
  enabled: boolean;
  /** World Y where the height fog is densest. */
  y0: number;
  /** How quickly it thins with height. */
  falloff: number;
}

export interface EnvironmentState {
  sun: SunState;
  ambient: AmbientState;
  fog: FogConfig;
  // ── P1+ (see spec). `normalizeEnvironmentState` always fills these, so they're required; `sky` is live in P1,
  //    `reflections`/`heightFog` are inert until P2/P3 ──
  sky: SkyState;
  reflections: ReflectionsState;
  heightFog: HeightFogState;
}

export const DEFAULT_ENVIRONMENT: EnvironmentState = {
  sun: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 1 },
  ambient: { color: [0.3, 0.3, 0.35], intensity: 1 },
  fog: { ...DEFAULT_FOG_CONFIG },
  sky: { ...DEFAULT_SKY, zenith: [...DEFAULT_SKY.zenith], horizon: [...DEFAULT_SKY.horizon], ground: [...DEFAULT_SKY.ground], sunColor: [...DEFAULT_SKY.sunColor] },
  reflections: { ssr: false, ssrMaxSteps: 160, ssrStride: 0.08, ssrThickness: 0.15, ssrIntensity: 1, ssrMaxRoughness: 0.5, cubemapRes: 128 },
  heightFog: { enabled: false, y0: 0, falloff: 0.1 },
};

/** Coerce a possibly-partial/legacy blob into a full EnvironmentState (missing fields → today's defaults). */
export function normalizeEnvironmentState(raw?: Partial<EnvironmentState> | null): EnvironmentState {
  const d = DEFAULT_ENVIRONMENT;
  return {
    sun: {
      direction: raw?.sun?.direction ?? [...d.sun.direction],
      color: raw?.sun?.color ?? [...d.sun.color],
      intensity: raw?.sun?.intensity ?? d.sun.intensity,
    },
    ambient: {
      color: raw?.ambient?.color ?? [...d.ambient.color],
      intensity: raw?.ambient?.intensity ?? d.ambient.intensity,
    },
    fog: { ...d.fog, ...(raw?.fog ?? {}) },
    sky: normalizeSkyParams(raw?.sky),
    reflections: {
      ssr:             raw?.reflections?.ssr             ?? d.reflections.ssr,
      ssrMaxSteps:     raw?.reflections?.ssrMaxSteps     ?? d.reflections.ssrMaxSteps,
      ssrStride:       raw?.reflections?.ssrStride       ?? d.reflections.ssrStride,
      ssrThickness:    raw?.reflections?.ssrThickness    ?? d.reflections.ssrThickness,
      ssrIntensity:    raw?.reflections?.ssrIntensity    ?? d.reflections.ssrIntensity,
      ssrMaxRoughness: raw?.reflections?.ssrMaxRoughness ?? d.reflections.ssrMaxRoughness,
      cubemapRes:      raw?.reflections?.cubemapRes      ?? d.reflections.cubemapRes,
    },
    heightFog: {
      enabled: raw?.heightFog?.enabled ?? d.heightFog!.enabled,
      y0: raw?.heightFog?.y0 ?? d.heightFog!.y0,
      falloff: raw?.heightFog?.falloff ?? d.heightFog!.falloff,
    },
  };
}

/** The renderer surface EnvironmentManager pushes state to — a narrow slice so the manager stays decoupled + testable. */
export interface EnvironmentApplyTarget {
  setDirectionalLight(dx: number, dy: number, dz: number, r: number, g: number, b: number, intensity: number): void;
  setAmbientLight(r: number, g: number, b: number, intensity: number): void;
  setFog(config: FogConfig): void;
}

export class EnvironmentManager {
  private _state: EnvironmentState;

  constructor(initial?: Partial<EnvironmentState> | null) {
    this._state = normalizeEnvironmentState(initial);
  }

  get state(): EnvironmentState { return this._state; }

  // ── Record the current environment (scene3d-manager calls these; it still applies each to the renderer itself,
  //    so behavior is unchanged — this manager is the owner-of-record) ──
  recordSun(direction: [number, number, number], color: [number, number, number], intensity: number): void {
    this._state.sun = { direction: [...direction], color: [...color], intensity };
  }
  recordAmbient(color: [number, number, number], intensity: number): void {
    this._state.ambient = { color: [...color], intensity };
  }
  recordFog(fog: Partial<FogConfig>): void {
    this._state.fog = { ...this._state.fog, ...fog };
  }
  /** Patch the procedural-sky preset (P1). Merges over the current sky and re-normalizes. Does NOT itself bake/apply —
   *  the renderer-side owner (scene3d-manager) bakes this into the SH-IBL path. */
  setSky(sky: Partial<SkyState>): void {
    this._state.sky = normalizeSkyParams({ ...this._state.sky, ...sky });
  }
  /** Patch the reflections config (SSR + cubemap, P2). Does NOT itself touch the renderer. */
  setReflections(reflections: Partial<ReflectionsState>): void {
    this._state.reflections = { ...this._state.reflections, ...reflections };
  }

  /** Merge a partial state in (e.g. mirror what a restore just applied) without touching the renderer. */
  sync(partial: Partial<EnvironmentState>): void {
    this._state = normalizeEnvironmentState({ ...this._state, ...partial });
  }

  /** Push the FULL current sun/ambient/fog to the renderer. Used for controlled apply (restore / later phases) —
   *  NOT per-setter (which would risk re-pushing stale ambient/fog over the city's day/night pipeline). */
  applyAll(target: EnvironmentApplyTarget): void {
    const s = this._state;
    target.setDirectionalLight(s.sun.direction[0], s.sun.direction[1], s.sun.direction[2], s.sun.color[0], s.sun.color[1], s.sun.color[2], s.sun.intensity);
    target.setAmbientLight(s.ambient.color[0], s.ambient.color[1], s.ambient.color[2], s.ambient.intensity);
    target.setFog(s.fog);
  }

  serialize(): EnvironmentState { return normalizeEnvironmentState(this._state); }   // deep-ish copy via normalize
  restore(raw?: Partial<EnvironmentState> | null): void { this._state = normalizeEnvironmentState(raw); }
}
