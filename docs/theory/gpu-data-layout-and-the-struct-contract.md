# GPU Data Layout & the Struct Contract
**Last Updated:** 2026-09-02

How per-object data is laid out in GPU memory, why the layout is a contract shared across many shaders, and the two tricks (spare *bits* vs spare *bytes*) that decide whether adding a field is a one-line change or a multi-file surgery.

---

## Intuition

To draw many meshes efficiently, the CPU doesn't hand the GPU one object at a time. It packs the data for *every* object — transform, colors, material knobs — into one big flat array in GPU memory, the **instance buffer**, and each shader reads object `i`'s slice out of it. (See [instancing.md](instancing.md) for the draw-call side; this doc is about the *bytes*.)

The catch: GPU memory has no field names, no types, no safety. It's a wall of bytes. "Object `i`'s color" only means something because the CPU that *wrote* the bytes and every shader that *reads* them agree, exactly, on where each field sits and how big it is. That agreement is a **binary contract**. Nothing enforces it — if the two sides disagree by even one byte, you don't get an error, you get garbage.

---

## Mental Model

Think of the instance buffer as a spreadsheet with no headers — just fixed-width columns of raw bytes, one row per object:

```
        │ modelMatrix │ normalMatrix │ diffuse │ specular │ … │ metalness │ …
object0 │  64 bytes   │   64 bytes   │ 16 B    │  16 B    │   │   4 B     │
object1 │  64 bytes   │   64 bytes   │ 16 B    │  16 B    │   │   4 B     │
object2 │  …
```

Two numbers define the contract:

1. **The stride** — total bytes per row (per object). In Salsa's `MeshInstance` it's **224 bytes**. To read object `i`, the GPU jumps to byte `i × 224`.
2. **The offsets** — where each field starts *within* a row (modelMatrix at 0, diffuse at 128, metalness at 188, …).

A shader that wants object `i`'s metalness reads bytes `i × 224 + 188`. If either number is wrong — the stride *or* the offset — it reads the wrong bytes and silently produces nonsense.

---

## Formal Explanation

Salsa's per-object struct (WGSL), the thing that *names* those columns:

```wgsl
struct MeshInstance {
  modelMatrix:    mat4x4<f32>,   // 64 bytes  — object → world transform
  normalMatrix:   mat4x4<f32>,   // 64 bytes
  diffuseColor:   vec4<f32>,     // 16 bytes
  specularColor:  vec4<f32>,     // 16 bytes
  emissiveColor:  vec4<f32>,     // 16 bytes  (.a repurposed as a 32-bit FLAG word)
  textureIndex:   u32,           //  4 bytes
  normalMapIndex: u32,           //  4 bytes
  roughness:      f32,           //  4 bytes
  metalness:      f32,           //  4 bytes
  patternColor:   vec4<f32>,     // 16 bytes
  patternParams:  vec4<f32>,     // 16 bytes
}                                // = 224 bytes = the stride
```

The buffer is `array<MeshInstance>`, and `instances[i]` means "read 224 bytes starting at `i × 224`." The CPU side (`renderer-3d.ts`) writes those exact bytes with a `DataView`: floats via `setFloat32`, integer fields via `setUint32`, each at a hard-coded offset. **The struct declaration and the CPU packing code are the two halves of the contract.**

### Alignment, padding, and where "spare floats" come from

The GPU doesn't pack fields arbitrarily tight. It has **alignment rules**: a `vec4<f32>` must start on a 16-byte boundary, a `vec2` on 8, and so on (WGSL's `std` layout). To honor that, the compiler sometimes inserts **padding** — dead bytes that exist only to push the next field to a legal boundary.

Those dead bytes are a **spare slot**. If a struct happens to carry a `_pad: f32` (or an unused 4th component of a vec4), a *new* per-object number can move into it **for free** — the stride doesn't change, so nothing else has to. `MeshInstance` above is packed tight (the `u32/u32/f32/f32` run fills exactly one 16-byte block), so it has **no spare float** — which is the whole reason adding a continuous value there is expensive.

### A `vec4`'s `.a` is a full 32-bit slot — so you can hijack it

`emissiveColor` is a `vec4<f32>` = four **32-bit floats** (x/y/z/w, a.k.a. r/g/b/a) = 128 bits = 16 bytes. The name `.a` ("alpha") is just a *convention* for the 4th component; the storage is a complete 32-bit float regardless of what it "means."

Salsa exploits that. Emissive color only needs r/g/b — the `.a` slot would otherwise be wasted. So instead of a color, it stuffs **32 boolean flags** into those 32 bits (hasTexture, hairSheen, glassEnhance, the new `noEnvReflection`, …). The CPU writes them as a raw integer:

```typescript
dv.setUint32((offset + 43) * 4, encodeMaterialFlags(mat), true);   // raw 32-bit integer bits
```

and the shader reads the *bits back as an integer*, not as a number, with `bitcast`:

```wgsl
let flags = bitcast<u32>(inst.emissiveColor.a);   // reinterpret the 32 bits as a u32
let noReflect = (flags & 33554432u) != 0u;        // test bit 25
```

`bitcast` means "reinterpret these 32 bits under a different type" — no numeric conversion, just a relabel. Because the value is *written* as raw integer bits and *read* as raw integer bits, it never passes through float arithmetic, so all 32 bits are usable. (This is why the earlier "2^24 is the last safe bit" worry was a red herring — that limit only applies if you store a value *as a float* and expect exact integers back.)

### Why the `.a` slot is free in the first place

Two facts make emissive's `.a` genuinely spare:

- **Emissive is a *material* property, not a light.** It means "this surface shows this color on its own, regardless of how it's lit" — a neon sign, a screen, lava. (Scene *lights* shine *onto* surfaces and cast shadows; an emissive surface stays bright in shadow because it isn't waiting to be lit.) So emissive lives on the mesh's material next to `diffuse`/`roughness`/`metalness`. In basic real-time rendering it doesn't actually *cast* light on neighbors — it just makes itself bright; Salsa fakes the glow spilling out with a bloom post-pass.
- **A glow has no meaningful alpha.** Alpha/transparency is a *compositing* concept — "how much of the background shows through when I blend this over it" — invented for combining image layers, not a property photons carry. A surface's real transparency rides in `diffuseColor.a` (opacity) and is used by the blend pipeline. But emissive is **additive** (added on top, like extra light); its strength is already the RGB magnitude, and you don't blend added light *over* a background by coverage. So there's no "how transparent is the glow" value to store — the `.a` is redundant, hence available.

### Why not just declare `vec3` (r, g, b)?

If the 4th float is unused, why not drop it and store a bare `vec3`? Because it saves nothing and costs regularity:

- **The flags have to live somewhere.** Shrinking emissive to `vec3` doesn't delete the flag word — it evicts it into a new `materialFlags: u32` field. You removed 4 bytes and added 4 back: **net zero**. The only question is *where* the flags sit; the `.a` slot avoids adding a field at all.
- **Alignment often makes the 4th slot unavoidable anyway.** A `vec3<f32>` is 12 bytes of data but 16-byte *aligned*, so the compiler frequently pads it back up to 16 — the 4th slot exists as dead padding whether you name it or not. Better a named `.a` you can use than padding you can't reach.
- **Consistency with the hardware's grain.** GPU data wants to come in 16-byte (vec4) chunks, so all three color fields are `vec4` and each reuses its `.a` for a bonus scalar: `diffuseColor.a` = opacity, `specularColor.a` = shininess, `emissiveColor.a` = the flag word. Three uniform slots, each working *with* the alignment grain, beats mixing `vec3`s with loose scalars for zero byte savings.

---

## Why It Matters

This layout is why **adding a per-object property has two wildly different costs**, depending on how big the property is:

| You want to add… | It needs… | Cost |
|---|---|---|
| A boolean (e.g. "matte: on/off") | one spare **bit** in an existing flag word | **free** — no stride change, one line each side |
| A small enum (≤16 values) | a few spare **bits** | free — pack/unpack a bit range |
| A continuous number (e.g. reflection scale 0–1) | its own **float** (4 new bytes) — no spare exists | **expensive** — the stride changes |

The matte reflection flag was the first row: it dropped into bit 25 of the existing flag word, changed no byte layout, and touched nothing downstream. A continuous per-object reflection *strength* is the third row: it needs 4 new bytes, which changes the stride — and that's where the "surgery" comes in (next section).

**The first question for any new per-object data is therefore: "can it fit in a bit?"** Booleans and coarse enums almost always can. Only genuinely continuous values force a layout change.

---

## Where the Mental Model Breaks

**"There's one struct, so I edit it once."** No — WGSL has no shared headers. Each shader is compiled as an independent program, and **every shader that reads the instance buffer redeclares `MeshInstance` itself.** In Salsa that's ~11 copies across 7 files, because a mesh is drawn in many different *passes*, each its own shader:

- `mesh3d-shaders.ts` — **4** (textured / untextured × plain / shadow-receiving color passes)
- `shadow-shaders.ts` — the shadow-map depth pass
- `ssao-shaders.ts` — the ambient-occlusion depth/normal prepass
- `outline-shaders.ts`, `silhouette-outline-shaders.ts` — selection/hover edges
- `highlight-shaders.ts` — the highlight stencil pass (2)
- `skinning-shaders.ts` — the skinned (skeleton) pass

**They must all agree on the stride, even the ones that only read `modelMatrix`.** A shadow pass that only needs the transform still indexes `instances[i]`, which still means "jump `i × sizeof(MeshInstance)`." If the CPU now packs 228-byte rows but one shader's struct still says 224, that shader mis-locates *every object after the first*. And it fails **silently** — no compile error, because each shader is internally consistent; the numbers are just wrong across the boundary. The symptom is meshes snapping to wrong positions or flashing wrong colors, which is miserable to debug.

So growing the struct = editing all ~11 declarations **in lockstep**, plus the CPU packing offsets, plus bumping the buffer allocation size. Miss one → silent corruption. *That* is why "add a float" is invasive and "flip a spare bit" is not.

**The middle path.** You're not limited to full floats. A continuous-ish value can be **quantized into spare bits** — e.g. a 0–1 scale stored as 4 bits (16 levels) packed into the flag word. No stride change, no surgery, at the cost of precision. It's the pragmatic compromise when an asset genuinely needs a per-object scale but the byte budget says no.

---

## Common Confusions

**"`emissiveColor.a` holds transparency."**
For emissive it doesn't — emissive light has no alpha. That slot is free real estate, so Salsa repurposed its 32 bits as a flag bitfield. The `.a` name is a leftover convention; the bytes are yours to define.

**"`bitcast` converts the number."**
No. `bitcast<u32>(f)` keeps the exact 32 bits and just *reads them as a different type*. `f32(x)` would *convert* (change the bits to represent the same value in another type); `bitcast` never touches the bits. Flags rely on that — the integer bit-pattern must survive unchanged.

**"Bigger stride = proportionally slower."**
Not really. The cost of a wider instance struct is mostly memory bandwidth (more bytes fetched per object), which is minor for a few extra bytes across typical scene sizes. The reason to avoid growing it is **maintenance risk** (the 11-copy lockstep), not raw performance.

**"The GPU will catch a layout mismatch."**
It won't. Bind-group *validation* checks buffer *bindings*, not the semantic meaning of bytes inside a storage buffer. A stride/offset disagreement is a pure logic bug — the GPU faithfully reads whatever bytes you point it at.

---

## The vocabulary (formal names)

What Salsa does to `emissiveColor.a` is three named techniques stacked together — worth knowing so you recognize them in other codebases and articles:

- **Channel packing** — storing unrelated scalar data in the unused channel(s) of a vector or texture. Putting shininess in `specularColor.a`, opacity in `diffuseColor.a`, or flags in `emissiveColor.a` are all channel packing. The most famous instance is the **ORM / "packed" texture**: one RGB image carrying ambient-occlusion, roughness, and metalness in its three channels to save texture fetches. (When it's specifically the alpha channel, some call it **alpha packing**.)
- **Bit packing / bitfield (bitmask)** — cramming many small values into the bits of one larger integer. The 32-booleans-in-one-`u32` is a **bitfield**; `flags & 33554432u` is **masking / a bit test**. Older than graphics — C has native `unsigned foo : 1;` bitfield syntax.
- **Type punning (bitcast / reinterpret cast)** — reading the same bits as a different type with *no conversion*. `bitcast<u32>(inst.emissiveColor.a)` reinterprets the float slot's raw bits as an integer. C calls it type punning (unions / `reinterpret_cast`); shading languages spell it `bitcast` / `asuint` / `floatBitsToUint`. The defining property: the bits are unchanged, only their interpretation changes.

The umbrella term for the whole practice — squeezing many attributes into as few channels/bytes as possible and unpacking them in the shader — is just **data packing** (or **attribute / vertex packing** in the mesh context). It's a core discipline in real-time graphics, driven by the constraint this whole doc is about: **memory bandwidth and fixed layouts are the scarce resource.**

---

## How Salsa Uses It

`src/renderer/3d/shaders/mesh3d-shaders.ts` defines the `MeshInstance` struct (4 template copies) and `bitcast<u32>(inst.emissiveColor.a)` to unpack material flags. The other passes redeclare the same struct: `shadow-shaders.ts`, `ssao-shaders.ts`, `outline-shaders.ts`, `silhouette-outline-shaders.ts`, `highlight-shaders.ts`, `skinning-shaders.ts`.

`src/renderer/3d/material-3d.ts` `encodeMaterialFlags()` owns the bit assignments (bit 0 hasTexture … bit 24 garpTex … bit 25 `noEnvReflection`). `src/renderer/3d/renderer-3d.ts` packs each instance slot with a `DataView` — floats via `setFloat32`, flags/indices via `setUint32` at hard-coded offsets (`(offset + 43) * 4`, etc.).

The **matte reflection flag** (`docs/specs/environment-and-reflections.md`, P1b) is the worked example of the "free bit" path: `Material3D.noEnvReflection` → flag bit 25 → one gate in the shader, zero stride change, zero other files. The deliberately-**not**-built continuous per-object reflection scale is the "expensive byte" path: it would force the 11-copy stride surgery for a capability roughness/metalness already mostly covers.

---

## Related Concepts

- [Instancing](instancing.md) — the draw-call mechanism that *consumes* this buffer; this doc is the byte-layout half of the same story
- [GPU Pipelines](gpu-pipelines.md) — bind-group layouts declare *that* a storage buffer is bound, but never the meaning of bytes inside it — that's the unenforced contract here
- [Coordinate Spaces](coordinate-spaces.md) — the `modelMatrix` field is the object→world transform, the largest part of each instance slot
- [Depth Buffers](depth-buffers.md) — the shadow and SSAO passes that also redeclare `MeshInstance` write depth, and must honor the same stride
