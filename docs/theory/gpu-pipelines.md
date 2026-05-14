# GPU Pipelines and Bind Groups
**Last Updated:** 2026-05-11

---

## Intuition

The GPU is a state machine. Before it can draw anything, it needs to know: what shader code to run, what format the vertex data is in, how to blend new pixels with existing ones, whether to write to the depth buffer, how many color attachments there are, what those attachments' formats are. A **render pipeline** is that configuration, pre-validated and compiled by the GPU driver into a form it can execute efficiently.

A **bind group** is the data the shader reads: uniform buffers, textures, samplers. Not the shader code itself — that's baked into the pipeline. Just the inputs.

The separation between pipeline (shape) and bind group (material) is intentional and matters a lot in practice.

---

## Mental Model

A pipeline is a **mold**. It defines the shape of the operation: what vertex format to expect, what the shader does, how outputs are combined. Creating a mold is expensive — the GPU driver validates all the pieces fit together and compiles the shader for the specific hardware.

A bind group is the **material you pour into the mold**. It's just a set of handles to GPU resources (buffers, textures) that the shader will read. Creating a bind group is cheap. Swapping to a different bind group during rendering is cheap. Swapping to a different pipeline is more expensive (though still much cheaper than creating one).

In a frame, you might use one pipeline and swap bind groups 200 times — once per mesh. Or you might use 5 pipelines and group all meshes by their pipeline, minimizing pipeline switches.

---

## Formal Explanation

**Render pipeline creation (WebGPU):**

```typescript
const pipeline = device.createRenderPipeline({
  vertex: {
    module: device.createShaderModule({ code: WGSL_VERTEX }),
    entryPoint: 'vs_main',
    buffers: [{
      arrayStride: 48,          // bytes per vertex
      attributes: [
        { shaderLocation: 0, offset:  0, format: 'float32x4' },  // position
        { shaderLocation: 1, offset: 16, format: 'float32x4' },  // normal
        { shaderLocation: 2, offset: 32, format: 'float32x2' },  // uv
        { shaderLocation: 3, offset: 40, format: 'float32x2' },  // uv2
      ],
    }],
  },
  fragment: {
    module: device.createShaderModule({ code: WGSL_FRAGMENT }),
    entryPoint: 'fs_main',
    targets: [{ format: swapChainFormat, blend: ALPHA_BLEND }],
  },
  primitive: { topology: 'triangle-list', cullMode: 'back' },
  depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less' },
  layout: 'auto',
});
```

Every field here is baked in at creation time. You cannot change the shader or the vertex format later without creating a new pipeline.

**Bind group creation:**

```typescript
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: uniformBuffer } },
    { binding: 1, resource: texture.createView() },
    { binding: 2, resource: sampler },
  ],
});
```

The layout must match exactly what the shader declares at `@group(0)`. The GPU validates this at bind group creation time.

**Draw call:**

```typescript
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.setVertexBuffer(0, vertexBuffer);
pass.setIndexBuffer(indexBuffer, 'uint16');
pass.drawIndexed(indexCount, instanceCount);
```

---

## Why It Matters

**Pipeline pre-baking prevents stalls.** In WebGL, shader compilation could happen lazily during the first draw call, causing a visible hitch. WebGPU's explicit pipeline creation lets you pay the compile cost upfront at init time, so draws are consistently fast.

**Bind group layout as a contract.** The pipeline declares what bindings it expects; the bind group fulfills the contract. If there's a mismatch (wrong buffer type, wrong binding slot), you get a GPU validation error at bind group creation, not silently wrong pixels at draw time. This is a meaningful improvement over WebGL's implicit binding model.

**Minimizing state changes.** Every `setPipeline` call is relatively expensive (the GPU switches shader programs, reconfigures the rasterizer). Every `setBindGroup` call is cheap. The optimal batching strategy is: sort draw calls by pipeline first, bind group second. Salsa's renderer does this by grouping meshes into buckets: opaque standard, opaque vertex-color, transparent, etc. All meshes in a bucket share a pipeline; bind groups differ per mesh.

**Why vertex buffers are not in bind groups.** Vertex buffers have their own `setVertexBuffer` call rather than going into a bind group. This is a WebGPU design choice: vertex data has special fixed-function hardware paths on the GPU that operate differently from general shader resource access. Putting vertex data in a storage buffer (which *can* go in a bind group) bypasses these paths and is slower for the common case.

---

## Where the Mental Model Breaks

**Pipeline creation is synchronous but compilation is not.** `createRenderPipeline()` returns immediately, but under the hood the GPU driver is compiling the shader on a background thread. The first draw call that uses the pipeline may stall while the driver finishes. For complex shaders this can be 100ms+, causing a visible freeze. The fix is `createRenderPipelineAsync()`, which returns a Promise and lets you defer the draw until compilation is done. Salsa's pipeline initialization happens at startup precisely to avoid this stall at first render.

**Bind groups are immutable.** Once created, a bind group cannot be modified. To update a texture in a bind group, you create a new bind group pointing to the new texture. This surprises people coming from WebGL, where `gl.bindTexture()` just swaps the active texture. The WebGPU model is explicit: the bind group is a snapshot of "these resources, at these bindings" and that snapshot is fixed.

**`layout: 'auto'` is convenient but limiting.** Automatic layout inference means the pipeline's bind group layout is derived from the shader code. This works for one-off pipelines but makes it impossible to share a bind group between two pipelines with different layouts (even if both shaders declare the same bindings). For Salsa's uniform buffer (camera matrices, light data), a shared explicit layout would allow one bind group to be set once and reused across every pipeline in the frame. Salsa currently uses `layout: 'auto'` everywhere and re-sets the camera bind group per pipeline.

**Vertex buffer slots ≠ bind group bindings.** The vertex color pipeline uses two vertex buffer slots (slot 0: geometry, slot 1: per-vertex color) instead of a storage buffer in a bind group. This is because per-vertex data benefits from fixed-function vertex fetch hardware. But it means the pipeline must explicitly declare both slots — a pipeline expecting one vertex buffer can't be reused for vertex-colored meshes. This is the practical reason Salsa has a separate `opaqueVertexColorPipeline` in addition to the standard `opaqueSimplePipeline`.

---

## Common Confusions

**"I can change the shader after creating the pipeline."**
You can't. The shader module is baked into the pipeline at creation. To change shader behavior, you create a new pipeline (or use a uniform flag and branch inside the shader, which keeps the pipeline the same but adds a branch cost).

**"Bind group layout 0 is for global data, layout 1 is for per-object data."**
This is a *convention*, not a requirement. Nothing in WebGPU forces group 0 to be per-frame and group 1 to be per-draw. The convention exists because you can set group 0 once per frame and group 1 per draw call, which minimizes rebinds for per-frame uniforms (like camera matrices and light data). Salsa uses group 0 for per-frame data and group 1 for per-mesh data, following this convention.

**"More draw calls = slower."**
Generally true, but the bottleneck shifts. At low vertex counts, CPU overhead per draw call dominates — you want fewer, larger draws. At high vertex counts, GPU vertex throughput dominates — you want to maximize GPU utilization. Instancing and indirect rendering address the CPU overhead case; they don't help when the GPU is the bottleneck.

**"Compute shaders don't use pipelines."**
They use *compute* pipelines, which are separate from render pipelines but follow the same creation and bind-group model. Salsa's cloth simulator and SDF glyph rasterizer are compute pipelines.

---

## How Salsa Uses It

`src/renderer/3d/pipeline-3d.ts` — creates all 3D render pipelines at renderer initialization: opaque standard, opaque vertex-color, transparent, cel-shading, sketch, wireframe, skinned mesh variants. Each is created once and reused across all frames.

`src/renderer/core/webgpu-renderer.ts` — per-frame render loop groups visible nodes by pipeline, creates or reuses bind groups (one per mesh for material data), and issues draw calls with minimal state transitions. The vertex color pipeline adds a `setVertexBuffer(1, colorBuffer)` call before each vertex-colored mesh draw.

`src/renderer/3d/cloth-simulator.ts` — a compute pipeline for PBD simulation. The integrate and constrain passes each have their own compute pipeline; bind groups are created once per cloth mesh and reused each frame with `setBindGroup` → `dispatchWorkgroups`.

`src/renderer/3d/gp-renderer-3d.ts` — separate pipelines for GP fills and GP strokes. Both set `depthWriteEnabled: false` so GP layers on top without occluding each other in the depth buffer.

---

## Related Concepts

- [Scene Graphs](scene-graphs.md) — the scene graph provides the per-instance transform data fed into instance buffers; the pipeline consumes that data in the vertex shader
- [Depth Buffers](depth-buffers.md) — `depthWriteEnabled` and `depthCompare` in the pipeline descriptor control depth behavior; understanding depth is prerequisite to understanding why GP disables depth write
- [Instancing](instancing.md) — instanced draws use the same pipeline for many objects; instance data goes into a second vertex buffer slot or a storage buffer in a bind group
