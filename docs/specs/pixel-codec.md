# Pixel Codec — Configurable Layer Compression
**Status:** ✅ Implemented (June 2026)  
**Date:** 2026-06-08

> `encodePixels` / `decodePixels` live in [pixel-codec.ts](../../src/services/persistence/pixel-codec.ts)
> and are wired into both `document-persistence.ts` (OPFS auto-save) and `project-package.ts`
> (`.frogmarks` export). `sm.getPixelFormat` / `setPixelFormat` / `isPixelFormatSupported` are on
> ShapeManager; `'png'` is the `AutoSaveConfig` default with v2 backwards-compat. UI: [storage-settings.md](../ui/storage-settings.md).

---

## Problem

Raster layer pixel data is currently written to OPFS as raw uncompressed RGBA bytes:

```
1920 × 1080 × 4 bytes = 8,294,400 bytes ≈ 8.3 MB per layer
```

A simple scene with one blank raster layer costs ~8 MB. Scenes with multiple layers or animation cels (each a full-canvas snapshot) scale linearly. Observed sizes in practice: **8–20 MB for scenes with no raster painting at all**.

The `AutoSaveConfig` interface already has a `pixelFormat: 'raw' | 'webp'` field, and the manifest layout already exists — but the encoding path was never implemented. This spec completes it and expands the format options.

---

## Solution

Add a **pixel codec** that encodes layer/cel pixel data to a compressed image format before writing to OPFS, and decodes it back to raw RGBA on load. The codec is:

- **Per-document** — stored in the manifest so the load path always knows how to decode.
- **Configurable by the user** in Advanced Settings.
- **Lossless only** for the working/editable file — lossy compression on autosave would degrade artwork on every save cycle.
- **Uniformly implemented** via the browser's native `OffscreenCanvas.convertToBlob` (encode) and `createImageBitmap` (decode) — same code path for all formats, just a different MIME type.

---

## Format Options

| Value | MIME type | Typical size (1080p blank) | Encode speed | Notes |
|-------|-----------|---------------------------|--------------|-------|
| `'raw'` | — | 8.3 MB | Instant | No encode/decode overhead. Keep as debug/escape hatch. |
| `'png'` | `image/png` | 5–50 KB (blank), 500 KB–2 MB (painted) | ~100–200 ms | **Recommended default.** Guaranteed lossless, universally supported, trivial decode. |
| `'webp'` | `image/webp` | 3–30 KB (blank), 300 KB–1.5 MB (painted) | ~50–100 ms | **Experimental.** `convertToBlob` losslessness is not guaranteed across browsers — round-trip test before relying on it for working files. |
| `'avif'` | `image/avif` | 2–20 KB (blank), 200 KB–1 MB (painted) | ~500 ms–2 s | **Export/archival only.** Best compression; too slow for autosave. Not exposed as an autosave option in the UI. |

> **Lossless requirement:** Working file formats must be byte-perfect lossless. PNG is the only format that guarantees this unconditionally. WebP lossless output from `convertToBlob` is browser-dependent — it **must be round-trip tested** (encode → decode → compare) before being promoted out of experimental. AVIF is excluded from autosave entirely due to encode latency.

> **On `quality: 1.0` for WebP:** Some sources suggest this produces lossless output, but the WebP spec and browser implementations do not guarantee it. The only safe way to confirm losslessness is empirical round-trip testing. Until that test is written and passing, `'webp'` is labelled Experimental in the UI.

---

## Architecture

### New file: `src/services/persistence/pixel-codec.ts`

```typescript
export type PixelFormat = 'raw' | 'png' | 'webp' | 'avif';

const MIME: Record<PixelFormat, string | null> = {
  'raw':  null,
  'png':  'image/png',
  'webp': 'image/webp',
  'avif': 'image/avif',
};

const EXT: Record<PixelFormat, string> = {
  'raw':  'bin',
  'png':  'png',
  'webp': 'webp',
  'avif': 'avif',
};

/** Returns the file extension to use for a layer file in this format. */
export function pixelFormatExtension(format: PixelFormat): string {
  return EXT[format];
}

/**
 * Encode raw RGBA bytes to the target format.
 * Returns the original ArrayBuffer unchanged for 'raw'.
 */
export async function encodePixels(
  rgba: ArrayBuffer,
  width: number,
  height: number,
  format: PixelFormat,
): Promise<ArrayBuffer> {
  if (format === 'raw') return rgba;
  const mime = MIME[format]!;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvas.convertToBlob({ type: mime });
  return blob.arrayBuffer();
}

/**
 * Decode any supported image format back to raw RGBA bytes.
 * For 'raw', returns the buffer unchanged.
 */
export async function decodePixels(
  data: ArrayBuffer,
  format: PixelFormat,
): Promise<{ rgba: ArrayBuffer; width: number; height: number }> {
  if (format === 'raw') {
    // Width/height not encoded in raw — caller must supply from manifest.
    return { rgba: data, width: 0, height: 0 };
  }
  const blob = new Blob([data], { type: MIME[format]! });
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;   // read before close()
  const height = bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();               // close before getImageData — no longer needed
  const imageData = ctx.getImageData(0, 0, width, height);
  return { rgba: imageData.data.buffer, width, height };
}

/**
 * Check whether a format is supported by this browser.
 * Used to filter Advanced Settings options.
 */
export async function isFormatSupported(format: PixelFormat): Promise<boolean> {
  if (format === 'raw' || format === 'png') return true;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const blob = await canvas.convertToBlob({ type: MIME[format]! });
    return blob.size > 0;
  } catch {
    return false;
  }
}
```

---

### Changes to `document-persistence.ts`

**1. Expand `AutoSaveConfig.pixelFormat`:**

```typescript
// Before:
pixelFormat: 'raw' | 'webp';

// After:
pixelFormat: PixelFormat;  // 'raw' | 'png' | 'webp' | 'avif'
```

**2. Change the default from `'raw'` to `'png'`:**

```typescript
const DEFAULT_CONFIG: AutoSaveConfig = {
  intervalMs:        30_000,
  strokeDebounceMs:  5_000,
  pixelFormat:       'png',   // ← was 'raw'
};
```

**3. Store `pixelFormat` in the manifest:**

Add `pixelFormat?: PixelFormat` to `DocumentManifest`. Absence means `'raw'` (migration default for old saves).

**4. Encode on write, decode on load:**

In `writeToOPFS`, encode each layer/cel before writing. Use a format-specific extension so the files are human-readable when inspecting OPFS directly:
```typescript
const fmt = this.config.pixelFormat;
const ext = pixelFormatExtension(fmt);
const encoded = await encodePixels(
  layer.pixelData, manifest.canvasWidth, manifest.canvasHeight, fmt,
);
await this.writeBinary(layersDir, `${layer.id}.${ext}`, encoded);
```

The manifest is authoritative for format detection on load — the extension is just for human debugging. In `loadDocument`, try the correct extension first, fall back to `.bin` for old saves:
```typescript
const format: PixelFormat = (manifest.version >= 3 && manifest.pixelFormat)
  ? manifest.pixelFormat
  : 'raw';
const ext = pixelFormatExtension(format);
// Try new extension, fall back to legacy .bin
const pixels = await this.readBinary(layersDir, `${entry.id}.${ext}`)
  ?? await this.readBinary(layersDir, `${entry.id}.bin`);
const { rgba } = await decodePixels(pixels, format);
layers.push({ id: entry.id, pixelData: rgba });
```

---

## Manifest Versioning & Migration

| Manifest version | `pixelFormat` field | Decode behavior |
|-----------------|---------------------|-----------------|
| 2 (existing saves) | absent | Treat as `'raw'` — pass bytes directly to GPU |
| 3 (new saves) | present | Use `decodePixels` with the stored format |

Version bump: `version: 2` → `version: 3` in `DocumentManifest`. The load path checks:

```typescript
const format: PixelFormat = (manifest.version >= 3 && manifest.pixelFormat)
  ? manifest.pixelFormat
  : 'raw';
```

No migration of existing files is needed — old saves remain `'raw'` and load correctly forever.

---

## Cloud Export Use Case

The working file format (`pixelFormat` in `AutoSaveConfig`) is optimized for **autosave speed** — `'png'` or `'webp'` are appropriate defaults.

For **cloud upload / archival export**, a separate encode step can re-compress to `'avif'` at upload time regardless of the working format:

```typescript
// In a future cloud export path:
const cloudPayload = await reencodePayload(localPayload, 'avif');
await uploadToCloud(cloudPayload);
```

This means the user gets fast local autosave AND maximum compression for cloud storage without any tradeoff. The `pixel-codec.ts` utility is reusable for this path.

---

## ShapeManager API additions

```typescript
/** Get the pixel format currently used for this document's saves. */
sm.getPixelFormat(): PixelFormat;

/** Change the pixel format for future saves of this document. */
sm.setPixelFormat(format: PixelFormat): void;

/** Check whether a given format is supported by the current browser. */
sm.isPixelFormatSupported(format: PixelFormat): Promise<boolean>;
```

---

## Advanced Settings UI (Frogmarks-side)

Add a **Storage** section to Advanced Settings:

```
• STORAGE

  Layer compression
  ○ Raw          Fastest saves, largest files (~8 MB/layer)
  ● PNG          Recommended — lossless, ~10–50× smaller, universal  ← default

  ▸ Experimental (may vary by browser)
  ○ WebP         Smaller than PNG, fast encode — round-trip accuracy not guaranteed

  Current document size: 9.6 MB
```

AVIF is not shown as an autosave option — it is only used internally for cloud/export re-encoding. If a user's document was somehow saved as `'avif'` (e.g. via direct API call), the load path still handles it correctly; it simply isn't offered in the UI for autosave.

**Behaviour:**
- Changing the format takes effect on the **next save** — no re-encode of existing data on change.
- Setting is per-document, persisted in the manifest.
- Grayed options: check `sm.isPixelFormatSupported(format)` on panel open; grey out unsupported formats with a note.
- Show current document OPFS size (the recursive directory size from `salsa-documents/local-{uuid}/`) next to the options as a reference point.

---

## Implementation Phases

| Phase | What | Salsa or Frogmarks |
|-------|------|--------------------|
| **1 — Core codec** | `pixel-codec.ts` with `encodePixels` / `decodePixels` / `isFormatSupported` | Salsa |
| **2 — Wire into persistence** | Encode on write, decode on load, manifest v3, default `'png'` | Salsa |
| **3 — ShapeManager API** | `getPixelFormat`, `setPixelFormat`, `isPixelFormatSupported` | Salsa |
| **4 — Advanced Settings UI** | Storage section, format picker, size display | Frogmarks |
| **5 — Cloud re-encode** | `reencodePayload` utility for AVIF cloud export | Salsa (future) |

Phases 1–3 are pure Salsa engine changes. Phase 4 is Frogmarks-side. Phase 5 depends on the cloud storage feature being built.

---

## Out of Scope

- **Lossy compression** for working files — not offered, degrades artwork on each save cycle.
- **Per-layer format** — one format per document is sufficient; per-layer adds complexity with no clear benefit.
- **Re-encoding existing saves** — old `'raw'` saves load correctly forever via the migration default. No conversion tool needed.
- **Streaming encode** for very large canvases — `OffscreenCanvas.convertToBlob` handles this natively.
