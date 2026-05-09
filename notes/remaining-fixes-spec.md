# Remaining Fixes Spec — Salsa Engine

**Status: All items resolved as of 2026-05-08. This spec is kept for reference.**

| Item | Resolution |
|---|---|
| Polygon geometry stubs | Fixed — full ear-clipping triangulation in `polygon.ts` |
| GPU cache leak on delete | Fixed — `deallocateCacheEntries()` called inside `deleteSelectedShapes()` |
| Raster selection add/subtract modes | Fixed — `createTempMask()` + `mergeIntoMask()` implemented in `raster-selection-mask.ts` |
| TransformController orphaned code | Fixed — file deleted (chose Option B) |
| Diamond bounding box squared dimensions | Fixed — hack removed from `diamond.ts` |
| Highlight `strokeWidth * 12` magic constant | Fixed — removed from `highlight.ts` |
| Depth buffer TODO in render strategy | Fixed — dead code removed from `webgpu-render-strategy.ts` |

No open items remain from this list.
