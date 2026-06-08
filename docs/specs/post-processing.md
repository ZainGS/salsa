# Spec: Post-Processing Stack
**Last Updated:** 2026-06-07  
**Status:** Implemented (June 2026)

---

## Summary

A fullscreen post-processing stack that runs after the main render pass and before the final copy to the swapchain. Effects chain in order: bloom → color grade → vignette. Any subset can be active independently. When all effects are disabled the stack short-circuits with zero overhead — `lastFrameTex` is copied to the swapchain unchanged.

---

## Architecture

```
Main render pass → lastFrameTex (bgra8unorm)
  passEncoder.end()

  [if any effects enabled]
  PostProcessPass.run(encoder, lastFrameTex, w, h)
    1. Bloom extract: lastFrameTex → _bloomExtractTex (rgba16float, bright pixels only)
    2. H-blur:        _bloomExtractTex → _bloomBlurTex (rgba16float)
    3. V-blur:        _bloomBlurTex → _bloomExtractTex (rgba16float)
    4. Bloom composite: lastFrameTex + _bloomExtractTex → _pingTex (bgra8unorm)
    5. Grade+vignette: current → _pongTex (bgra8unorm)
    returns: last written output texture

  commandEncoder.copyTextureToTexture(ppOutput ?? lastFrameTex → swapchain)
```

The insertion point is inside the existing `commandEncoder` — all post-process passes run as additional render passes submitted in the same command encoder before the final copy. No extra `queue.submit()` calls.

### Why not render into rgba16float for the full scene?

`lastFrameTex` is `bgra8unorm`, the same format as the swapchain. Redirecting the entire scene to HDR would require changes across the raster compositor, all 2D vector passes, and the foreground raster composite — a much larger refactor. Instead:

- Bloom operates on already-composited LDR data. Bright pixels in a `bgra8unorm` frame are still detectable (values near 1.0 in any channel). The quality difference from true HDR bloom is minimal for the illustration use case.
- Color grade and vignette are purely tone-mapping operations; LDR is sufficient.

### `lastFrameTex` preserved for thumbnails

`lastFrameTex` is never modified by the post-process stack. The stack writes its output to `_pingTex` / `_pongTex`. Thumbnails (grabbed via `snapshotToBlob`) always show the pre-post-process scene — this is acceptable and avoids the complexity of conditionally routing thumbnail capture through the PP output.

---

## Effects

### Bloom

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | false | Enable bloom |
| `threshold` | 0–1 | 0.8 | Luminance cutoff for bright-pixel extraction (soft knee ±0.1) |
| `intensity` | ≥0 | 1.0 | Bloom intensity multiplier |

Implementation: soft-knee bright-pixel extract → separable 9-tap Gaussian blur (H+V) → additive composite over the scene. The composite uses a soft-knee soft-clamp so the bloom doesn't blow out the image.

### Color Grade

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | false | Enable color grading |
| `brightness` | –1 to +1 | 0.0 | Additive brightness offset |
| `contrast` | –1 to +1 | 0.0 | Contrast multiplier around 0.5 pivot |
| `saturation` | –1 to +1 | 0.0 | Saturation modifier (–1 = greyscale, 0 = no change, +1 = double) |
| `tint` | [r, g, b] | [1,1,1] | Per-channel multiplier applied after saturation |

### Vignette

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | false | Enable vignette |
| `intensity` | 0–1 | 0.5 | Darkening strength at the edges |
| `radius` | 0–1 | 0.75 | Normalized radius where vignette begins |
| `softness` | 0–1 | 0.45 | Edge transition softness |

Color grade and vignette run in a single combined shader pass for efficiency.

---

## API

```ts
// Enable bloom with custom threshold:
sm.setPostProcessing3D({
  bloom: { enabled: true, threshold: 0.75, intensity: 1.2 },
});

// Enable vignette:
sm.setPostProcessing3D({
  vignette: { enabled: true, intensity: 0.45, radius: 0.7, softness: 0.4 },
});

// Enable color grade:
sm.setPostProcessing3D({
  colorGrade: { enabled: true, contrast: 0.1, saturation: 0.15, brightness: 0.02, tint: [1.0, 0.97, 0.95] },
});

// Read current config:
const cfg = sm.getPostProcessing3D();
// cfg.bloom.enabled, cfg.vignette.intensity, etc.

// Disable all:
sm.setPostProcessing3D({
  bloom:      { enabled: false },
  vignette:   { enabled: false },
  colorGrade: { enabled: false },
});
```

`setPostProcessing3D` takes a partial object — keys omitted are unchanged. All three effect groups can be updated in one call or separate calls.

---

## Files

| File | Role |
|------|------|
| `src/renderer/3d/shaders/post-process-shaders.ts` | WGSL: fullscreen VS, bloom extract FS, blur FS, bloom composite FS, grade+vignette FS |
| `src/renderer/3d/post-process-pass.ts` | `PostProcessPass` class; `PostProcessConfig` type; `DEFAULT_POST_PROCESS_CONFIG` |
| `src/renderer/3d/renderer-3d.ts` | `setPostProcessing()`, `getPostProcessConfig()`, `runPostProcess()` methods |
| `src/renderer/core/webgpu-renderer.ts` | Calls `runPostProcess` after `passEncoder.end()`; selects PP output for swapchain copy; adds `TEXTURE_BINDING` to `lastFrameTex` |
| `src/services/managers/scene3d-manager.ts` | `setPostProcessing3D`, `getPostProcessing3D` |
| `src/services/shape-manager.ts` | Public API delegation |

---

## GPU Resource Budget

| Resource | Format | Count | Lifecycle |
|----------|--------|-------|-----------|
| `_pingTex` | bgra8unorm | 1 | Destroyed/recreated on canvas resize |
| `_pongTex` | bgra8unorm | 1 | Destroyed/recreated on canvas resize |
| `_bloomExtractTex` | rgba16float | 1 | Destroyed/recreated on canvas resize |
| `_bloomBlurTex` | rgba16float | 1 | Destroyed/recreated on canvas resize |
| `_bloomParamsBuf` | uniform 16B | 1 | Persistent; written when config changes |
| `_hStepBuf` / `_vStepBuf` | uniform 8B | 2 | Persistent; written on resize |
| `_gradeVigBuf` | uniform 48B | 1 | Persistent; written when config changes |

All 4 textures are at canvas resolution. At 1920×1080: 2 × bgra8unorm (8 MB) + 2 × rgba16float (16 MB) = ~24 MB total, allocated only when `PostProcessPass` is first created (i.e., when `setPostProcessing3D` is first called). When all effects are disabled and the renderer is never told about PP, zero bytes are allocated.

---

## Known Limitations

- **Bloom operates on LDR data.** Bright pixels are those with high luminance in `[0,1]` space. True HDR scenes (emissive values > 1.0) require redirecting the mesh pass to an `rgba16float` render target — deferred.
- **Thumbnails show the pre-PP scene.** `lastFrameTex` is preserved unchanged; the PP output texture is not accessible from `snapshotToBlob`.
- **Bind group per-frame for blur passes.** The blur passes create new bind groups every `run()` call because the source/destination textures alternate. This is 2–4 `createBindGroup` calls per frame when bloom is active — low cost but could be cached with more bookkeeping.
