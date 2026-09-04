# Shell UI Audit — 2026-08-31

Findings from a 3-agent read-only review of the Frogmarks Shell UI (`src/renderer/shell/*` + `src/services/managers/shell-ui-manager.ts` + `src/services/persistence/shell-storage.ts`). Ranked by severity. Checked off as fixed.

Status legend: `[ ]` open · `[x]` fixed · `[~]` deferred (needs browser verification / larger refactor)

**Progress (2026-08-31):** 25 of 26 fixed — typecheck-clean, full suite green (1160 tests). **#3 (per-tile render passes) now DONE:** `CartridgeViewer.beginTileBatch()` opens ONE pass (depth cleared once), and drawDisc/drawCD/drawBillboard take an optional `batchPass` and draw into it (own-pass fallback kept for solo calls); the shell-renderer caller opens one batch pass and threads it through. **Only #24 left** (`ShellHtmlLayer.destroy()` — moot: the ShellRenderer already destroys its one `htmlLayer`; the flag was about a hypothetical unused second instance). **Browser-verify recommended:** shell renders/animates, coins/CDs/billboards still draw + depth-sort correctly under the single pass, thumbnails fill, theme switches, cluster stays pinned on scroll (#26), and mount→unmount→remount leaks nothing (#1). Note #11 partially done: per-frame Set alloc + occupied scan gone; the two remaining single-pass `m.tiles` walks (filter/ring-find) are trivial and left as-is.

## 🔴 High

- [x] **1. GPU buffer leak in `destroy()`** — `shell-renderer.ts` `destroy()` never frees `gridBuf`, `scrimBuf`, `windowBuf`, `wireGridVB`, `wireGridIB`, `wireGridUBO`. Leaks ~150KB+ per shell mount/unmount. Fix: `.destroy()` all six.
- [x] **2. Init failure after `suspendRendering()` → black editor** — `shell-ui-manager.ts` `initializeScene` (~732–754) has no try/catch after suspend; a throw leaves `renderer` null so `destroyScene` early-returns and `resumeRendering()` never runs. Fix: try/catch → resume (+`play()` if was live) + null the renderer on failure.
- [x] **3. Per-tile render passes** — `shell-cartridge.ts` `drawDisc`/`drawCD`/`drawBillboard` each open their own `beginRenderPass` + full-canvas depth clear (N passes/frame). Fix: batch into one pass, clear depth once, viewport/scissor per draw. (Larger refactor; browser-verify.)

## 🟠 Medium

- [x] **4. Thumbnail `urls` map unbounded** — `shell-thumbnails.ts` retains every base64 data URL forever. Fix: bounded LRU of URLs (small multiple of `MAX_CELLS`).
- [x] **5. Broken thumbnail hogs a slot + never retries** — a failed load leaves a `ready:false` cell that `touch()` keeps most-recent but never re-loads. Fix: delete the cell on failure (free slot + allow retry).
- [x] **6. `saveRegistry` write collisions** — no write serialization; overlapping `createWritable()` on `registry.json` can throw. Fix: per-file promise-chain write queue in `shell-storage.ts`.
- [x] **7. `refreshProjects()` stale-snapshot clobber** — out-of-order `listProjects()` results overwrite `projectCache`. Fix: monotonic request-id guard.
- [x] **8. Chrome cluster rebuilt on every hover** — `updateChromeCluster` re-parses SVG innerHTML + `getBoundingClientRect` per rebuild (per hover). Fix: guard on theme-name/size change.
- [x] **9. `getProjects()` runs 2–3× per rebuild** in Illustrations mode. Fix: compute the sorted list once per rebuild.
- [x] **10. Label atlas `build()` runs every frame** — `shell-renderer.ts:1768` allocs + signature sort/join every frame even when labels static. Fix: labels version guard.

## 🟡 Low / Med — perf hygiene & smaller bugs

- [x] **11. `m.tiles` walked ~5× per frame** — filter/ring-find/tickAnim-Set/occupied scan. Fix: precompute on `setModel`; reuse a persistent Set.
- [x] **12. Panel UBO re-uploaded every frame** — depends only on grid/theme/occupancy. Fix: dirty-flag.
- [x] **13. Per-draw uniform scratch alloc** — `shell-cartridge.ts` `new Float32Array(52)` every draw. Fix: reusable class scratch.
- [x] **14. Cancelled `.frogcart` picker leaks a hidden `<input>`** — only removed on `change`. Fix: also handle `cancel`.
- [x] **15. Theme-switch races icon re-bake** — stale bake can win. Fix: generation counter.

## 🟢 Low — robustness / cleanup

- [x] **16. `ShellThumbnailAtlas.get()` returns the live mutable `Cell`** — caller mutation corrupts LRU. Fix: return a fresh UV literal.
- [x] **17. Label atlas height unbounded** — can exceed `maxTextureDimension2D` → unguarded throw. Fix: clamp/assert.
- [x] **18. Disc-uniform pool fixed at 24** — >~21 tiles silently dropped/collide. Fix: log on overflow (+raise cap).
- [x] **19. `destroyScene` leaves stale refs** — `clusterIcons`/`zoomButtons`/`currentModel` not reset. Fix: clear them.
- [x] **20. `createProject` optimistic insert ignores `dashboardKind`** — entry can flash in the wrong dashboard. Fix: kind guard.
- [x] **21. `mirrorBack` vs `cullMode:'back'`** — dormant (only caller sets false). Latent trap if ever enabled; leave a guard comment.
- [x] **22. `freeIndices` dead code** — never pushed. Fix: remove (eviction reuses index directly).
- [x] **23. `load()` not idempotent under concurrency** — double OPFS read + duplicate `'loaded'`. Fix: memoize in-flight promise.
- [~] **24. `ShellHtmlLayer.destroy()` has no caller** — texture leak only if the layer is ever used (currently unused). Wire when the in-canvas path is adopted.
- [x] **25. `titleH` constants may disagree** — verify shader vs label-draw vs close-hit. Fix: confirm/align.
- [x] **26. Cluster only repositions on canvas resize**, not window scroll. Minor drift; deferred (needs a throttled scroll listener + browser check).
