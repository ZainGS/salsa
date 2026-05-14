# Instancing
**Last Updated:** 2026-05-11

---

## Intuition

If you want to draw 1000 trees, the naive approach is 1000 draw calls — one per tree. Each draw call has CPU overhead: encoding the command, the driver validating state, the GPU parsing the command. At 1000 calls per frame at 60fps, you've spent most of your frame budget just telling the GPU to draw, before it's drawn anything.

Instancing is the answer: one draw call that says "draw this mesh 1000 times, with each instance reading its own transform from a buffer." The GPU dispatches vertex processing for all 1000 instances in parallel, with no additional CPU involvement per instance.

---

## Mental Model

The vertex shader runs once per vertex **per instance**. It receives two streams of data:

1. **Per-vertex data** — position, normal, UV — the same for every instance. This is the mesh geometry.
2. **Per-instance data** — transform matrix, color, UV offset — different for each copy. This is the variation.

The instance index (`@builtin(instance_index)`) tells the vertex shader which instance it's currently processing, so it can read the right entry from the per-instance buffer.

```
tree[0]: transform = T0, color = green
tree[1]: transform = T1, color = yellow
tree[2]: transform = T2, color = dark-green
...

vertex shader invocation for vertex V of instance I:
  pos_world = perInstanceData[I].transform * perVertexData[V].position
  color     = perInstanceData[I].color
```

---

## Formal Explanation

**Draw call signature:**

```typescript
pass.drawIndexed(
  indexCount,    // vertices per instance (same mesh, same indices, every time)
  instanceCount, // how many copies to draw
  firstIndex,    // starting index in the index buffer
  baseVertex,    // offset added to every index (for sub-allocating into a shared VB)
  firstInstance, // starting instance index (for sub-ranges of the instance buffer)
);
```

The GPU dispatches `indexCount × instanceCount` vertex shader invocations. Within the shader, `instance_index` ranges from `firstInstance` to `firstInstance + instanceCount - 1`.

**Per-instance data as a vertex buffer (divisor = 1):**

```typescript
// In pipeline descriptor:
{
  arrayStride: 80,           // bytes per instance
  stepMode: 'instance',      // advance once per instance, not per vertex
  attributes: [
    { shaderLocation: 4, offset:  0, format: 'float32x4' },  // row 0 of transform
    { shaderLocation: 5, offset: 16, format: 'float32x4' },  // row 1
    { shaderLocation: 6, offset: 32, format: 'float32x4' },  // row 2
    { shaderLocation: 7, offset: 48, format: 'float32x4' },  // row 3
    { shaderLocation: 8, offset: 64, format: 'float32x4' },  // color
  ],
}
```

`stepMode: 'instance'` is the key field — it tells the GPU to advance to the next entry in this buffer once per instance, rather than once per vertex.

**Per-instance data as a storage buffer:**

Alternatively, instance data can live in a `storage` buffer in a bind group:

```wgsl
@group(1) @binding(0) var<storage, read> instances: array<InstanceData>;

@vertex fn vs_main(
  @builtin(instance_index) iIdx: u32,
  @location(0) pos: vec3f,
) -> @builtin(position) vec4f {
  let m = instances[iIdx].transform;
  return m * vec4f(pos, 1.0);
}
```

This is more flexible (no per-pipeline vertex buffer slot declaration needed) but bypasses the GPU's fixed-function vertex fetch hardware. For typical transforms and colors, the vertex buffer approach is faster.

---

## Why It Matters

**CPU overhead scales with draw calls, not with instance count.** Issuing 1 draw call for 10,000 trees costs approximately the same CPU time as 1 draw call for 1 tree. The instance data upload (`queue.writeBuffer`) scales with instance count, but that's a bulk memory write — fast.

**GPU parallelism is maximized.** All 10,000 tree instances are processed in the same dispatch, so the GPU can schedule vertex shader invocations across its execution units without ever waiting for more commands from the CPU.

**When NOT to use instancing.** If each "instance" has fundamentally different geometry (not just different transforms), instancing doesn't help. You'd need a different vertex buffer or different draw call anyway. Instancing shines when N copies of the *same mesh* differ only by transform/color.

---

## Where the Mental Model Breaks

**The instance buffer is not automatically updated.** You build a CPU-side array of per-instance data, upload it via `queue.writeBuffer`, and it sits on the GPU until you update it again. If instances move each frame (animated characters, particles), you re-upload the buffer every frame. For 10,000 static trees, you upload once and reuse.

**Indirect rendering removes the CPU even from instance counts.** The instance count in `drawIndexed` comes from the CPU — you counted how many visible instances there are and passed that number. Indirect rendering replaces the count with a GPU buffer: a compute shader does the culling, writes surviving instance indices and counts into the buffer, and `drawIndexedIndirect` reads from that buffer. The CPU never touches per-instance visibility — the GPU decides entirely. Salsa doesn't implement this yet, but it's the next optimization level after basic instancing.

**`baseVertex` is subtle.** When multiple meshes share a single large vertex buffer (sub-allocation), `baseVertex` offsets into that buffer so the index buffer for each mesh indexes correctly relative to its sub-allocation start. Forgetting `baseVertex` when sub-allocating produces garbled geometry that's hard to diagnose — indices that were correct for the stand-alone mesh now index into the wrong region of the shared buffer. This is exactly the bug Salsa hit with the vertex color pipeline: the standalone vertex buffer override required forcing `baseVertex = 0` so the per-vertex color buffer indices aligned with the per-vertex geometry indices.

**Instancing doesn't help with draw call *variety*.** If you have 200 different meshes and each is drawn once, you still need 200 draw calls (assuming separate pipelines or bind groups per mesh). Instancing helps with *repetition* — many copies of the same mesh. For the 200-unique-mesh case, the solution is batching (packing meshes into a shared vertex buffer and using draw-call offsets) or indirect rendering (sorting draws on the GPU).

---

## Common Confusions

**"Instancing and batching are the same thing."**
Instancing: one draw call for N copies of the same mesh, per-instance variation in a buffer.
Batching: merging N different meshes into one shared vertex/index buffer and issuing one draw call. Both reduce draw call count, but they're different techniques for different scenarios.

**"`stepMode: 'instance'` is the same as a vertex divisor."**
In WebGL, per-instance vertex attributes use `gl.vertexAttribDivisor(attrib, 1)`. In WebGPU, `stepMode: 'instance'` on the vertex buffer layout achieves the same effect. The concept is the same: this attribute advances once per instance instead of once per vertex.

**"More instances = proportionally more GPU time."**
Roughly true for vertex processing, but rasterization cost depends on screen coverage, not instance count. 10,000 trees that are each a few pixels on screen cost less to rasterize than 10 trees that fill the screen, even though the vertex processing is 1000x more work.

---

## How Salsa Uses It

`src/renderer/core/webgpu-renderer.ts` / `src/renderer/3d/renderer-3d.ts` — Salsa uses instanced draws for 3D meshes. Each frame, a `PerInstanceData` buffer is populated with one entry per visible mesh (model matrix, tint color, UV atlas layer, UV offset), then `drawIndexed(indexCount, instanceCount)` dispatches all meshes sharing the same pipeline in a single call. The per-instance vertex buffer uses `stepMode: 'instance'`.

The vertex color pipeline is the exception: vertex-colored meshes need a *per-vertex* color buffer that doesn't fit the per-instance model. Each vertex-colored mesh gets its own draw call with a dedicated color buffer in slot 1 (and `baseVertex = 0` to align the color buffer with the geometry buffer).

`src/renderer/3d/particle-emitter.ts` — particle rendering is instanced. Each live particle is one instance; per-instance data contains position, size, color, rotation, and atlas UV. The compute shader updates particle positions each frame; the vertex shader reads the updated buffer.

---

## Related Concepts

- [GPU Pipelines](gpu-pipelines.md) — vertex buffer slots and `stepMode` are part of the pipeline descriptor; instancing requires knowing how pipelines consume vertex data
- [Scene Graphs](scene-graphs.md) — the scene graph provides the world matrix per node; that matrix becomes the per-instance transform in the instance buffer
- [Coordinate Spaces](coordinate-spaces.md) — the per-instance model matrix transforms from object space to world space; the shared VP matrix in a per-frame uniform completes the MVP chain
