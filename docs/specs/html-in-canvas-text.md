# HTML-in-Canvas Text — Implementation Study

**Status:** Spike v4 proved the editing UX (Chrome 150) and the **LiveText port is IMPLEMENTED** (2026-06-16, type-checks; awaiting live test in Canary). Gated behind `htmlInCanvasAvailable()` with the OffscreenCanvas+textarea path preserved as fallback. Wired: `live-text.ts` (`captureHtmlSource` in onpaint, `updateTexture` HTML branch with per-axis backingDPR sizing + effects each frame, `syncOverlayTransform` affine overlay, `enterEditAt` caret handshake, always-present contenteditable element); `webgpu-renderer.ts` (`driveLiveTextHtml` — onpaint registration + `requestPaint` + overlay sync per frame); `shape-manager.ts` (`enterLiveTextEditingAt(id, clientX, clientY)`). **Frogmarks wiring:** call `enterLiveTextEditingAt` on dblclick-into-node for caret-at-click; gate canvas picking while `node.isEditing`. **Separate follow-up:** the "scaling-translates" bug lives in the shared `raster-transform-engine` (unit-quad size-in-scaleX); the capture auto-sizes the box so the *squeeze* is already fixed.
**Date:** 2026-06-16
**Goal:** A **live, editable HTML element captured to a GPU texture** so we can (a) apply shader effects and (b) keep **native input** (caret, selection, IME, click-to-place). User explicitly prefers this over the OffscreenCanvas snapshot approach because only the real element gives true input + a live source for effects.

---

## 0. CONFIRMED — the spike works (verified live, **Chrome 150.0.0.0**, 2026-06-16)

A throwaway spike ([docs/spikes/html-in-canvas-spike.html](../spikes/html-in-canvas-spike.html)) captured a live `contenteditable` div into a WebGPU texture with native focus/typing working. The **working recipe**, found by iterating against the live API (the docs were wrong twice on the call shape):

```js
// ⚠ ORIGIN-TRIAL SIGNATURE — verified for Chrome 150.0.0.0 ONLY. It has already
//    shifted across builds this session; re-verify on any Chrome bump.
//
// ONE canvas (layoutsubtree on the WebGPU canvas). Editable element is a child.
canvas.onpaint = () => {                              // copy INSIDE onpaint (fresh snapshot)
  const img = canvas.captureElementImage(el);         // step 1: snapshot → ElementImage
  // Size the texture to the COPY EXTENT = ceil(snapshotCSS × backingDPR) PER AXIS.
  // img.width/height are the CSS size, NOT the device extent. The copy rasterizes at the
  // canvas BACKING resolution, which can be ANISOTROPIC (backing aspect ≠ CSS aspect →
  // dprX ≠ dprY), so each axis is sized independently. Too small on EITHER axis → the copy
  // overflows the texture → crash (the original disabling bug, and a single-dpr near-miss
  // that sized W right but H short); too large → glyphs draw short of the hit-box.
  const cr = canvas.getBoundingClientRect();
  const dprX = canvas.width / cr.width, dprY = canvas.height / cr.height;
  ensureTexture(Math.ceil(img.width * dprX), Math.ceil(img.height * dprY));
  device.queue.copyElementImageToTexture(
    { source: img },                                  // source dict (NOT the bare element)
    { destination: { texture: tex } },                // destination dict (NOT { texture })
  );
};
canvas.requestPaint();                                // per frame → onpaint → copy
```
Feature-detect **both** `HTMLCanvasElement.prototype.captureElementImage` and `GPUQueue.prototype.copyElementImageToTexture`. Children are **never painted to screen** (any context) — invisible by default, captured explicitly. **CONFIRMED (Chrome 150):** the focus **caret blinks inside the captured image** — so display-through-effects gets the caret for free; the crisp-caret overlay (§0a) is a precision *option in edit mode*, not mandatory.

## 0a. Interaction model — overlay + pointer-events gating (the editing UX)

Chosen over WebGPU-hit-testing because text needs native caret-from-pixel, word/line/bidi selection, shift-extend, and IME — all free *only if the real element is laid out where the click lands*.

- **The transform sync IS the hit region, not cosmetics.** CSS transforms on `layoutsubtree` children are *ignored for drawing but honored for hit-testing/AX* — so the capture is always the flat, untransformed raster, and the element's CSS transform is purely the click/IME target. It **must be the same projection** as the quad WebGPU draws, or glyphs and clickable area drift. **CONFIRMED (Chrome 150) for the un-transformed case:** sizing the texture per-axis (above) + drawing on the element's `getBoundingClientRect` quad makes glyphs == hit-box exactly (caret drift ≈2px). `getElementTransform()` *exists but needs 2 args* — not required here; it becomes the source of truth only when transformed/rotated text lands (validate Salsa's projection against it then, don't run two math paths).
- **Two named picking layers, gated by mode:** WebGPU/geometry picking owns object-level select/move (overlay **`pointer-events:none`**, inert); the DOM overlay owns character-level editing (**`pointer-events:auto`**, exactly one node, raised z-order). **Clear the element's selection on blur** or it bakes into the non-editing capture.
- **Caret-on-entry is REQUIRED, not optional. CONFIRMED WORKING (Chrome 150, spike v4).** Salsa swallows the double-click to decide intent, so the element never sees it; after `focus()` the caret defaults to the wrong spot. Replay the stored coords with `caretPositionFromPoint(x,y)` → `range.setStart(cp.offsetNode, cp.offset)` (fallback `caretRangeFromPoint`; both present in Chrome 150). Set `pointerEvents='auto'` BEFORE the replay so the element is hit-testable. Verified: double-click mid-text lands the caret under the cursor; native click-to-move, drag-select, typing all work. **This handshake is the make-or-break editing mechanic — proven in the spike before the LiveText port.**
- **Caret/selection through effects is a MODE decision, not a freebie.** Q4 **CONFIRMED**: the caret IS captured (blinks in the effected texture), so display mode gets it for free. Edit mode may still composite a crisp, un-effected caret/selection on top when effects are heavy enough to defeat precise placement — now an *option*, not mandatory. Either way **clear the selection on blur** or it bakes into the non-editing capture.
- **Decouple update rates:** re-sync the overlay transform **every frame** (cheap, CSS only); re-capture + re-run the effect chain **only on `onpaint`/change** (cache the `ElementImage` for static text).
- **Perspective/3D text** stays the deferred exception — a flat DOM rect can't map a perspective quad; **temporarily un-transform to edit** rather than standing up partial WebGPU hit-testing for a rare case.

---

## 1. The feature (Chrome experimental "draw element" / `layoutsubtree`)

Chrome has an experimental capability to put **interactive HTML inside a `<canvas>`** and copy its rendering into GPU textures:

- **`<canvas layoutsubtree>`** — the attribute opts the canvas's HTML children into **layout + hit-testing** (so they have real positions/sizes and can receive pointer/focus). Set in `setupCanvasForHtmlCapture()` / `shape-manager` ([6278-6281](../../src/services/shape-manager.ts#L6278)).
- **Transport to GPU** (detected in `TextEffectEngine.htmlInCanvasMode()`):
  - `webgpu-native`: **`GPUQueue.copyElementImageToTexture(element, { texture })`** — zero-copy, best.
  - `webgl-bridge`: WebGL `texElementImage2D(...element)` → draw to a GL canvas → `copyExternalImageToTexture`.
- **Lifecycle:** the canvas fires an **`onpaint`** event with `changedElements` when a child's rendering changes; `requestPaint()` forces one.
- **Availability:** behind `chrome://flags/#canvas-draw-element` (and/or an origin trial), Chromium-only. `htmlInCanvasMode() === 'none'` everywhere else.

All of this scaffolding **already exists** in `text-effect-engine.ts` (`captureElement`, `setupCanvasForHtmlCapture`, mode detection) and `shape-manager` (canvas attr + helpers). It was wired into `LiveTextNode` and then **switched off**.

---

## 2. Why it was disabled — the exact bug (found)

`LiveTextNode.updateTexture()` ([live-text.ts:509-516](../../src/scene-graph/shapes/live-text.ts#L509)) says the path was removed because the copy extent could exceed the texture and crash. The root cause is a **DPR mismatch** in `captureElement()` ([text-effect-engine.ts:331-359](../../src/renderer/raster/effects/text-effect-engine.ts#L331)):

```ts
const rect = element.getBoundingClientRect();
const dpr = window.devicePixelRatio || 1;          // ← WRONG dpr
const w = Math.ceil(rect.width  * dpr);            // texture sized to window DPR
const h = Math.ceil(rect.height * dpr);
const gpuTex = this.device.createTexture({ size: [w, h], ... });
(queue).copyElementImageToTexture(element, { texture: gpuTex }); // copies at CANVAS backing DPR
```

- The texture is allocated at `elementCSS × window.devicePixelRatio`.
- But `copyElementImageToTexture` rasterizes the element at the **canvas's backing-store DPR** = `canvas.width / canvasCssWidth`.
- **In Salsa these differ.** The WebGPU canvas is a *fixed-resolution illustration canvas* (e.g. 1920×1080 backing) shown at an arbitrary CSS size, so its backing DPR is `1920 / cssWidth` — unrelated to `window.devicePixelRatio`.
- When `backingDPR > windowDPR`, the copy region is **larger than the texture** → `copyElementImageToTexture` validation error → the node's texture is invalid → it disappears.

This is a **sizing bug, not a fundamental limitation.**

---

## 3. The fix

Size the destination texture to the **copy extent**, i.e. the canvas backing DPR — not `window.devicePixelRatio`:

```ts
const canvasRect = layoutsubtreeCanvas.getBoundingClientRect();
const backingDpr = layoutsubtreeCanvas.width / canvasRect.width;   // backing px per CSS px
const w = Math.ceil(rect.width  * backingDpr);
const h = Math.ceil(rect.height * backingDpr);
```

- `captureElement()` must therefore receive the **layoutsubtree canvas** (or its backing DPR) — it currently only gets the element.
- **Reuse the texture**; re-allocate only when `w/h` change (the per-frame `createTexture` is both wasteful and the thing that crashes on size drift).
- **Defensive:** validate the copy region against the texture each frame; if the API accepts a copy `size`/`origin`, pass it and clamp. Worst case, over-allocate slightly and sample a sub-rect.
- **Confirm the coordinate space empirically** (CSS vs backing for the children) by logging captured-vs-allocated size on the first frame — the `backingDpr` formula is the strong hypothesis but the experimental API's exact semantics should be verified, not assumed.

---

## 4. Correct architecture for input + effects

The element must be **positioned**, not just created (the current `_domElement` sets `position:absolute` with **no `top`/`left`** — that breaks both capture alignment and input hit-testing):

- **Source element:** a `contenteditable` div, child of the `layoutsubtree` canvas, positioned at the text's on-canvas location (CSS coords in the canvas's layout space), styled with font/size/color/writing-mode.
- **Input for free:** `layoutsubtree` enables hit-testing, so the element should receive **native focus, keyboard, pointer** → caret, selection, IME, click-to-place. If this works, the **off-screen `<textarea>` hack is deleted**.
- **No double-render (CONFIRMED model):** `layoutsubtree` children are laid out + hit-tested but **never painted to screen — for ANY context, not just WebGPU.** They're invisible by default; you explicitly draw their snapshot into the canvas. So you capture → effect chain → composite via WebGPU, and the user sees only the *effected* texture while clicks/typing land on the invisible-but-hit-testable element. This is the ideal outcome and it's **one canvas** (the source element is a child of the WebGPU canvas itself; a separate host canvas is wrong — the copy primitive operates on children of the canvas you draw from).
- **CRITICAL — the WebGPU copy is TWO steps, done INSIDE `onpaint`.** Unlike 2D's `drawElementImage(el,x,y)` and WebGL's `texElementImage2D(...,el)` (which take the raw element), the buffered WebGPU queue wants a stable snapshot wrapped in a source **dictionary**: `const img = canvas.captureElementImage(el)` → then `device.queue.copyElementImageToTexture({ source: img }, { texture })` (mirrors `copyExternalImageToTexture`'s `{ source }`). Size the texture to **`img.width × img.height`** (the snapshot's own size = the exact copy extent — better than a `getBoundingClientRect × DPR` estimate). The browser snapshots children *just before* the `paint` event, so both calls must run **inside `onpaint`** (drive `canvas.requestPaint()` each frame → `onpaint` → snapshot+copy). Two earlier blank-capture bugs: (1) calling the copy in rAF instead of `onpaint` (stale snapshot); (2) passing the raw element instead of the `captureElementImage` result (the copy throws). **Feature-detect both `HTMLCanvasElement.prototype.captureElementImage` and `GPUQueue.prototype.copyElementImageToTexture`.** Cache the `ElementImage` for unchanging text (re-snapshot only on change/caret-blink).
- **Caret:** if `copyElementImageToTexture` captures the focus caret (and selection highlight) when the element is focused, the caret shows up **inside the effected texture for free**. If it doesn't, derive a caret rect from `Selection`/`Range.getClientRects()` and draw it. Verify which.
- **Live effects:** re-capture on `onpaint`/each animating frame; feed `_currentTexture` through the existing effect chain (already works) → quad.

---

## 5. Open questions — resolve with a 1–2 hour spike before committing

A throwaway test page (or a dev-only Salsa scene) with one `<canvas layoutsubtree>` + one `contenteditable` div + the DPR-fixed `captureElement`:

1. **Does the DPR fix stop the crash** and capture at the right size? ✅ **CONFIRMED** in the spike — backing-DPR sizing copies clean; window-DPR sizing overflows.
2. **Does the copy-in-`onpaint`, one-canvas approach actually fill the texture** in the current Chrome build? (The remaining unknown — the WebGPU path is the least-baked; see below.)
3. **Are children painted to screen or capture-only?** ✅ **Capture-only by design** (children are never auto-painted).
4. **Do children get real focus/keyboard/pointer events** + **is the focus caret captured** by `copyElementImageToTexture`?
5. **Flag/origin-trial + build reality** — shippable to end users or Canary-only? **The WebGPU path's behavior shifted across Chromium ~146–150** (the WICG explainer notes the command-buffer-replay design is solid for 2D and "may be viable for WebGPU with small API additions"). **Record the Chrome version.** If copy-in-`onpaint` is wired correctly and still blank, that's a genuine WebGPU-path maturity issue → file a Chromium bug, and fall back to the **SVG-foreignObject** path (§7, static, no live caret) until it lands.

---

## 6. Implementation plan

1. **Spike** (§5) — de-risk the experimental behavior cheaply.
2. **Fix `captureElement`** — backing-DPR sizing + texture reuse + the canvas param.
3. **Re-enable in `LiveTextNode`** — capture the positioned contenteditable element instead of OffscreenCanvas; remove the off-screen textarea if native input works; keep the element in sync.
4. **Fix the size/scale model regardless** — drop the unit-quad (`_width=_height=1`, size in `scale`) in favor of real `_width/_height` so the standard resize handler works and auto-size grows the box (the squeeze/translate bugs). This is orthogonal to HTML-in-Canvas and worth doing either way.
5. **Graceful fallback** — when `htmlInCanvasMode() === 'none'` (non-Chromium / flag off), fall back to today's **OffscreenCanvas capture** (effects, no live caret) or the **SVG-foreignObject** path (§7). Feature-detect, don't assume.

---

## 7. Fallback reference: SVG foreignObject (robust, non-experimental)

`html-texture-3d.ts` (`setHtmlTexture3D`) already renders HTML → texture the **portable** way: serialize HTML into `<svg><foreignObject>…</foreignObject></svg>`, load it as an `Image`/`ImageBitmap`, draw to a canvas, `copyExternalImageToTexture`. Works in every browser, no flags — but it's a **static snapshot** (no live input, async load, and external/cross-origin resources taint the image). Good as the non-Chrome fallback and for static "text-with-effects," **not** for live editing. Keep it; don't confuse it with the live path.

---

## 8. Summary

The live HTML-in-Canvas path isn't fundamentally broken — it was **disabled by a one-line DPR sizing bug** (texture sized to `window.devicePixelRatio`, copy done at the canvas backing DPR). Fix the sizing, **position** the source element, and `layoutsubtree` should give native input while `copyElementImageToTexture` feeds the effect chain. The unknowns are all about the **experimental API's current behavior** (focus, painting, caret capture, shippability) — cheap to resolve with a spike, and worth doing before the full wiring.
