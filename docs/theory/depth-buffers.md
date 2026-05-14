# Depth Buffers
**Last Updated:** 2026-05-11

---

## Intuition

The GPU draws triangles one at a time, in some order. Closer triangles should hide farther ones. But you can't sort all triangles by depth first — sorting is O(n log n), and it fails completely for intersecting triangles, which can't be sorted at all (each one is partially in front of the other).

The depth buffer solves this with a per-pixel ledger. Before writing a new pixel's color, the GPU checks: "is this fragment closer than what's already here?" If yes, write and update the ledger. If no, throw it away. Now you can submit geometry in any order and the correct thing renders.

---

## Mental Model

The depth buffer is a second image, the same resolution as the color target, with one value per pixel instead of a color. That value is the depth of the closest fragment seen so far at that pixel.

At the start of a frame, every depth buffer pixel is cleared to 1.0 (the farthest possible value — nothing drawn yet).

For each incoming fragment, the GPU:
1. Computes the fragment's depth
2. Compares it against the stored depth (using a configurable compare function, default: `less`)
3. If the fragment is closer (depth < stored): write the color, update the depth buffer to the new value
4. If the fragment is farther (depth ≥ stored): discard the fragment

The end result: only the closest fragment at each pixel ends up in the color target, regardless of the order geometry was submitted.

---

## Formal Explanation

**Depth buffer format:** Typically `depth24plus-stencil8` (WebGPU). 24 bits of depth precision + 8 bits for the stencil buffer. Values are floating-point in [0, 1].

**Depth range:** In WebGPU, the projection matrix maps the near plane to depth 0.0 and the far plane to depth 1.0. (OpenGL uses [−1, 1] in NDC, then remaps to [0, 1] for storage — WebGPU skips the middle step and uses [0, 1] NDC depth directly.)

**Compare functions:**
- `less` (default): write if new depth < stored depth. Nearest wins.
- `always`: always write, ignore depth. Used for 2D overlays that should appear regardless.
- `equal`: write only if depth exactly matches stored. Used for multi-pass effects (draw the same geometry twice, second pass only where it exactly matches the first).
- `less-equal`, `greater`, `greater-equal`, `never`: variants for specific techniques.

**Depth write enable:** Separate from depth compare. You can test (read) without writing. This is used for transparent objects: test against opaque geometry (so transparent things don't appear through solid walls) but don't write new depth values (so transparent layers behind this one can still render).

---

## Why It Matters

**Correctness for free.** Without depth buffering, you have two options: painter's algorithm (sort back-to-front and draw in order) or hardware depth testing. Sorting fails for intersecting geometry and costs O(n log n) per frame. Hardware depth testing handles all cases in O(1) per pixel.

**Multi-pass rendering.** Many advanced effects — deferred shading, SSAO, screen-space reflections, shadow maps — require reading depth information from previous passes. The depth buffer is the only way to know "how far away was the scene at this pixel" after the geometry passes are done.

**Stencil buffer (the other 8 bits).** The stencil buffer colocated with depth is a per-pixel counter/bitmask. It's used for effects like: "only render inside this region" (render a mask into stencil, then compare against it), outline rendering (render object to stencil, then render a slightly scaled version and only draw where stencil isn't set), and portal rendering. Salsa doesn't currently use the stencil buffer, but it's available.

---

## Where the Mental Model Breaks

**Depth precision is non-linear.** The 24-bit depth value covers [0, 1] linearly, but the mapping from world-space distance to [0, 1] is non-linear due to perspective projection:

```
depth_buffer = (f/(f-n)) - (f*n/((f-n)*z_view))
```

Where n = near plane, f = far plane, z_view = distance from camera. This function compresses a lot of precision near the near plane and very little near the far plane. Consequence: two objects 0.01 world units apart at z=1 (near camera) can be distinguished; two objects 10 world units apart at z=1000 (far from camera) may z-fight.

The practical rule: set the near plane as far from the camera as possible. A near plane of 0.001 wastes 80%+ of depth precision on a tiny region near the camera. A near plane of 0.1 or 1.0 distributes precision much better across the visible range.

**Z-fighting.** When two coplanar or nearly coplanar surfaces are both rendered, floating-point precision means slightly different depth values at different pixels — the result is a flickering pattern where each surface "wins" at different pixels. Classic examples: a decal sitting exactly on a wall, a second mesh coincident with the first. Solutions: polygon offset (shift one surface's depth slightly — `depthBias` in WebGPU), or render only one of them, or use a different layering technique (stencil, alpha compositing).

**Transparent objects need two passes.** If a transparent object writes to the depth buffer, it will occlude any geometry behind it in the depth buffer — even though those objects should be visible through the transparency. The standard solution is two-pass rendering:
1. **Opaque pass:** render all opaque geometry normally (depth write on, depth compare `less`).
2. **Transparent pass:** render transparent geometry with depth write *off* but depth compare *on* (`less`). This lets transparent objects correctly clip against solid walls (depth compare still active) without blocking other transparent objects behind them.

Order-independent transparency (OIT) is a harder variant: without back-to-front sorting, multiple transparent layers at one pixel blend incorrectly. True OIT requires either sorting (expensive) or per-pixel linked lists (complex GPU implementation). Salsa renders transparent meshes approximately back-to-front as a reasonable default.

**Depth buffer reads are expensive in some architectures.** On tile-based GPU architectures (most mobile GPUs), reading the depth buffer in a shader (as opposed to testing against it in the fixed-function depth test) may force a tile flush — the GPU has to write tile memory back to main memory before the read. Salsa doesn't currently do depth reads in shaders, but SSAO and screen-space reflections would require this.

---

## Common Confusions

**"Depth write disabled means depth test disabled."**
No. `depthWriteEnabled: false` disables *writing* to the depth buffer; the depth *test* (compare) still runs. This is the GP case: GP strokes don't occlude each other (depth write off) but they don't render through solid meshes (depth compare still `less`). Write and compare are independent switches.

**"Clearing depth to 0.0 would be more intuitive."**
Clearing to 1.0 (farthest possible) is correct for the default `less` compare: every new fragment is closer than 1.0, so the first fragment at each pixel always wins. Clearing to 0.0 would mean every fragment is farther than 0.0, so nothing would ever write through the first pass. Some effects deliberately don't clear depth (to preserve it from a previous pass), but for a normal frame start, 1.0 is always right.

**"The depth buffer stores z in world space."**
It stores z in the [0, 1] post-projection range, not in world-space units. To recover a world-space position from the depth buffer, you unproject: `depth_buffer → NDC z → clip z → view z → world pos`. Several steps, and precision loss due to the non-linear mapping. This is why shadow maps have precision issues — they store projected depth, not world-space distance.

---

## How Salsa Uses It

`src/renderer/core/webgpu-renderer.ts` — depth texture created as `depth24plus-stencil8` at canvas resolution. Cleared to 1.0 at the start of every 3D render pass. Near plane is set in `Camera3D` — getting this value right matters for depth precision at typical scene scales.

`src/renderer/3d/pipeline-3d.ts` — all opaque 3D mesh pipelines use `depthWriteEnabled: true, depthCompare: 'less'`. Transparent mesh pipelines use `depthWriteEnabled: false, depthCompare: 'less'`.

`src/renderer/3d/gp-renderer-3d.ts` — both GP fill and GP stroke pipelines use `depthWriteEnabled: false, depthCompare: 'less'`. This lets GP draw on top of the scene without GP layers occluding each other through the depth buffer, while still being correctly occluded by solid 3D geometry.

Raster layers do not use the depth buffer at all — they're composited in 2D after the 3D passes.

---

## Related Concepts

- [GPU Pipelines](gpu-pipelines.md) — depth write enable and compare function are pipeline state, baked at pipeline creation time
- [Coordinate Spaces](coordinate-spaces.md) — depth buffer values are in post-projection space [0,1]; recovering world-space distances requires inverting the full MVP chain
- [Instancing](instancing.md) — depth testing applies per fragment regardless of how many instances contributed geometry; 10,000 instanced trees depth-test correctly with no special handling
