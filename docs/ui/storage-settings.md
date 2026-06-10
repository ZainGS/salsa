# Frogmarks — Storage Settings UI
**Last Updated:** 2026-06-08

Exposes the pixel codec setting introduced in the Salsa pixel-codec feature. Add a **Storage** section to the app's Advanced Settings panel (or equivalent settings surface).

---

## API quick reference

```typescript
// Get current format for this document.
const fmt = sm.getPixelFormat();
// → 'raw' | 'png' | 'webp' | 'avif'

// Change format (takes effect on next save).
sm.setPixelFormat('png');

// Check browser support before showing an option.
const supported = await sm.isPixelFormatSupported('webp');
// → true | false
```

---

## Panel layout

```
• STORAGE

  Layer compression
  ○ Raw    Fastest saves, ~8 MB per layer — no compression
  ● PNG    Recommended — lossless, ~10–50× smaller            ← default
  ○ WebP   Smaller than PNG — experimental, browser-dependent

  Current document size: 9.6 MB
```

**Notes:**
- `Raw` and `PNG` are always available. `WebP` only appears if `sm.isPixelFormatSupported('webp')` returns `true`.
- `AVIF` is intentionally not shown — it is reserved for cloud/export re-encoding and is too slow for autosave.
- The "Current document size" line uses the recursive OPFS directory size for `salsa-documents/local-{uuid}/` (Frogmarks already has this from the file size feature).
- Changing the format takes effect on the **next save** — no immediate re-encoding. A small note ("takes effect on next save") below the picker avoids confusion.

---

## Initialization

On settings panel open:

```typescript
// 1. Read current format to pre-select the right radio.
const currentFmt = sm.getPixelFormat();

// 2. Probe browser support to conditionally show WebP.
const webpSupported = await sm.isPixelFormatSupported('webp');

// 3. Render options accordingly.
renderFormatPicker({ currentFmt, webpSupported });
```

On format radio change:

```typescript
sm.setPixelFormat(selectedFormat);
// Optionally trigger a save immediately so the new format is used right away:
// await sm.saveDocument();
```

---

## Types

```typescript
import type { PixelFormat } from '@zaings/salsa';
// PixelFormat = 'raw' | 'png' | 'webp' | 'avif'
```
