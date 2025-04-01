ucache = Uniform Cache
gcache = Geometry Cache

/** TODO:
 * SLICE-BASED Caches (What we have now): CPU chooses the slice (offset in the uniform buffer) and CPU binds that slice before each draw.
 * Ex: passEncoder.setBindGroup(0, bindGroupWithOffset); and then passEncoder.drawIndexed(...);
 * The Shader just reads from whatever buffer it's given — it has no idea about offsets.
 * BINDLESS Caches (What we SHOULD use eventually): GPU chooses the slice, based on e.g. instance_index or a passed-in shape ID
 * and CPU binds one big buffer once.
 * Ex: passEncoder.setBindGroup(0, bindGroupWithFullBuffer);
 * and then the shader does:
 * let shapeId = ...; // from instance_index or vertex attribute
 * let offset = shapeId * 256u;
 * let data = uniformBuffer[offset / 4]; // access your shape's data
 * 
 * An analogy: 
 * Slice-based: Asking the waiter to bring you one dish at a time
 * Bindless: Having a buffet — you just grab what you need on your own
 * 
 * When you're rendering hundreds or thousands of shapes per frame, calling setBindGroup and
 * drawIndexed per-shape adds CPU overhead. Bindless removes that by making the GPU responsible for
 * indexing into shared buffers.
 * 
 * So the core idea is:
 * Offload per-shape indexing and data fetching from the CPU to the GPU by passing 
 * everything at once and letting the shader index what it needs.
 * 
 * The main difference is that instead of handling indexing in the CPU-side, it's handled by the shader on the GPU-side.
 */