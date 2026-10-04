/**
 * Material3D — Per-mesh visual properties for 3D rendering.
 *
 * Maps directly to the MeshInstance uniform in the WGSL shader:
 *   diffuseColor, specularColor, emissiveColor, shininess, flags.
 */

import { RGBA } from '../../types/rgba';

/**
 * Visual render style applied to a mesh in the fragment shader.
 *   'default'  — Cook-Torrance PBR (standard)
 *   'cel'      — toon/cel shading with stepped diffuse bands + hard specular
 *   'sketch'   — procedural crosshatch shading that makes the mesh look pencil-drawn
 *   'ink'      — flat base color with view-space silhouette rim darkening (manga ink look)
 *   'gouraud'  — per-vertex ambient+diffuse lighting (no per-pixel PBR); authentic PS1 look
 *   'unlit'    — albedo (base × texture) output directly, UNAFFECTED by scene lighting, fog, or PS1
 *                colour-depth banding; for UI cards / labels / overlays that must stay crisp day & night
 */
export type RenderStyle = 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud' | 'unlit' | 'cd';

export interface Material3D {
  /** Base color (multiplied with lighting result). */
  diffuse: RGBA;
  /** Specular highlight color. Alpha channel = shininess exponent. */
  specular: RGBA;
  /** Self-illumination color. Not affected by lighting. */
  emissive: RGBA;
  /** Specular exponent (1–256). Higher = tighter highlights. */
  shininess: number;
  /** Opacity (0–1). <1 = transparent pass. */
  opacity: number;
  /** PBR roughness (0 = mirror, 1 = fully rough). Used by Cook-Torrance BRDF. */
  roughness: number;
  /** PBR metalness (0 = dielectric, 1 = metallic). Controls Fresnel F0 and diffuse weight. */
  metalness: number;
  /** Whether this mesh has a diffuse texture bound. */
  hasTexture: boolean;
  /** Whether this mesh has a normal map bound (triggers per-pixel lighting). */
  hasNormalMap: boolean;
  /** Visual render style. Defaults to 'default' (PBR). */
  renderStyle: RenderStyle;
  /** When true, use a no-cull pipeline so both faces are always rendered. */
  doubleSided?: boolean;
  /** When true, the shader discards texels with diffuse-texture alpha < 0.5 (alpha-test cutout — alpha-card
   *  hair). Order-independent (no blending / depth sorting). Requires hasTexture. */
  alphaCutout?: boolean;
  /** When true, add an anisotropic Kajiya-Kay highlight (the lengthwise hair sheen). Intensity = specular
   *  RGB, tightness = shininess. The strand tangent is the mesh tangent (stored hair flow direction). */
  hairSheen?: boolean;
  /** When true, add a Fresnel rim/back-light glow at the silhouette (a render-style-independent modifier;
   *  tinted by the scene light, stronger backlit). The "Enable Rim Light" toggle. */
  rimEnabled?: boolean;
  /** When true, add procedural twinkling micro-glints (the metal "sparkle/glisten" effect). Light-tinted, scintillates
   *  as the camera/light move + twinkles over time. A render-style-independent modifier (PBR styles). */
  sparkleEnabled?: boolean;
  /** Like sparkleEnabled but renders bigger, sparser ANIME ✦ STAR cross-twinkles instead of fine glints. */
  sparkleStar?: boolean;
  /** When true, this surface receives NO environment-specular reflection — a hard "ignore the sky" matte override for
   *  a metal you want powder-coated/matte despite its metalness (dielectrics already skip env specular). Independent of
   *  the scene-wide reflection intensity; per-object. See docs/specs/environment-and-reflections.md (P1b). */
  noEnvReflection?: boolean;
  /** NO FOG (flags2 bits 2 / 3, docs/specs/fog-horizon.md): this object ignores the scene fog — no linear / exp fog,
   *  height fog or aerial haze, never the fog-horizon silhouette fast path, the fade band, the fog-horizon CPU cull or
   *  the silhouette outline cut. `true` = always; `'hardEdge'` = only while the scene's Hard fog edge is on (the city
   *  sky and clouds use this: under the soft fog they keep blending into the haze, under Hard edge they stay clouds
   *  instead of fog-coloured blobs past Far). Absent / false = fogged as usual. Read per MESH (mesh.material), so a
   *  multi-material mesh takes its main material's value. Set via sm.setMeshNoFog3D. */
  noFog?: boolean | 'hardEdge';
  /** CROWD PALETTE (flags2 bit 4, performance-plan P12 instanced crowd; renderer/3d/crowd-palette.ts): this mesh's vertices
   *  carry a palette CODE in uv.x, and the shaders tint diffuse + emissive by that palette colour (the crowd's one grey
   *  material replaces the baked crowd's ~25 per-colour layers). Codes >= CROWD_SLOT_BASE read a per-instance slot from
   *  `crowdSlots` / the array copy's InstanceOverride.crowdSlots. Runtime only (city crowd meshes are procedural). */
  crowdPalette?: boolean;
  /** HAIR HIGHLIGHT BAND (flags2 bit 7, visual-polish item 10): on a `hairSheen` material in Cel / Cel-HD, the sheen is
   *  one crisp flat band (the anime angel ring) instead of a soft gloss. No effect in other styles or without hairSheen.
   *  Persists with the material; procedural hair sets it from HairParams.sheenBand. */
  hairBand?: boolean;
  /** CLOTH LINING (flags2 bit 8, clothing fit round 2, 2026-10-04): a double-sided garment whose INSIDE face (the GPU's
   *  back face) is drawn as a dark lining — the inner surface of a skirt seen under the hem during a run reads as fabric
   *  in shadow instead of the outer face's lit (rim-white) colour. Needs outward (CCW) winding, which procedural garments
   *  have. Runtime only: procedural garments set it on every regenerate (Scene3DCharacter). */
  clothLining?: boolean;
  /** MATTE CHARACTER (character-level, set on the procedural BODY's material; no shader flag): the skin and every
   *  garment generated on this body get no specular (matte cel-shaded skin + cloth instead of glossy plastic highlights
   *  in Cel / Cel-HD; the hair keeps its sheen). Persists with the body; new random characters get it on.
   *  See Scene3DManager.setCharacterMatte3D / scene3d-character applyMatte. */
  matte?: boolean;
  /** The packed per-instance palette slots (crowd-palette.ts packCrowdSlots) — written to patternColor.xyz. */
  crowdSlots?: [number, number, number];
  /** P4b: this mesh is THE planar mirror — its surface samples the mirrored render pass (true reflections,
   *  back faces included). One reflector per scene (the first flagged mesh wins). See environment spec P4b. */
  planarReflector?: boolean;
  /** When true, the fragment cuts each quad into a procedural LEAF silhouette (alpha-test, order-independent) +
   *  a midrib/edge shade — turns a card into a leaf. For foliage `render:'card'`. Needs unit-square UVs per quad. */
  leafCard?: boolean;
  /** When true, this surface is GLASS — gets a stylized fresnel sky-reflection when the global glass-quality toggle
   *  is on (scene.ps1Config2.w). Marks which surfaces are glass; the toggle gates the effect. Enhanced-visuals pass. */
  glassEnhance?: boolean;
  /** Diffuse/normal TEXTURE UV tiling — [repeatX, repeatY] multiplied into the sample UV (wrap sampler → the
   *  image repeats). Default [1,1] = map once across the mesh's UVs. Bigger = the texture repeats more (smaller
   *  features). Applies ONLY to the sampled image texture, not the procedural pattern/ground families. Persisted;
   *  packed into instance floats 56-57. */
  textureTiling?: [number, number];
  /** Diffuse/normal TEXTURE UV offset — [offsetX, offsetY] ADDED to the sample UV after tiling (pans the image).
   *  Default [0,0]. Persisted; packed into instance floats 58-59. */
  textureOffset?: [number, number];
  /** SOFT (wrapped / half-Lambert) diffuse lighting (bit 28): the diffuse NdotL is remapped so the away-from-light
   *  side lifts to a mid-tone instead of going dark — the standard flat anime-face/skin look, removing the hard
   *  "dark triangle" that plain Lambert produces on a face's 3-D form. The AMOUNT is the scene-global strength
   *  `setSoftLightingStrength3D` (0 = normal Lambert, 1 = full half-Lambert), so this flag just marks WHICH
   *  materials opt in (default: the procedural body skin). Zero effect when strength is 0 or the flag is off. */
  softLighting?: boolean;
  /** SKIN TOON-RAMP (bit 29): quantise the diffuse NdotL into discrete BANDS with a controllable terminator +
   *  a warm shadow tint — the crisp lit/shadow split that reads as painted anime/Pokémon skin. Applied AFTER the
   *  softLighting half-Lambert (they stack: soften, then band). The band count / softness / shadow-floor / tint are
   *  a scene-GLOBAL look (`setSkinRampSettings3D`), like softLightStrength — this flag only marks WHICH materials
   *  opt in (default: none; the procedural body skin can be opted in via `setSkinShadingMode3D`). Zero effect when
   *  the flag is off — bit-identical to plain (soft-)Lambert. Only touches the vertex-Gouraud diffuse term
   *  (specular/rim/sheen untouched); the PBR fragment path is unaffected. See
   *  docs/specs/character-shading-toon-and-parallax-eyes.md (Part A). */
  skinRamp?: boolean;
  /** TOON SHADOWS (bit 30) — in the Cel / Cel-HD styles, replace the fixed 3-band shade with the scene's toon ramp:
   *  adjustable bands + a COLOURED shadow (the diffuse colour × a shadow tint, a touch more saturated — the anime
   *  "multiply a purple layer" shadow) instead of just darker. The look is scene-global (`setToonShadows3D`); this
   *  flag opts a material in. No effect in other styles; off = Cel exactly as before.
   *  (A `skinRamp` material in Cel uses the same per-pixel path with the SKIN ramp's settings.)
   *  docs/specs/film-look-and-toon-shadows.md §B. */
  toonShadow?: boolean;
  /** RETRO COLOUR opt-in (bit 31): this mesh gets the PS1 colour-depth quantization + dither even when the scene's
   *  `PS1Config.colorScope` is 'optIn' (e.g. only the characters banded, the environment full colour). No effect in
   *  scope 'all' (everything is quantized, the original behaviour). */
  retroColor?: boolean;
  /** WORLD-SPACE TRIPLANAR projection for the diffuse texture (bit 27): sample the image on 3 axis-aligned world
   *  planes and blend by the surface normal, so texel density stays constant however the mesh is scaled — the fix
   *  for a texture looking "squashed" on a non-uniformly-scaled/stretched mesh (no per-face UV needed). When on,
   *  `textureTiling.x` becomes TILES PER WORLD UNIT (frequency) and `textureOffset` a world offset. v1: diffuse
   *  only (the normal map + GARP atlas keep UV sampling). Costs 3 extra diffuse samples per textured fragment. */
  worldTriplanar?: boolean;
  /** Procedural geometric pattern over the albedo (analytic, antialiased in-shader). `diffuse` = primary colour,
   *  `patternColor` = secondary. Render-style-independent (modifies the base colour).
   *  'windows' = hash-LIT window cells (patternSpacing = lit fraction; lit cells also glow per-texel).
   *  'waves' = animated drifting bands over scene time (patternSpacing = scroll speed; bands carry the emissive). */
  patternMode?: 'none' | 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid' | 'windows' | 'waves';
  /** Pattern secondary colour (primary = `diffuse`). */
  patternColor?: RGBA;
  /** Pattern repeats across UV 0..1. */
  patternFreq?: number;
  /** Pattern rotation (radians) applied to the UV before the pattern. */
  patternAngle?: number;
  /** Stripe width / dot radius / line thickness, 0..1 of a cell. */
  patternScale?: number;
  /** Per-pattern extra (dot gap / second-axis frequency). */
  patternSpacing?: number;
  /** 'windows' pattern only (visual-polish #8): multiplier on the LIT glass glow (lit cells + shop windows). Packed in
   *  patternColor.a; absent / 0 = the built glow (1x). Set by the city look (CityLook.windowGlow). */
  windowGlow?: number;
  /** When true, the diffuse texture is composited OVER the base diffuse colour by its alpha
   *  (albedo = mix(diffuse, tex.rgb, tex.a)) instead of multiplying — the decal-over-base mode.
   *  A transparent texel shows the base material; painted strokes sit on top of it. Used by the
   *  packaging dieline (transparent layer over kraft cardboard). Requires hasTexture; the surface
   *  stays opaque (texture alpha never cuts the mesh — unlike alphaCutout). */
  texOverBase?: boolean;
  /** When true, the surface reads as PAPERBOARD (packaging §4.2): a faint paper-fiber grain on the
   *  BASE colour (applied UNDER the texOverBase artwork composite — the grain is the board, not the
   *  ink) + a subtle darkened rim toward the panel's UV-rect borders so panels read as thick board.
   *  ⚠ Rides the pattern instance slots (patternColor/patternParams), so it is MUTUALLY EXCLUSIVE
   *  with patternMode on the same mesh — packaging panels never use patterns. */
  boardShade?: boolean;
  /** boardShade: grain amplitude 0..1 (white coated ≈ 0.06, kraft ≈ 0.16). */
  boardGrain?: number;
  /** boardShade: edge-rim darkening strength 0..1 at the very panel border. */
  boardRimStrength?: number;
  /** boardShade: this panel's axis-aligned bounds in the dieline texture UV — [u0, v0, u1, v1]. */
  boardUVRect?: [number, number, number, number];
  /** boardShade: rim width in dieline-UV units per axis (≈1.6 mm / net mm extent). */
  boardRimUV?: [number, number];
  /** When true (transparent pass), multiply alpha by a soft radial falloff from UV centre — the
   *  packaging stage CONTACT-SHADOW blob (a dark ground quad whose edges fade to nothing). */
  radialFade?: boolean;
  /** When true, the surface reads as PROCEDURAL GROUND (procedural-ground §2, P1 = ashlar limestone):
   *  a shader-generated stone-paver floor — per-tile jittered base tint + macro cloud + micro grain +
   *  recessed grout seams + polished edge wear, with a height→normal relief and per-tile roughness.
   *  Like boardShade it RIDES the pattern instance slots, so it is MUTUALLY EXCLUSIVE with patternMode /
   *  boardShade / texOverBase on the same mesh — a mesh is EITHER a ground tile OR a package panel OR a
   *  patterned surface. `diffuse.rgb` = base stone tint. */
  groundShade?: boolean;
  /** groundShade: grout seam colour (rgb); the ALPHA channel carries grout width in METRES. The shader
   *  recovers world-metres-per-uv from fragment derivatives (gr_uvMetres), so this is a physical width
   *  that stays equal on both axes regardless of the mesh's uv scale or non-uniform transform. */
  groundGrout?: RGBA;
  /** groundShade: paver tile size in METRES, [tileW, tileH] (default 0.9 × 0.6 — landscape ashlar). */
  groundTile?: [number, number];
  /** groundShade: METRES PER WORLD UNIT for a mesh that is part of a scaled world. Omit (or 0) for a
   *  standalone mesh authored 1 unit = 1 m whose uv is a 0..1 region — that is the default.
   *
   *  ★ Two problems, one number. The city is a DIORAMA: `streets.ts` defines a building floor as
   *  0.2 units and CITY_FLOOR_M = 3, i.e. **1 world unit = 15 metres**. The shader derives world
   *  UNITS per uv from fragment derivatives, so without this every tile size and every noise frequency
   *  was 15× too large — a 900 mm paver came out 13.5 m, a 150 mm cobble 2.25 m. Setting this scales the
   *  shader's metric coordinate so tiles and grain are physically right at any world scale.
   *
   *  It ALSO marks the uv as a world parameterisation (the city uses uv = worldXZ * 0.5 so adjacent road /
   *  pavement / plaza meshes tile continuously). The P2 weathering masks assume a 0..1 region:
   *  `gr_edgeMask` would compute a hugely negative border distance, saturate to 1 across the ENTIRE city
   *  and darken + corner-chip everything. A non-zero scale switches the masks to a world-scaled coordinate
   *  and drops the edge/corner term — a continuous ground has no region border.
   *
   *  Packed into the `groundMode` slot as `mode + 100 * round(scale * 10)`; there is no free instance
   *  float left. Decoded in the WGSL groundShade branch. */
  groundWorldScale?: number;
  /** groundShade: per-tile jitter amount 0..1 (scales the brightness/hue/sat variation between stones). */
  groundJitter?: number;
  /** groundShade: tiler/surface sub-selector — 0 = ashlar (running-bond rectangular pavers, P1) ·
   *  1 = radialMedallion (concentric rings × radial wedges, P3) · 2 = borderStrip (long linear pavers, P3) ·
   *  3 = grass (P4, tiler none: layered noise + dirt-path blend). For radial, `groundTile` = [ringSpacing, wedgeCount];
   *  for borderStrip, `groundTile` = [stoneLength, rowWidth]; for grass, `groundTile` is unused. */
  groundMode?: number;
  /** groundShade P4 (procedural-ground §9): DIRT colour rgb (0..1) the grass surface blends toward across the
   *  wear band (bare worn path). Packed into the repurposed grout slot (patternColor.rgb) for grass mode only —
   *  grass has no grout, so the seam slot is free. Stored on the material for API + round-trip. */
  groundDirtTint?: [number, number, number];
  /** groundShade P2 (procedural-ground §5): WEATHERING PROFILE selector — 0=new · 1=worn (default) · 2=ancient ·
   *  3=mossy · 4=dirty. One knob scales the four usage-biased masks (edge/wear/moss/dirt). Packed into the
   *  repurposed `specular.r` slot (ground meshes are dielectric, metalness 0 — specular is free). */
  groundWeather?: number;
  /** groundShade P2: optional WEAR input as a uv-space center + radius, [cx, cy, radiusUv]. Carves a
   *  brighter/smoother worn TRACK so the effect is demonstrable now; the world graph feeds real path
   *  distance here later. radius 0 (or undefined) = noise-only wear. Packed into `specular.g/b/a`. */
  groundWearPath?: [number, number, number];
  /** groundShade P2: per-mask STRENGTH knobs 0..~2 (edge/wear/moss/dirt). Stored for API + round-trip;
   *  the shader currently derives the effective weights from the profile (gr_profile), so these are
   *  first-guess tuning values — a CPU-side per-mask override is future work (§5). */
  groundEdge?: number;
  groundWear?: number;
  groundMoss?: number;
  groundDirt?: number;
  // ── WATER (bit 21) ───────────────────────────────────────────────────────────────────────────────
  /** When true, the surface reads as WATER: a ripple NORMAL summed from four rotated sine octaves plus a
   *  fine chop, Fresnel reflection toward the scene's fog/sky colour, and a tight specular lobe off that
   *  normal (the sun glitter). Replaces the old `waves` pattern motif, which animated the ALBEDO only —
   *  scrolling bands painted on a flat surface, which can never shimmer because nothing touched the
   *  normal. ⚠ Rides the pattern instance slots, so it is MUTUALLY EXCLUSIVE with patternMode /
   *  boardShade / groundShade / foliage shading on the same mesh. */
  waterShade?: boolean;
  /** waterShade: the deep-body colour (looking straight down). `diffuse` is unused for water. */
  waterDeep?: [number, number, number];
  /** waterShade: the crest / shallow colour mixed in at wave tops. */
  waterShallow?: [number, number, number];
  /** waterShade: swell frequency in CYCLES PER WORLD UNIT. Must suit the world's scale — the city is a
   *  diorama at 1 unit = 15 m, so a ~1.5 m swell is ~10 here; a 1:1 pond wants well under 1. */
  waterWaveScale?: number;
  /** waterShade: animation rate. */
  waterWaveSpeed?: number;
  /** waterShade: how hard the ripple normal tilts, 0 = glass. */
  waterChoppy?: number;
  /** waterShade: sun-glitter intensity. */
  waterGlitter?: number;
  // ── NEON / SCREEN SIGN (bit 22) ──────────────────────────────────────────────────────────────────
  /** When true, the surface reads as a LIT SIGN: drifting scanlines, a per-sign flicker with occasional
   *  dropout, a centre-bright diffuser falloff and an accent rim. Replaces the old `waves` pattern motif,
   *  which scrolled a band across the albedo and relied on a high emissive to be seen — a painted
   *  animation, the same failure the water had. This drives the EMISSIVE term instead.
   *  ⚠ Rides the pattern instance slots — exclusive with pattern / board / ground / foliage / water. */
  neonShade?: boolean;
  /** neonShade: the panel's glow colour. */
  neonGlow?: [number, number, number];
  /** neonShade: rim/border accent colour. */
  neonAccent?: [number, number, number];
  /** neonShade: scanlines across the panel height. */
  neonScanDensity?: number;
  /** neonShade: flicker depth 0..1. 0 = a steady panel, ~0.3 = a tired tube. */
  neonFlicker?: number;
  /** neonShade: scanline drift rate. */
  neonScroll?: number;
  /** neonShade: per-sign phase 0..1 — MUST differ per sign or the whole street flickers in unison. */
  neonPhase?: number;
  // ── PAINTED METAL (bit 23) ───────────────────────────────────────────────────────────────────────
  /** When true, the surface reads as PAINTED METAL: per-object tone, rain streaks down near-vertical
   *  faces, grime collecting on upward faces, and a micro roughness break-up. Covers the city's largest
   *  remaining flat mass — rooftop plant, railings, poles, signal housings, guardrails.
   *  ⚠ Rides the pattern instance slots — exclusive with pattern / board / ground / foliage / water / neon. */
  metalShade?: boolean;
  /** metalShade: the paint colour. */
  metalTint?: [number, number, number];
  /** metalShade: streak + grime colour (the dark wash that runs down it). */
  metalStreak?: [number, number, number];
  /** metalShade: base roughness. Fresh enamel ~0.35, weathered galvanised ~0.7. */
  metalRoughness?: number;
  /** metalShade: rain-streak strength 0..1 (near-vertical faces only). */
  metalStreakAmount?: number;
  /** metalShade: grime on upward faces 0..1. */
  metalGrime?: number;
  /** metalShade: detail frequency in CYCLES PER WORLD UNIT — must suit the world's scale. */
  metalScale?: number;
  /** groundShade P2: moss tint rgb (0..1) for the moisture mask. Stored for API + round-trip; the shader
   *  uses a constant moss green for now (no free float slot) — an override is future work. */
  groundMossTint?: [number, number, number];

  /** garpTex (bit 24) — sample the DEDICATED GARP pool atlas at this mesh's `textureIndex` instead of the
   *  diffuse atlas (docs/specs/city-props-garp.md §2). Set on the SOURCE mesh of a GARP arrayGroup; each
   *  instance's per-instance `textureIndex` (InstanceOverride) then picks its skin's atlas layer. Composes
   *  freely with hasTexture — it only redirects WHICH texture_2d_array the diffuse sample reads from. */
  garpTex?: boolean;

  // ── FOLIAGE shading + motion (foliage-quality.md §2 — the SHARED layer, phases S1/S2) ────────────
  /** S1 — WIND (bit 19). Height-graded vertex sway in the VERTEX stage: displacement ∝
   *  `pow(clamp(localY / windHeight, 0, 1), windStiffness)`, so the BASE STAYS PLANTED and only the tip
   *  travels. Applied in LOCAL space before the model transform, so every instanced copy bends from its own
   *  base. Two bands (slow sway + fast ripple) plus travelling GUSTS across the world, with a per-instance
   *  phase hashed from the model matrix's world translation (a field never pulses in unison — no extra
   *  per-instance data needed). Scene-level direction/strength/speed live in the scene uniform
   *  (Renderer3D.setSceneWind / ShapeManager.setSceneWind3D).
   *  ⚠ Rides the pattern instance slots (patternColor/patternParams) exactly like boardShade/groundShade,
   *  so wind/foliage shading is MUTUALLY EXCLUSIVE with patternMode / boardShade / groundShade per mesh. */
  windSway?: boolean;
  /** windSway: bend exponent — grass floppy ≈1.2, hedge stiff ≈3. Higher = more of the plant stays rigid. */
  windStiffness?: number;
  /** windSway: the plant's LOCAL height (metres/local units) — the grading denominator. */
  windHeight?: number;
  /** windSway: per-material sway scale (0 = none; trunks/vessels ≈0.05–0.15, blades ≈1). */
  windAmount?: number;
  /** S2 — TRANSLUCENCY + GROUND BLEND + BASE AO (bit 20). The anime cue: light *through* the leaf
   *  (`max(0, dot(-N, L))` + a view-dependent wrap) tinted by `translucencyColor`, ADDED on top of the lit
   *  result so it COMPOSES with the existing rim (bit 8) instead of fighting it; plus a base-AO darkening
   *  and a ground-colour bleed over the lowest ~15% of the plant (same localY ramp as the wind grading,
   *  so it needs `windHeight` too). Rides the same repurposed pattern slots as windSway. */
  foliageShade?: boolean;
  /** foliageShade: transmission strength 0..1 (thin leaf cards/blades high, trunks/vessels 0). */
  translucency?: number;
  /** foliageShade: transmission tint — lighter / more saturated than the diffuse (the backlit glow colour). */
  translucencyColor?: [number, number, number];
  /** foliageShade: how strongly the ground colour bleeds into the plant's base 0..1 (stops cards floating). */
  groundBlend?: number;
  /** foliageShade: the ground colour blended in at the base (rgb 0..1). */
  groundTint?: [number, number, number];
  /** foliageShade: base ambient-occlusion darkening 0..1 over the lowest ~15% of the plant. */
  baseAOAmount?: number;
}

// ── Scene WIND (foliage-quality.md §2.1) ─────────────────────────────────────────────────────────
/** Scene-level wind — shared by every `windSway` material (and any future cloth/flags/hair). */
export interface SceneWind3D {
  /** Wind heading in DEGREES over the world XZ plane (0 = +X, 90 = +Z). */
  dirDeg: number;
  /** Tip travel in local units at windAmount 1 (0 = dead calm). */
  strength: number;
  /** Time multiplier — how fast the sway/ripple/gust cycles run. */
  speed: number;
}

/** A gentle breeze out of the box (vegetation must never read as plastic-still). */
export const DEFAULT_SCENE_WIND: SceneWind3D = { dirDeg: 35, strength: 0.06, speed: 1 };

// ── SKIN TOON-RAMP (character-shading spec Part A) ──────────────────────────────────────────────
/** Scene-level skin toon-ramp look — shared by every `skinRamp` material (the anime "house style"). Like
 *  {@link SceneWind3D} it rides scene-uniform slots (skinRampParams, floats 204-207), so no per-mesh cost. */
export interface SkinRampSettings {
  /** Number of diffuse tone BANDS (≥1). 2 = one terminator (the anime default); 3 = a subtle mid-tone. */
  bands: number;
  /** Terminator half-width in NdotL units, 0..1. ~0 = razor cel edge, higher = painterly. */
  softness: number;
  /** Darkest-band lift 0..1 — keeps the shadow a TONE, not black (so it reads as skin, not ambient). */
  shadowFloor: number;
  /** Warm shadow-band tint multiplier (rgb 0..1); mixes toward white as the surface faces the light.
   *  (1,1,1) = neutral (no warming). Anime skin shadows lean red/mauve. */
  shadowTint: [number, number, number];
}

/** A clean 2-band skin ramp with a soft terminator and a faint warm shadow — the SV/ZA-ish default, ready
 *  for when a character is opted in (materials without the skinRamp flag ignore it entirely). */
export const DEFAULT_SKIN_RAMP: SkinRampSettings = {
  bands: 2, softness: 0.08, shadowFloor: 0.4, shadowTint: [0.82, 0.66, 0.68],
};

/** Merge a partial ramp patch over the current settings, clamping to sane ranges. Pure — the renderer and the
 *  `setSkinRampSettings3D` API funnel through this so the getter always reports what the shader will see. */
export function resolveSkinRamp(cur: SkinRampSettings, patch: Partial<SkinRampSettings> = {}): SkinRampSettings {
  const num = (v: number | undefined, fallback: number): number => (typeof v === 'number' && isFinite(v) ? v : fallback);
  const cl = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const t = patch.shadowTint ?? cur.shadowTint;
  return {
    bands: cl(Math.round(num(patch.bands, cur.bands)), 1, 8),
    softness: cl(num(patch.softness, cur.softness), 0, 1),
    shadowFloor: cl(num(patch.shadowFloor, cur.shadowFloor), 0, 1),
    shadowTint: [cl(num(t[0], cur.shadowTint[0]), 0, 1), cl(num(t[1], cur.shadowTint[1]), 0, 1), cl(num(t[2], cur.shadowTint[2]), 0, 1)],
  };
}

// ── TOON SHADOWS + RIM LIGHT (film-look-and-toon-shadows.md §B/§C) ────────────────────────────────
/** Scene-level toon-shadow look for every `toonShadow` material in the Cel styles. */
export interface ToonShadowSettings {
  /** Tone bands (1–4). 2 = one hard terminator (the anime default). */
  bands: number;
  /** Terminator softness 0..0.5 (0 = razor edge). */
  softness: number;
  /** How bright the shadow tone is, 0..1 (1 = as bright as the lit side — the tint alone makes the shadow). */
  shadowValue: number;
  /** Shadow colour multiplier (rgb 0..1). A cool lavender makes warm colours go red-purple and cool ones deep blue,
   *  like an anime multiply shadow. (1,1,1) = plain darker shadows. */
  shadowTint: [number, number, number];
  /** Extra saturation in the shadow, 0..1 (anime shadows are richer, not greyer). */
  saturation: number;
}
export const DEFAULT_TOON_SHADOWS: ToonShadowSettings = {
  bands: 2, softness: 0.04, shadowValue: 0.62, shadowTint: [0.74, 0.68, 0.96], saturation: 0.25,
};
/** Scene-level RIM light for `rimEnabled` materials. strength 0 = the original fixed rim (unchanged). */
export interface RimLightSettings {
  /** 0 = the original built-in rim; > 0 = this parameterised rim at that strength (0..2). */
  strength: number;
  /** How far the rim reaches in from the silhouette, 0..1 (small = a thin edge line). */
  width: number;
  /** 0 = soft Fresnel falloff, 1 = a crisp toon edge. */
  hardness: number;
  /** Rim colour (rgb 0..1). */
  color: [number, number, number];
}
export const DEFAULT_RIM_LIGHT: RimLightSettings = { strength: 0, width: 0.25, hardness: 0.85, color: [0.75, 0.92, 1.0] };

const _num = (v: number | undefined, fallback: number): number => (typeof v === 'number' && isFinite(v) ? v : fallback);
const _cl = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const _rgb = (t: readonly number[] | undefined, cur: readonly number[]): [number, number, number] =>
    [0, 1, 2].map((i) => _cl(_num(t?.[i], cur[i]), 0, 1)) as [number, number, number];
/** Merge + clamp a toon-shadow patch (pure; the getter reports what the shader sees). */
export function resolveToonShadows(cur: ToonShadowSettings, patch: Partial<ToonShadowSettings> = {}): ToonShadowSettings {
  return {
    bands: _cl(Math.round(_num(patch.bands, cur.bands)), 1, 4),
    softness: _cl(_num(patch.softness, cur.softness), 0, 0.5),
    shadowValue: _cl(_num(patch.shadowValue, cur.shadowValue), 0, 1),
    shadowTint: _rgb(patch.shadowTint, cur.shadowTint),
    saturation: _cl(_num(patch.saturation, cur.saturation), 0, 1),
  };
}
/** Merge + clamp a rim-light patch (pure). */
export function resolveRimLight(cur: RimLightSettings, patch: Partial<RimLightSettings> = {}): RimLightSettings {
  return {
    strength: _cl(_num(patch.strength, cur.strength), 0, 2),
    width: _cl(_num(patch.width, cur.width), 0.02, 1),
    hardness: _cl(_num(patch.hardness, cur.hardness), 0, 1),
    color: _rgb(patch.color, cur.color),
  };
}

/** Merge a partial wind patch over the current wind, clamping to sane ranges. Pure — the renderer and the
 *  `setSceneWind3D` API both funnel through this so the getter always reports what the shader will see. */
export function resolveSceneWind(cur: SceneWind3D, patch: Partial<SceneWind3D> = {}): SceneWind3D {
  const num = (v: number | undefined, fallback: number): number => (typeof v === 'number' && isFinite(v) ? v : fallback);
  const dir = num(patch.dirDeg, cur.dirDeg);
  return {
    dirDeg: ((dir % 360) + 360) % 360,
    strength: Math.max(0, num(patch.strength, cur.strength)),
    speed: Math.max(0, num(patch.speed, cur.speed)),
  };
}

/** Pack an rgb triple (0..1) into ONE float as 8:8:8 (r*65536 + g*256 + b, all integers ≤ 2^24 so f32 is
 *  exact). The foliage material needs TWO colours (translucency + ground tint) plus six scalars but only has
 *  the two repurposed pattern vec4s (8 floats) — packing the colours makes it fit. The WGSL side unpacks
 *  with `fq_unpackRGB` in mesh3d-shaders.ts; keep the two in sync. */
export function packRGB8(c: readonly [number, number, number]): number {
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return q(c[0]) * 65536 + q(c[1]) * 256 + q(c[2]);
}

/** Inverse of {@link packRGB8} (quantized to 1/255) — used by tests + tooling to verify the shader decode. */
export function unpackRGB8(v: number): [number, number, number] {
  const p = Math.max(0, Math.round(v)) | 0;
  return [((p >> 16) & 255) / 255, ((p >> 8) & 255) / 255, (p & 255) / 255];
}

export const DEFAULT_MATERIAL: Material3D = {
  diffuse: { r: 0.8, g: 0.8, b: 0.8, a: 1 },
  specular: { r: 0.3, g: 0.3, b: 0.3, a: 1 },
  emissive: { r: 0, g: 0, b: 0, a: 0 },
  shininess: 16,
  opacity: 1,
  roughness: 0.5,
  metalness: 0.0,
  hasTexture: false,
  hasNormalMap: false,
  renderStyle: 'default',
};

/**
 * Encode material flags for the shader's emissiveColor.a field.
 * bit 0:    hasTexture
 * bit 1:    hasNormalMap (triggers per-pixel normal mapping)
 * bits 2-4: renderStyle  (0=default PBR, 1=cel, 2=sketch, 3=ink, 4=gouraud, 5=cel-hd, 6=unlit)
 * bit 5:    alphaCutout  (discard diffuse-texture alpha < 0.5 — alpha-card hair)
 * bit 6:    hairSheen    (anisotropic Kajiya-Kay highlight along the strands)
 * bit 7:    rimEnabled   (Fresnel rim / back-light silhouette glow)
 * bit 8:    sparkleEnabled (procedural twinkling micro-glints)
 * bits 9-11: patternMode  (0 none · 1 stripes · 2 dots · 3 diamonds · 4 checker · 5 grid · 6 windows · 7 waves)
 * bit 12:   sparkleStar  (anime ✦ star twinkles instead of fine glints)
 * bit 13:   leafCard     (procedural leaf-silhouette alpha cutout on a quad — foliage cards)
 * bit 14:   glassEnhance (stylized fresnel sky-reflection glass — gated by the global glass-quality toggle)
 * bit 15:   texOverBase  (diffuse texture composited OVER the base colour by tex alpha — decal-over-base;
 *                         the packaging dieline-over-kraft blend)
 * bit 16:   boardShade   (paperboard read: base fiber grain + panel-border rim darkening; repurposes the
 *                         pattern instance slots — see Material3D.boardShade)
 * bit 17:   radialFade   (soft radial alpha falloff from UV centre — the packaging contact-shadow blob)
 * bit 18:   groundShade  (procedural ashlar-limestone ground: per-tile stone + grout + relief + roughness,
 *                         + P2 usage-biased weathering masks/profiles; repurposes the pattern instance slots
 *                         AND specularColor (dielectric ground) — see Material3D.groundShade / groundWeather)
 * bit 19:   windSway     (foliage-quality S1 — height-graded VERTEX wind: two-band sway + travelling gusts,
 *                         per-instance phase from the model matrix translation; repurposes the pattern slots)
 * bit 20:   foliageShade (foliage-quality S2 — leaf TRANSLUCENCY/transmission + base AO + ground-colour
 *                         bleed at the plant's base; shares the same repurposed pattern slots as bit 19)
 * bit 21:   waterShade   (ripple-normal water: summed sine octaves + fine chop, Fresnel toward the scene
 *                         fog/sky colour, tight specular sun glitter; repurposes the pattern slots)
 * bit 22:   neonShade    (lit sign: drifting scanlines + per-sign flicker/dropout + diffuser falloff +
 *                         accent rim, driving the EMISSIVE term; repurposes the pattern slots)
 * bit 23:   metalShade   (painted metal: per-object tone, rain streaks on vertical faces, grime on
 *                         upward faces, micro roughness break-up; repurposes the pattern slots)
 * bit 24:   garpTex      (sample the DEDICATED GARP pool atlas at textureIndex instead of the diffuse atlas —
 *                         docs/specs/city-props-garp.md §2; composes with hasTexture)
 * bit 25:   noEnvReflection (skip environment-specular IBL for this object — a per-object matte "ignore the sky"
 *                         override; see Material3D.noEnvReflection)
 * bit 26:   planarReflector (this mesh IS the planar mirror — its reflection comes from the mirrored render
 *                         pass sampled at the fragment's own screen uv; see Material3D.planarReflector)
 * bit 27:   worldTriplanar (sample the diffuse via world-space triplanar projection instead of UVs — constant
 *                         texel density regardless of scale; see Material3D.worldTriplanar)
 * bit 28:   softLighting (wrapped/half-Lambert diffuse — flat anime skin; amount = scene.lightColor.w; see
 *                         Material3D.softLighting)
 * bit 29:   skinRamp     (toon-ramp the (soft-)Lambert diffuse into bands + warm shadow tint; params =
 *                         scene.skinRampParams; applied after softLighting; see Material3D.skinRamp)
 * NOTE: flags travel as a raw u32 (setUint32 → bitcast<u32> in WGSL), NOT as an f32 value, so all 32 bits are usable
 * (the earlier "2^24 = last exact-f32 bit" caution only applied to a value stored through the f32 field directly).
 */
/**
 * SECOND PER-OBJECT FLAGS WORD ("flags2", 2026-10-01, fog horizon P2). All 32 bits of the word above are taken, so
 * further per-object switches go HERE: the MeshInstance normalMatrix's column 3 .x (instance float 28; WGSL
 * u32(inst.normalMatrix[3].x)).
 *  - Why that lane is free: normalMatrix is the 4x4 inverse-transpose of the model matrix, and every shader multiplies
 *    it by vec4(normal or tangent, 0.0) and keeps .xyz (mesh3d / vertex-colour / skinned VS, shadow-receive VS, SSAO
 *    + outline prepasses; the CD disc reads column 2 only). Column 3 is therefore multiplied by 0 and never reaches a
 *    result; it holds 0 for an affine model matrix (billboards write 0 too), so the old output is bit-identical.
 *  - Stored as a small INTEGER-valued f32 (exact to 2^24), NOT a bitcast: the lane is multiplied by 0, and a bitcast
 *    bit pattern can be NaN / Inf (0 x NaN = NaN would poison every normal). Read it with u32(...).
 *  - Written by Renderer3D for every mesh slot (_writeGroundUvScale, which every slot writer calls after the
 *    matrices; array-group copies inherit their source's value; skinned slots too). It is derived from the mesh
 *    (encodeMeshFlags2), so a change must mark the mesh materialDirty (the slot rewrite that re-derives it).
 * Bits:
 *  bit 0: distanceFade        (fog horizon: dissolve over the fade band before the fog's Far; Mesh3D.fogClass 2)
 *  bit 1: distanceFadeAttach  (the same, but only while attachments are excluded from the silhouette; fogClass 1)
 *  bit 2: noFog               (Material3D.noFog === true: no fog of any kind, no fog-horizon fast path / outline cut)
 *  bit 3: noFogHardEdge       (Material3D.noFog === 'hardEdge': the same, only while the scene flag FOG_HORIZON_HARD
 *                              (fog-horizon.ts, scene.toonParams.w bit 4) says Hard edge is on)
 *         A no-fog mesh never carries bits 0 / 1 (it does not fade; the CPU fog cull skips it too: fogCullClass).
 *         Skinned characters carry bit 0 too, set per frame by the skinned instance upload (Renderer3D._skFogFade:
 *         every skinned part except no-fog ones, the active Play player and the selection) instead of from fogClass.
 *  bit 4: crowdPalette        (Material3D.crowdPalette: the per-vertex palette tint, crowd-palette.ts; performance-plan P12)
 *  bit 5: hlodFade            (performance-plan P17: a streamed HLOD tile dissolving in / out over its tier swap. The
 *                              coverage 0..1 rides in normalMatrix column 3 .y (instance float 29, the same 0-times lane);
 *                              a pixel draws while the coverage beats its 4x4 Bayer threshold, as the fog fade band does.
 *                              Mesh3D.hlodFade >= 0 sets it; -1 = not fading. The shadow pass (fs_shadow, shadow-map
 *                              texels; a fading caster is a dynamic caster) and the AO / SSR prepasses (prepassFadeKeep)
 *                              dither with the same coverage; the outline normal prepass scales its ink by it.)
 *  bit 6: faceDepthPull       (face kit, face-features.ts: Mesh3D.faceDepthPull > 0. The SKINNED VS moves the vertex
 *                              toward the camera along its view ray by that many local units, scaled by the skin
 *                              matrix — same screen position, nearer depth — so the brow overlay draws through the
 *                              hair fringe just in front of it. The amount rides in normalMatrix column 3 .z
 *                              (instance float 30, the same 0-times lane).)
 *  bit 7: hairBand            (visual-polish item 10: Material3D.hairBand on a hairSheen material. In Cel / Cel-HD the
 *                              Kajiya-Kay sheen is thresholded into one crisp flat highlight band — the anime angel
 *                              ring — instead of a soft gloss. Other styles: unchanged. No extra lane.)
 *  bit 8: clothLining         (clothing fit round 2: Material3D.clothLining. A back-facing fragment of the garment is
 *                              drawn dark (the lining) in both mesh fragment shaders. No extra lane.)
 *  bits 9..23: free (next: parallax eyes). Keep values below 2^24.
 * Column 3 lanes (all multiplied by 0 in every normal transform; wgsl-static-check.test.ts allows reading only these):
 *  .x = flags2 (above) · .y = HLOD fade coverage (bit 5) · .z = face-kit depth pull in local units (bit 6; written by
 *  Renderer3D._uploadSkinnedInstances ONLY for a mesh with faceDepthPull > 0 — 0 for every other mesh, static or
 *  skinned: the identity / affine inverse-transpose column 3 is (0, 0, 0, 1)) · .w = 1 (untouched).
 */
export const FLAGS2_FLOAT = 28;
export const FLAGS2_DISTANCE_FADE = 1;
export const FLAGS2_DISTANCE_FADE_ATTACH = 2;
export const FLAGS2_NO_FOG = 4;
export const FLAGS2_NO_FOG_HARD_EDGE = 8;
export const FLAGS2_CROWD_PALETTE = 16;
export const FLAGS2_HLOD_FADE = 32;
export const FLAGS2_FACE_DEPTH_PULL = 64;
export const FLAGS2_HAIR_BAND = 128;
export const FLAGS2_CLOTH_LINING = 256;
/** Instance float of the HLOD fade coverage (normalMatrix column 3 .y; see bit 5 above). */
export const HLOD_FADE_FLOAT = 29;
/** Instance float of the face depth pull, local units (normalMatrix column 3 .z; see bit 6 above). */
export const FACE_DEPTH_PULL_FLOAT = 30;
/** The flags2 value of a mesh (see the block above). 0 for everything that is not a city fader or a no-fog mesh. */
export function encodeMeshFlags2(m: { fogClass?: number; fogNoFade?: boolean; hlodFade?: number; faceDepthPull?: number; material?: { noFog?: boolean | 'hardEdge'; crowdPalette?: boolean; hairBand?: boolean; hairSheen?: boolean; clothLining?: boolean } }): number {
  const nf = m.material?.noFog, cp = (m.material?.crowdPalette ? FLAGS2_CROWD_PALETTE : 0) | ((m.hlodFade ?? -1) >= 0 ? FLAGS2_HLOD_FADE : 0)
    | ((m.faceDepthPull ?? 0) > 0 ? FLAGS2_FACE_DEPTH_PULL : 0) | (m.material?.hairBand && m.material?.hairSheen ? FLAGS2_HAIR_BAND : 0)
    | (m.material?.clothLining ? FLAGS2_CLOTH_LINING : 0);
  if (nf === true) return FLAGS2_NO_FOG | cp;
  if (nf === 'hardEdge') return FLAGS2_NO_FOG_HARD_EDGE | cp;
  return (m.fogClass === 2 ? (m.fogNoFade ? 0 : FLAGS2_DISTANCE_FADE) : m.fogClass === 1 ? FLAGS2_DISTANCE_FADE_ATTACH : 0) | cp;   // (step 3: an 'overlay' is culled, never faded)
}
/** The fog class the fog-horizon CPU cull uses for a mesh: its fogClass, or 0 (always kept) for a no-fog mesh (the
 *  cull only runs under Hard edge, where both noFog modes are live). */
export function fogCullClass(m: { fogClass: number; material: { noFog?: boolean | 'hardEdge' } }): number {
  return m.material.noFog ? 0 : m.fogClass;
}

const PATTERN_MAP: Record<NonNullable<Material3D['patternMode']>, number> =
  { none: 0, stripes: 1, dots: 2, diamonds: 3, checker: 4, grid: 5, windows: 6, waves: 7 };

export function encodeMaterialFlags(mat: Material3D): number {
  const styleMap: Record<RenderStyle, number> = { default: 0, cel: 1, sketch: 2, ink: 3, gouraud: 4, 'cel-hd': 5, unlit: 6, cd: 7 };
  let flags = 0;
  if (mat.hasTexture)      flags |= 1;
  if (mat.hasNormalMap)    flags |= 2;
  flags |= (styleMap[mat.renderStyle ?? 'default'] & 7) << 2;
  if (mat.alphaCutout)     flags |= 32;
  if (mat.hairSheen)       flags |= 64;
  if (mat.rimEnabled)      flags |= 128;
  if (mat.sparkleEnabled)  flags |= 256;
  flags |= (PATTERN_MAP[mat.patternMode ?? 'none'] & 7) << 9;
  if (mat.sparkleStar)     flags |= 4096;
  if (mat.leafCard)        flags |= 8192;
  if (mat.glassEnhance)    flags |= 16384;
  if (mat.texOverBase)     flags |= 32768;
  if (mat.boardShade)      flags |= 65536;
  if (mat.radialFade)      flags |= 131072;
  if (mat.groundShade)     flags |= 262144;
  if (mat.windSway)        flags |= 524288;
  if (mat.foliageShade)    flags |= 1048576;
  if (mat.waterShade)      flags |= 2097152;
  if (mat.neonShade)       flags |= 4194304;
  if (mat.metalShade)      flags |= 8388608;
  if (mat.garpTex)         flags |= 16777216;
  if (mat.noEnvReflection) flags |= 33554432;   // bit 25 — per-object matte (skip env specular)
  if (mat.planarReflector) flags |= 67108864;   // bit 26 — planar mirror (sample the mirrored render pass)
  if (mat.worldTriplanar)  flags |= 134217728;  // bit 27 — world-space triplanar diffuse projection
  if (mat.softLighting)    flags |= 268435456;  // bit 28 — soft (wrapped/half-Lambert) diffuse; amount = scene.lightColor.w
  if (mat.skinRamp)        flags |= 536870912;  // bit 29 — skin toon-ramp (band + warm shadow tint); params = scene.skinRampParams
  if (mat.toonShadow)      flags |= 1073741824; // bit 30 — toon shadows in Cel / Cel-HD; params = scene.toonParams + styleParams.yz
  if (mat.retroColor)      flags |= 0x80000000; // bit 31 (the LAST free bit) — opted in to the PS1 colour depth + dither
  return flags >>> 0;   // unsigned: bit 31 would otherwise make the JS number negative (written via setUint32 either way)
}

/**
 * ★ Apply a MATERIAL-ONLY mutation to a mesh and flag it correctly for the renderer.
 *
 * Use this — never a bare `Object.assign(mesh.material, …)` — for every material edit that leaves the
 * GEOMETRY alone (`applyGroundMaterial3D`, board presets, scene wind, glow/frost walks…).
 *
 * WHY `materialDirty` and NOT `gpuDirty` (the "Apply Ground does nothing" bug): `gpuDirty` means "this
 * mesh's GEOMETRY changed". A resident mesh flagged `gpuDirty` forces a full geometry-pool rebuild, and
 * the instance-upload fast/incremental paths deliberately skip unmoved residents — so the new material
 * floats never reached the instance buffer, while the geometry pass cleared the flag the same frame. The
 * change was invisible until an unrelated structural edit forced a full repack. `materialDirty` is the
 * flag both upload paths actually watch for a material-only change.
 */
export function applyMaterialPatch(
  mesh: { material: Material3D; materialDirty: boolean },
  patch: Partial<Material3D>,
): void {
  Object.assign(mesh.material, patch);
  mesh.materialDirty = true;
}
