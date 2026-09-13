# GPU Command Batching & Per-Call Fixed Costs
**Last Updated:** 2026-09-12

The theory behind the E5 raster-paint optimization (audit worklist, 2026-09-11): why the brush felt
its GPU submits, why bind-group churn matters, the shared-buffer race that batching exposes, and how
to make a CPU byte-compare 8× cheaper without changing its answer. Every idea here is transferable —
draw calls, syscalls, DB writes, and network requests all obey the same economics.

**The one-line thesis: per-call fixed costs dominate when the work per call is small — so count API
crossings, not work.**

---

## 1. How work actually reaches the GPU

WebGPU is not "call draw and it draws." The flow is:

1. **Record** commands into a `GPUCommandEncoder` — cheap, you're just building a list in memory.
2. **Submit** the finished list with `device.queue.submit([enc.finish()])` — expensive.

Submit is the costly boundary because the browser must, per submit:
- validate the entire command buffer against API rules,
- resolve memory barriers between passes (who wrote what a later pass reads),
- cross the sandbox/process boundary into the GPU driver,
- schedule the work.

That cost is roughly **fixed per submit, regardless of how much work is inside**. The mental model:
postage on an envelope. Four letters in four envelopes cost 4× the postage of one envelope carrying
four pages. Recording is writing the pages; submitting is paying postage.

Two guarantees make big envelopes safe:

- **In-encoder ordering**: commands inside one command buffer execute in order, and WebGPU inserts
  the barriers automatically. A copy recorded before a compute pass is *finished* before that pass
  reads its output — same as if they were separate submits.
- **Queue ordering across submits**: earlier submits complete before later ones on the same queue.

So merging N sequential steps into one encoder never changes the result of *those steps*. What it CAN
change is the visibility of shared mutable state written outside the encoder — see §4, the best trap
in this document.

---

## 2. Case: the brush dab (3–4 submits → 1)

`brush-stamp-pipeline.ts` performs, per dab of a wet stroke:

1. copy strokeAccumTex → pingTex (snapshot for reading)
2. compute: stamp the dab (read ping, write accum, max-alpha blend)
3. optional compute ×2: bleed blur (accum ↔ ping)
4. compute: composite base + accum → the visible layer texture

Pre-E5 each step was its own encoder + submit. A stylus reports 60–120 pointer events/sec and fast
strokes interpolate several dabs per event → **hundreds of fixed-cost submits per second**, paid on
the same CPU thread that runs the UI. That overhead *is* brush latency: the GPU work per dab is tiny
(a brush-radius bounding box), so the fixed cost was the whole cost.

Post-E5 (`stampRecord` / `bleedRecord` / `compositeRecord` recording into one shared encoder): **one
submit per dab**, measured at 0.9 submits/dab in the harness (below 1.0 because brush spacing skips
some pointer moves).

The subtlety worth internalizing: `pingTex` is used **twice** in the merged buffer — first as the
stamp's read source, then reused as the bleed blur's scratch target. That's only correct because
in-encoder ordering guarantees the stamp pass consumed ping before the bleed pass overwrites it.
When you merge steps, resource reuse that was "obviously fine" across submits becomes something you
must consciously re-verify against the ordering rules.

---

## 3. Case: bind-group churn (validated-on-create objects want identity caches)

A `GPUBindGroup` is the bundle of resource handles (texture views, buffers) a shader binds — and it
is *validated against the pipeline layout at creation time*. `texture.createView()` likewise
allocates a new object per call.

The composite and bleed steps rebuilt their bind groups — 3–4 fresh `createView` calls each —
**every dab**, even though the textures involved are the same three objects for an entire stroke.
Thousands of validations and allocations per stroke, producing identical objects, plus GC pressure
from the garbage.

The pattern (the stamp shader already did it; composite/bleed now match): cache the bind group keyed
on the **identity** of the resources it points at, and rebuild only when one is actually a different
object. The discipline that makes this safe is *invalidation*: every site that destroys/reallocates
one of those textures must clear the cache (in this file, the ping-texture realloc and
`beginStroke`'s accum realloc both null the caches). A cache without audited invalidation sites is a
use-after-free generator — WebGPU will validate-error on you at best.

Rule of thumb: anything the API validates or allocates on creation (bind groups, views, pipelines,
samplers) should be created once per *change*, not once per *use*.

---

## 4. Case: the shared-uniform race — batching changes state visibility

The layer compositor writes each layer's blend settings into a uniform buffer, then dispatches that
layer's blend pass. The original code used **one shared `paramsBuf`** for all layers:

```
write params(layer1) → submit pass1 → write params(layer2) → submit pass2 → …
```

Correct — but only by accident. The rule for `queue.writeBuffer` is that the write is ordered
against **submits**, not against commands you've merely recorded: it lands "before the next submit
executes." Batch those N layers into one submit after N writes to the same buffer and every pass
reads the **last** write — layers 1..N−1 silently composite with layer N's opacity and blend mode.
No error. Just wrong pixels.

So the old design's correctness *depended on its inefficiency* (submit-per-layer). The fix that
decouples them: give each layer its **own** small uniform buffer, cached per layer texture in a
WeakMap (entries die with the texture). Now `_compositeLayerStep` merges each layer's copy+compute
into one submit safely, and a future whole-frame batch wouldn't break either.

This is the most transferable lesson in the file: **when you batch, every piece of shared mutable
state becomes a suspect.** The visibility rules that made sequential code correct (flush-per-write,
submit-per-item, transaction-per-row) may be exactly what your batching removes. Same bug family as
coalescing DB writes that relied on per-statement commit, or buffering a log stream whose readers
assumed line-at-a-time flushes.

---

## 5. Case: the CPU byte-compare (same answer, 8× fewer iterations)

The undo system reads the canvas back after each stroke and compares it byte-for-byte with the
previous snapshot to skip storing duplicates (`raster-snapshot-manager.ts`). Two observations:

- A per-byte JS loop over a full canvas is tens of millions of iterations.
- The compare **early-exits** on the first differing byte — so a real stroke is cheap. The FULL scan
  runs precisely in the dedup-hit case: a no-op stroke over identical pixels. The worst case is the
  common case the dedup exists for.

Fix: view the same bytes as `Float64Array` and compare 8 bytes per iteration. Same memory, no copy,
8× fewer loop iterations, and typed-array loops JIT well.

The correctness wrinkle that makes this worth writing down: some 8-byte patterns decode as **NaN**,
and `NaN !== NaN` — so two byte-identical words could compare "different" and defeat the dedup
(never corrupt it — the failure direction is a redundant snapshot, but still wrong). The fix: any
word-level `!==` falls back to comparing those 8 bytes individually. Exact answer preserved; the
fallback only runs on genuinely-differing words (immediate early-exit) or the astronomically rare
NaN-pattern word.

What we did NOT change: the GPU→CPU readback itself. It *is* the undo payload — you can't skip
reading data you intend to store. The real future optimization there is structural: snapshot only
the dirty rectangle the stroke touched, which shrinks readback, storage, and compare together.

---

## 6. The checklist

When something interactive feels slow and the per-item work is small:

1. **Count the API crossings per user action** (submits per dab, draws per frame, queries per
   request). Instrument first — E5 wrapped `queue.submit` in a counter and measured 0.9/dab after,
   rather than assuming.
2. **Batch at natural boundaries** (one dab, one layer step, one frame), leaning on the API's
   ordering guarantees to keep merged work correct — and re-verify any resource that is reused
   within the merged span (§2's pingTex).
3. **Cache validated-on-create objects keyed by identity**, and audit every invalidation site.
4. **Re-examine shared mutable state under batching** — writes whose visibility was sequenced by
   the very calls you just removed (§4).
5. **Prove behavior unchanged with exact probes**, not eyeballs: the wet-stroke test asserted a
   single 50%-alpha dab probes alpha 204 and twelve overlapping dabs probe *exactly* 204 (the
   max-alpha no-buildup contract), with cross-stroke stacking preserved.

---

## Where this lives in Salsa

| Concern | File |
|---|---|
| Per-dab single-submit recording (`stampRecord`/`bleedRecord`/`compositeRecord`) + bind caches | `src/renderer/raster/brushes/brush-stamp-pipeline.ts` |
| Per-layer cached uniforms + one-submit blend step (`_compositeLayerStep`) | `src/renderer/raster/core/raster-compositor.ts` |
| Word-wise snapshot compare (`_buffersEqual`) | `src/renderer/raster/core/raster-snapshot-manager.ts` |
| The measurements + wet-stroke exactness probes | audit worklist E5 entry, `docs/specs/architecture-review-and-worklist-2026-08-17.md` |

Related theory: [gpu-pipelines.md](gpu-pipelines.md) (what passes/pipelines are),
[gpu-data-layout-and-the-struct-contract.md](gpu-data-layout-and-the-struct-contract.md) (why uniform
buffers have the shapes they do), [instancing.md](instancing.md) (the draw-call flavor of the same
fixed-cost thesis).
