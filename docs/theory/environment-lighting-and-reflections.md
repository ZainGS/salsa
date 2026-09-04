# Environment Lighting & Reflections — the theory
**Last Updated:** 2026-09-04

**Companion to:** `docs/specs/environment-and-reflections.md` (the build plan). This doc explains the *why* behind that plan — the physics and the standard real-time approximations — so the code reads as deliberate choices rather than magic constants. It maps every concept to the Salsa file that implements it.

---

## 0. The one-sentence version

A surface's colour is **the light arriving on it, times how the material bounces that light toward the eye.** "Lighting" is the first factor, "material/BRDF" is the second, and *the environment (the sky) is the dominant source of the first* — which is why the sky, the ambient light, and the reflections are all one subsystem: they're the same light measured three ways.

---

## 1. Radiance and the rendering equation

The quantity we actually compute per pixel is **outgoing radiance** `Lo` toward the camera. The rendering equation says it's the sum, over every incoming direction `ωi` on the hemisphere above the surface, of:

```
Lo(v) = ∫  f(v, ωi) · Li(ωi) · (n·ωi)  dωi
        Ω
```

- `Li(ωi)` — radiance arriving from direction `ωi` (a lamp, the sun, or **the sky**).
- `f(v, ωi)` — the **BRDF**: the fraction of light from `ωi` that scatters toward the view `v`.
- `(n·ωi)` — Lambert's cosine term: light hitting at a grazing angle is spread over more area, so it contributes less.

Everything below is either **a model for `f`** (§2) or **a way to evaluate that integral against the whole sky cheaply** (§3–§5). A single directional light is the trivial case — the integral collapses to one direction. The environment is the hard case — light comes from *every* direction at once.

---

## 2. The BRDF — Cook-Torrance / metalness-roughness

Salsa uses the industry-standard **Cook-Torrance** microfacet BRDF (`mesh3d-shaders.ts`, `PBR_IBL_WGSL`). It splits `f` into **diffuse** (light that penetrates and scatters out in all directions — matte) and **specular** (light that reflects off the surface microfacets — shiny):

**Specular** = `D · G · F / (4 · n·v · n·l)`:
- **D — normal distribution** (`D_GGX`): what fraction of microfacets point the right way to reflect `ωi` into `v`. `roughness` widens this lobe — low roughness = a tight mirror highlight, high roughness = a broad soft one.
- **G — geometry/shadowing** (`G_Smith`): microfacets occlude each other at grazing angles.
- **F — Fresnel** (`F_Schlick`): *everything* becomes mirror-like at grazing angles (the reason a lake reflects the far shore but not your feet). `F0` is the reflectance at normal incidence.

**Metalness-roughness parameterization** (the authoring model):
- **Metals** have no diffuse (they absorb transmitted light); their `F0` is the metal's tint (gold reflects gold). So `F0 = mix(0.04, albedo, metalness)` and `diffuse = albedo · (1 - metalness)`.
- **Roughness** drives the specular lobe width (D above) *and* which reflection mip we sample (§4).

This is "a full PBR pipeline": a physically-based BRDF with metalness/roughness/normal/emissive inputs. Salsa has had this for a while — it is **not** what was missing. What was missing is the second factor: feeding this BRDF the *environment* as a light source.

---

## 3. Image-Based Lighting — the environment IS a light

A directional light is one term. But a surface outdoors is lit by the **entire sky** — blue from above, warm from the sun, dark from the ground. **Image-Based Lighting (IBL)** treats the surrounding environment (stored as a cube or sphere map) as a giant area light and evaluates the rendering-equation integral against it.

The integral factors cleanly into the two BRDF halves, and each gets its own precomputed representation:

| | What it captures | Frequency | Salsa representation |
|---|---|---|---|
| **Diffuse IBL** | matte surfaces gathering sky light | very **low** (cosine-blurred) | **Spherical Harmonics** (§3.1) |
| **Specular IBL** | shiny surfaces reflecting the sky | **high** at low roughness | **prefiltered cubemap + BRDF LUT** (§4) |

The key insight is **frequency**: a matte surface averages the whole hemisphere, so its lighting varies *slowly* over the sphere of normals — 9 numbers describe it. A mirror reflects a *sharp* image, so it needs a full-resolution map. Using the same cheap representation for both is the mistake that makes reflections look like blurry blobs.

### 3.1 Diffuse IBL via Spherical Harmonics

**Spherical Harmonics (SH)** are to functions-on-a-sphere what a Fourier series is to functions-on-a-line: a set of basis shapes (constant, three linear lobes, five quadratic lobes = the first 9, "L0–L2") whose weighted sum approximates any smooth spherical function. Because diffuse irradiance is heavily cosine-blurred, **9 coefficients reconstruct it almost perfectly.**

Salsa: `renderer-3d._computeSHCoeffs(imageData)` integrates an equirectangular environment image against the 9 SH basis functions (pre-multiplied by the Ramamoorthi-Hanrahan cosine-lobe factors), stores 9 RGB coefficients in a 160-byte uniform; the shader's `evalSHIrradiance(N)` evaluates them along the surface normal. Cheap, correct, done.

**Why SH can't do specular:** 9 coefficients is a *very* blurry image. Reflect it in a mirror and you get a coloured smudge, not the sky. That's the ceiling the current engine hits — `envSpecular`'s IBL branch reuses the SH probe along the reflection vector, so metals get a *soft* sky-tinted reflection but never a crisp one.

---

## 4. Specular IBL via the split-sum approximation

Karis (2013, UE4) gives the standard real-time trick for the specular half. The integral

```
∫ f_spec(v, ωi) · Li(ωi) · (n·ωi) dωi
```

is **split** into two independently-precomputed factors (hence "split-sum"):

```
    ≈  ( ∫ Li · D-weighted )  ×  ( ∫ f_spec / F · (n·ωi) )
       └── prefiltered env ──┘    └──── BRDF LUT ─────┘
```

**1. The prefiltered environment map** — the sky, pre-blurred by the GGX lobe at several roughness levels, stored as the **mip chain of a cubemap**. Mip 0 = roughness 0 = the sharp sky (a mirror). Each higher mip = a rougher, blurrier convolution. At shading time a surface samples `mip = roughness × maxMip` along its reflection vector `R` — so a polished floor samples mip 0 (crisp) and a brushed-metal one samples a high mip (soft), from the *same* texture. This is what turns the blurry SH blob into an actual reflection.

- Salsa CPU reference: `ibl-prefilter.prefilterColor(envSample, R, roughness)` — GGX-importance-samples the environment for one reflection direction. Validated: returns the direct sample at roughness 0, blurs toward the local average at roughness 1. `ibl-specular-bake.bakePrefilteredCube(...)` bakes the full faces×mips set from the procedural sky.

**2. The BRDF integration LUT** — the second factor depends only on `(n·v, roughness)`, *not* on the environment, so it's baked **once** into a 2D lookup texture of `(scale, bias)` values. Final specular = `prefiltered · (F0 · scale + bias)`.

- Salsa: `ibl-prefilter.integrateBRDF` / `generateBRDFLUT` / `ibl-specular-bake.bakeBRDFLUTBytes`. Validated: `(scale, bias) → (1, 0)` at roughness 0 / normal incidence (a perfect mirror keeps its Fresnel).

**Importance sampling & the Hammersley sequence:** convolving the sky per mip means averaging many samples of the GGX lobe. Instead of uniform random samples (noisy) we use a **low-discrepancy Hammersley sequence** (`ibl-prefilter.hammersley`) mapped through the **GGX distribution** (`importanceSampleGGX`) so samples cluster where the lobe is bright — far fewer samples for the same quality. This is why the prefilter is cheap enough to bake on the CPU on a sky change.

---

## 5. The procedural sky — one source for lighting *and* reflections

Where does the environment map come from? Two options: a captured **HDRI** photo, or a **procedural** model. Salsa is procedural-first (the on-brand "anime-sky" angle): an analytic function of view direction.

`procedural-sky.evaluateSkyColor(dir, sky, sunDir)` is a 3-stop vertical gradient (ground → horizon → zenith) plus a sun disk and halo. Because it's just a function of direction, the *same* function:
1. draws the **viewport backdrop** (what you see behind the geometry),
2. bakes the **SH diffuse** (via `bakeSkyEquirect` → `_computeSHCoeffs`),
3. bakes the **prefiltered specular cubemap** (via `bakePrefilteredCube`).

So the light hitting a surface, the ambient in the shadows, and the reflection in a chrome ball **all come from the same sky and stay coherent** through a day/night change — move the sun and everything updates together. That coherence is the whole point of an `EnvironmentManager` owning one `EnvironmentState`.

"**Physical Sky**" (the Spline term) specifically means the sky is an *atmospheric-scattering* model — Rayleigh scattering (why the sky is blue and the horizon pale) and Mie scattering (the white haze around the sun) computed from a sun angle — rather than an artist gradient. Salsa's `sky.model: 'gradient' | 'physical'` reserves that upgrade behind the same interface; the gradient is the stylized default, physical scattering is the photoreal option.

**Re-bake on change, not per frame.** The sky only changes when the sun moves or a param is edited, so the (relatively expensive) SH + cubemap bake is event-driven. Per frame the shader just does cheap texture samples.

---

## 6. Screen-Space Reflections — reflecting the actual scene

IBL reflects the *environment* (the sky), but not **the scene itself** — a character standing on a wet floor won't appear in the reflection, because they're not in the sky cubemap. **Screen-Space Reflections (SSR)** fill that gap by reflecting what's already on screen.

The method: for a reflective pixel, march a ray along the reflection vector `R` *through the depth buffer*; if the ray hits some geometry's depth, sample that pixel's colour from the previous frame's image — that's the reflection. Salsa already has both inputs SSR needs:
- **the scene-colour grab** (`sceneColorGrabTex`, the previous frame's final image, currently used for glass refraction),
- **the linear-depth prepass** (`ssao-pass.ts`, currently used for ambient occlusion).

SSR's limitation is in its name: it can only reflect what's **on screen** — and only the *camera-facing sides* of it. A reflection of something behind the camera, off the frame's edge, or of a surface facing *away* from the camera (the side a wall mirror must show) has no data. The standard fix is a **hybrid**: where the ray hits on-screen geometry, use the scene colour; where it misses, **fall back to the prefiltered cubemap** from §4. SSR adds scene reflections *on top of* IBL; it never replaces it. That's why P1b (cubemap) comes before P2 (SSR) — the cubemap is SSR's fallback. Salsa's full SSR treatment — the DDA trace, the facing rule, the temporal contract, and the technique's hard boundaries — has its own doc: [screen-space-reflections.md](screen-space-reflections.md). True mirrors are planar reflections (render the scene from the mirrored camera — `planar-reflection.ts`).

---

## 7. Fog — distance and height

Fog blends a surface toward a fog colour based on how much atmosphere the view ray passes through.

- **Distance fog** (what Salsa has, `mesh3d-shaders` fog block): blend factor grows with camera distance — linear (`near`→`far`) or exponential (`1 - e^(-density·dist)`). Plus a cheap **aerial-perspective** term: distant geometry also *desaturates* toward the horizon colour (the blue-grey haze of far mountains).
- **Height fog** (the gap): density also depends on world **Y**. Real fog and mist pool in low ground and thin with altitude, so towers punch through a valley fog layer. The model is an exponential falloff in height, `density × e^(-falloff·(worldPos.y - y0))`, combined with the distance term. This needs a Y term in the fog block and a couple of new params (`y0`, `falloff`) — conceptually small, but it touches the fog code duplicated across every render-style variant, so it's a careful edit.

---

## 8. Colour & coordinate conventions (the easy-to-get-wrong details)

- **Linear vs sRGB.** Lighting math must happen in **linear** space (light adds linearly); textures are usually stored **sRGB** (perceptually uniform, so 8 bits look smooth). Salsa's sky eval returns **linear** colour; the bakes encode **sRGB bytes** (`^(1/2.2)`), because the SH integrator and the GPU sample path both expect sRGB and linearize on read. Mixing these up gives washed-out or too-dark lighting.
- **Y-up, and one direction convention everywhere.** The sky eval, the equirect bake (`bakeSkyEquirect`), the SH integrator (`_computeSHCoeffs`), and the cube-face mapping (`cubeFaceTexelDir`) all agree: Y-up, `theta` measured down from +Y, `phi = atan2(x, z)`. A mismatch here rotates or mirrors the lighting relative to the geometry.
- **Sun direction has two sign conventions.** The **directional light** stores the direction light *travels* (away from the sun). The **sky** wants the direction *toward* the sun (for the disk). They're negatives of each other — `applyProceduralSkyIBL` negates the light direction to place the sun disk. Getting this backwards puts the bright spot opposite the shadows.

---

## 9. How the pieces map to Salsa

| Concept | File / symbol | Status |
|---|---|---|
| Cook-Torrance BRDF | `mesh3d-shaders.ts` `PBR_IBL_WGSL` (`D_GGX`, `G_Smith`, `F_Schlick`) | built |
| Diffuse IBL (SH) | `renderer-3d._computeSHCoeffs`, shader `evalSHIrradiance` | built |
| Environment owner | `services/managers/environment-manager.ts` (`EnvironmentState`) | built (P0) |
| Procedural sky model | `renderer/3d/procedural-sky.ts` (`evaluateSkyColor`, `bakeSkyEquirect`) | built (P1a) |
| Sky → SH ambient | `scene3d-manager.applyProceduralSkyIBL` | built (P1a) |
| Sky presets | `renderer/3d/sky-presets.ts`, `applySkyPreset3D` | built (P5a) |
| Split-sum math | `renderer/3d/ibl-prefilter.ts` (`prefilterColor`, `integrateBRDF`, …) | built (P1b precompute) |
| Specular cube bake | `renderer/3d/ibl-specular-bake.ts` (`bakePrefilteredCube`, `bakeBRDFLUTBytes`) | built (P1b bake) |
| Prefiltered specular sample | `envSpecular` cubemap branch + GPU bindings 7/8/9 | built (P1b) |
| SSR | screen-space DDA in `mesh3d-shaders` ↔ CPU twin `ssr-trace.ts` — see [screen-space-reflections.md](screen-space-reflections.md) | built (P2) |
| Planar reflections (true mirrors) | mirrored-camera math `planar-reflection.ts` (sampling contract proven) | math built; GPU pass parked (P4) |
| Height fog | fog block Y term | planned (P3) |

---

## 10. Further reading (the canonical sources)

- Karis, *Real Shading in Unreal Engine 4* (2013) — the split-sum approximation.
- Ramamoorthi & Hanrahan, *An Efficient Representation for Irradiance Environment Maps* (2001) — the 9-coefficient SH result.
- Lagarde & de Rousiers, *Moving Frostbite to PBR* (2014) — the definitive practical IBL reference.
- *Physically Based Rendering* (Pharr, Jakob, Humphreys) — the rendering equation from first principles.
