# SSAO — the two formulations, and why one broke in orthographic

**Status:** reverted to **Version A** (world-position G-buffer) on 2026-08-03 after **Version B** (linear-depth + reconstruction + HiZ mips) looked bad in **orthographic** projection. This doc explains both, and the exact reason B failed in ortho but was fine in perspective — so we don't repeat the mistake.

Context: this engine lets the user **swap between orthographic and perspective** cameras (and later a street-level perspective view). Any screen-space effect therefore has to be correct in **both** projections. That constraint is what killed Version B.

---

## What SSAO needs, minimally

For each screen pixel the AO pass needs the surface's **world position** `P` (to reconstruct a normal from neighbours and to place hemisphere samples in world space) and, per sample, the world position of whatever surface is stored at the sample's screen location (to test occlusion). Everything else (kernel, range check, blur) is the same in both versions. The only thing that differs is **how each pixel's world position is obtained.**

---

## Version A — world-position G-buffer (the original; reverted-to)

**Prepass** renders the scene and writes the actual **world XYZ** of each pixel into an `rgba32float` buffer (`.w = 1` for a surface, `0` for background). The AO pass just **reads** `P` straight out of that buffer — no math, no camera model.

```
prepass FS:   out = vec4(worldPos, 1.0)          // store the real position
AO pass:      P   = textureSample(gWorld, uv).xyz  // read it back
```

- **Projection-agnostic by construction.** The stored value is the true world position regardless of how the camera projected it. Perspective, orthographic, street-level — all identical, because *nothing is reconstructed from the camera*. This is why A "just works" everywhere.
- **Cost:** 16 bytes/texel (`rgba32float`). Every AO sample is a 16-byte fetch, and when the `radius` grows the samples scatter across the screen → cache-incoherent 16-byte reads → the **radius-slider fps cliff** you found. That cost is the *only* reason we tried B.

## Version B — linear depth + reconstruct + HiZ mips (the reverted-away experiment)

**Prepass** writes a single float — the **linear camera distance** `d = distance(cameraPos, worldPos)` — into an `r32float` buffer (4 bytes). The AO pass **reconstructs** `P` from that distance:

```
reconstruct(uv, d):
  ndc  = uv → clip-space xy
  wFar = invViewProjection * (ndc, 1, 1)     // a point on the far plane along this pixel
  rd   = normalize(wFar - cameraPos)          // "the ray through this pixel"
  return cameraPos + rd * d                    // walk d along that ray
```

Plus a **min-distance mip pyramid** so far samples read a coarse level (cache-coherent regardless of radius). 4 bytes/tap instead of 16, and the mips fix the radius cliff. **In perspective it looked right. In orthographic it looked broken.**

---

## The bug: `cameraPos + rayDir·distance` assumes a single eye point

That reconstruction encodes one hidden assumption — **all view rays pass through a single point, `cameraPos`.** Picture the two projections:

- **Perspective:** every ray *does* emanate from the eye. Ray **origin is shared** (the camera), ray **direction varies** per pixel. So "ray through this pixel" = `normalize(wFar − cameraPos)`, and walking the true distance `d` along it lands exactly on the surface. **B's reconstruction is exactly the perspective model → correct.**

- **Orthographic:** there is **no eye point.** Rays are all **parallel** — the direction is *constant* (the view axis) and the **origin varies** per pixel (spread across the image plane). The projection has no center of projection; `cameraPos` is effectively arbitrary / at infinity.

```
   PERSPECTIVE (shared origin)        ORTHOGRAPHIC (shared direction)
         eye •                          │  │  │  │  │      ← parallel rays,
        /  |  \                         │  │  │  │  │        no single origin
       /   |   \                        ▼  ▼  ▼  ▼  ▼
      ▼    ▼    ▼                     ────────────────
   ── surface ──                        surface
```

So in ortho, B gets **both halves wrong**:

1. **Direction is wrong.** `normalize(wFar − cameraPos)` fans the rays *out from a point*, but ortho rays are parallel. Only the pixel near screen-center is even close; everything toward the edges gets a direction skewed by the fake perspective spread.
2. **The distance scale is wrong.** `d = distance(cameraPos, worldPos)` is the euclidean distance to an arbitrary ortho "camera"; multiplying it by the (already-wrong) per-pixel direction doesn't retrace the pixel's actual parallel ray.

The reconstructed `P` therefore lands **off the real surface**, and the error grows toward screen edges. Garbage `P` → garbage reconstructed normals → the occlusion test compares nonsense → the AO reads noisy / haloed / plain wrong. In perspective the same code is *correct*, which is why it looked fine there. **The effect wasn't "worse in ortho" — it was fundamentally solving the wrong geometry in ortho.**

(Version A never reconstructs, so it sidesteps all of this — it reads the position that was actually rasterized, under whatever projection.)

---

## Could Version B be fixed for orthographic?

Yes — the ray-walk was a **perspective-only shortcut**. Two projection-correct options:

1. **Reconstruct from device depth via the full inverse-VP** (works for both projections):
   `world = invViewProjection · (ndc.xy, ndcDepth, 1)`, divide by `w`.
   This needs the pixel's **clip/device depth**, not a euclidean distance — so the prepass must store `ndcDepth` (or we sample the real depth buffer), *not* `distance(cameraPos, …)`. The full unproject handles perspective *and* ortho because the projection matrix itself carries the camera model. Storing linear **distance** and ray-walking was the specific mistake.
2. **Branch on projection:** perspective → shared-origin ray-walk (what B did); orthographic → shared-**direction** parallel rays with a per-pixel origin from the unprojected near plane. More code, easy to get subtly wrong.

Either restores B's bandwidth/mip win while being projection-correct. Neither was in the reverted code — B stored linear distance and ray-walked, which is perspective-only. If we retry the cheap-buffer optimization, **option 1 is the one to build**, and it must be verified in **orthographic first** (that's where the bug hides).

---

## Current state & recommendation

- **Shipping Version A** (world-position G-buffer) + the earlier **half-res + configurable `samples`** perf work (kept — it's projection-agnostic and you found half vs full "very similar"). A is correct in both projections; its remaining weakness is the **radius-slider cost**, which is a real but bounded tradeoff.
- The **radius cliff is a bandwidth/cache problem**, not a correctness one — so the right fix is *still* a cheaper buffer + mip pyramid, but built on **option-1 (invVP-from-depth) reconstruction**, and **tested in orthographic before perspective.** Until then, A stays.

**One-line takeaway:** never reconstruct world position with `cameraPos + rayDir·distance` in an engine that has an orthographic camera — that formula bakes in a single eye point that ortho doesn't have. Store real position (A), or unproject device depth with the full inverse-VP (option 1).
