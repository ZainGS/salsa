/**
 * FOG HORIZON (docs/specs/fog-horizon.md): the settings, the "fog eye" and the scene-uniform flags behind the silhouette
 * skyline that Hard fog edge makes possible.
 *
 * With Hard edge on and a linear fog, every pixel past the fog's Far distance is exactly the fog colour. This module
 * owns the pure pieces that build on that:
 *  - FogHorizonSettings: the user's choices (buildings only in fog, include building attachments, the fade band,
 *    its dither style, silhouette outlines). Defaults = off / today's look. Saved in the document's global scene
 *    settings, only the fields that differ from the defaults.
 *  - computeFogEye: the point the fog is measured from. Perspective = the camera position (bit-identical to the old
 *    length(cameraPosition - worldPos)). Orthographic = the EQUIVALENT-PERSPECTIVE eye, target - forward x
 *    orthoSize / tan(fov / 2): the camera position of the 2D perspective view with the same framing (the illustration
 *    sync places perspective2D exactly there), so ortho2D and perspective2D fog identically. An ortho camera's real
 *    position is an arbitrary dolly (10 units in front of the artboard in 2D ortho), meaningless for distance.
 *  - fogHorizonFlags: the bitfield the shaders read from scene.toonParams.w (float 215; it was unused).
 *  - fogHorizonEdge: the distance at which the linear fog factor reaches exactly 1 (the fast path / cull / fade edge).
 *
 * Classes of city meshes (Mesh3D.fogClass, stamped by the city from its distance tiers):
 *  0 = building shell / untiered (always kept: bodies, roofs, landmarks, roads, ground, water)
 *  1 = building attachment (signs, awnings, facade trim, rooftop equipment): kept only with includeAttachments
 *  2 = everything else (props, trees, cars, crowd, street furniture, paving): culled past Far with buildingsOnly
 */

export type FogHorizonFadeStyle = 'dither' | 'dither-coarse';

export interface FogHorizonSettings {
  /** Past the fog's Far, draw only building silhouettes: every non-building family stops at Far. */
  buildingsOnly: boolean;
  /** With buildingsOnly: keep signs, awnings, facade trim and rooftop equipment in the silhouettes too. */
  includeAttachments: boolean;
  /** Width of the dither fade band before Far, in metres (0 = the families pop at the fog line). */
  fadeM: number;
  /** The fade band's screen-door pattern: a 4x4 Bayer per pixel, or the same pattern in 2x2-pixel cells (8x8). */
  fadeStyle: FogHorizonFadeStyle;
  /** Draw the post ink outlines on fog-coloured pixels (false = outlines stop at the fog line). */
  silhouetteOutlines: boolean;
}

export const DEFAULT_FOG_HORIZON: Readonly<FogHorizonSettings> = Object.freeze({
  buildingsOnly: false, includeAttachments: false, fadeM: 15, fadeStyle: 'dither', silhouetteOutlines: true,
});

export function defaultFogHorizon(): FogHorizonSettings { return { ...DEFAULT_FOG_HORIZON }; }

/** Merge `patch` onto `base` (bad values keep the base value). fadeM is clamped to 0..500 m. */
export function sanitizeFogHorizon(patch: unknown, base: FogHorizonSettings = defaultFogHorizon()): FogHorizonSettings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<FogHorizonSettings> & { reset?: boolean };
  const out: FogHorizonSettings = p.reset ? defaultFogHorizon() : { ...base };
  if (typeof p.buildingsOnly === 'boolean') out.buildingsOnly = p.buildingsOnly;
  if (typeof p.includeAttachments === 'boolean') out.includeAttachments = p.includeAttachments;
  if (typeof p.fadeM === 'number' && Number.isFinite(p.fadeM)) out.fadeM = Math.min(500, Math.max(0, p.fadeM));
  if (p.fadeStyle === 'dither' || p.fadeStyle === 'dither-coarse') out.fadeStyle = p.fadeStyle;
  if (typeof p.silhouetteOutlines === 'boolean') out.silhouetteOutlines = p.silhouetteOutlines;
  return out;
}

/** The fields that differ from the defaults (what a document saves), or null when none do. */
export function fogHorizonDiff(s: FogHorizonSettings): Partial<FogHorizonSettings> | null {
  const d = DEFAULT_FOG_HORIZON, out: Partial<FogHorizonSettings> = {};
  if (s.buildingsOnly !== d.buildingsOnly) out.buildingsOnly = s.buildingsOnly;
  if (s.includeAttachments !== d.includeAttachments) out.includeAttachments = s.includeAttachments;
  if (s.fadeM !== d.fadeM) out.fadeM = s.fadeM;
  if (s.fadeStyle !== d.fadeStyle) out.fadeStyle = s.fadeStyle;
  if (s.silhouetteOutlines !== d.silhouetteOutlines) out.silhouetteOutlines = s.silhouetteOutlines;
  return Object.keys(out).length ? out : null;
}

/** The fog-horizon rules apply only while Hard edge is on and the fog is linear (exp fog never reaches 1). */
export function fogHorizonActive(hardEdge: boolean, fog: { mode: string }): boolean {
  return hardEdge && fog.mode === 'linear';
}

/** The distance at which the linear fog factor clamp((d - near) / max(far - near, 0.001)) reaches exactly 1. */
export function fogHorizonEdge(fog: { near: number; far: number }): number {
  return fog.near + Math.max(fog.far - fog.near, 0.001);
}

/** scene.toonParams.w bits (float 215). */
export const FOG_HORIZON_FAST = 1;        // fragments at or past the fog edge output the fog colour and return early
export const FOG_HORIZON_FADE = 2;        // the fade band is live (P2): fading meshes dissolve over fogEye.w before the edge
export const FOG_HORIZON_COARSE = 4;      // the fade dither uses 2x2-pixel cells
export const FOG_HORIZON_ATTACH = 8;      // attachments are kept (they do not fade)
export const FOG_HORIZON_HARD = 16;       // Hard fog edge is on (any fog mode): Material3D.noFog 'hardEdge' meshes skip the fog
export const FOG_HORIZON_OUTLINE_CUT = 32; // the silhouette outline cut is live (silhouetteOutlines off): the outline
                                           // pre-pass marks no-fog pixels (alpha 1) apart from the rest (alpha <= 254/255)

/** The flag word for this frame (0 = the feature is inert: every shader path is the original). `hardEdge` alone (the
 *  rules inactive, e.g. an exp fog) sets only FOG_HORIZON_HARD, which no mesh reads unless it opted into noFog. */
export function fogHorizonFlags(active: boolean, s: FogHorizonSettings, fadeUnits: number, hardEdge = active): number {
  const h = hardEdge ? FOG_HORIZON_HARD : 0;
  if (!active) return h;
  let f = FOG_HORIZON_FAST | h;
  if (s.buildingsOnly && fadeUnits > 0) f |= FOG_HORIZON_FADE;
  if (s.fadeStyle === 'dither-coarse') f |= FOG_HORIZON_COARSE;
  if (s.includeAttachments) f |= FOG_HORIZON_ATTACH;
  if (!s.silhouetteOutlines) f |= FOG_HORIZON_OUTLINE_CUT;
  return f;
}

/** Whether a mesh of fog class `cls` is culled past the fog edge under `s` (only while the feature is active). */
export function fogClassCulled(cls: number, s: FogHorizonSettings): boolean {
  return s.buildingsOnly && (cls === 2 || (cls === 1 && !s.includeAttachments));
}

type FogEyeCamera = { mode: string; position: ArrayLike<number>; target: ArrayLike<number>; orthoSize: number; fov: number };

/** The fog eye (see the header): the camera position under perspective; the equivalent-perspective eye under ortho. */
export function computeFogEye(cam: FogEyeCamera, out: Float64Array | number[] = new Float64Array(3)): Float64Array | number[] {
  const p = cam.position;
  if (cam.mode !== 'orthographic') { out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; }
  const t = cam.target;
  let fx = t[0] - p[0], fy = t[1] - p[1], fz = t[2] - p[2];
  const l = Math.hypot(fx, fy, fz);
  if (l > 1e-12) { fx /= l; fy /= l; fz /= l; } else { fx = 0; fy = 0; fz = -1; }
  const d = Math.max(0, cam.orthoSize) / Math.tan(Math.min(Math.max(cam.fov, 0.05), 3.0) / 2);
  out[0] = t[0] - fx * d; out[1] = t[1] - fy * d; out[2] = t[2] - fz * d;
  return out;
}
