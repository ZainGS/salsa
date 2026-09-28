# Salsa → Frogmarks update (audit fixes, 2026-09-28)

Running handoff for everything from the 2026-09-28 audit fix pass that Frogmarks should know about. Full engine-side
detail: [../audit-2026-09-28.md](../audit-2026-09-28.md).

**TL;DR — action items for Frogmarks**

1. **Show a "saving paused" notice** when `sm.getSaveBlockedReason()` is non-null (details below). Without it, a
   partially-failed load silently stops autosave and the user won't know.
2. **Remove the `(shapeManager as any)` casts** (~400) so renames break at compile time — see T6 in the audit doc.
   Not urgent, but must land before Salsa prunes unused public methods (audit A2).
3. Nothing else is required — every other change below is automatic. Re-test the flows in *Please verify*.

---

## New APIs

| API | What it's for |
|---|---|
| `sm.getSaveBlockedReason(): string \| null` | Non-null = autosave is **paused** because the last document load failed or partly failed (saving would overwrite the good copy on disk with a partial scene). Show it to the user. |
| `sm.getLastRestoreIssues(): RestoreIssue[]` | Every step that failed during the last load. `RestoreIssue = { area: string; message: string; blocksSave: boolean }` (type exported from the package). Empty = clean load. |
| `sm.clearSaveBlock(): void` | Re-enable saving after a failed load — e.g. the user picks "Keep what loaded" in the notice. |

**Suggested UI:** after `loadDocument` / `unpackProject`, if `getSaveBlockedReason()` is set, show a banner: *"Some
parts of this document didn't load (…areas…). Autosave is paused so your saved copy isn't overwritten."* with
**[Keep what loaded & resume saving]** → `clearSaveBlock()`, and **[Reload]**. List `getLastRestoreIssues()` areas.
Note: an explicit `saveDocument()` also returns `false` while blocked.

## Behaviour changes (automatic — no code needed)

- **Saving is fenced off during a document load.** Autosave, the stroke-debounced save, and explicit `saveDocument()`
  all skip while a load is in progress (a pending debounced save is cancelled). Previously an autosave firing
  mid-load wrote the half-loaded new doc into the *previous* doc's folder.
- **`.frogmarks` format v2.** `packProject()` now writes exactly what autosave writes (it used to drop UV/face/garment
  paint, baked parts, GARP pools, packaging). `unpackProject()` restores through the normal load path. **Old v1
  `.frogmarks` files still import.** A file from a newer Salsa build is refused with an error.
  - `packProject()` no longer marks the scene as saved — the next autosave still writes everything.
- **Opening a doc no longer inherits the previous doc's state** — character rigs, CD kits, GARP pools, UI layers,
  loaded GLB models, kitbash character groupings, and global scene settings (fog/PS1/SSAO/…) are cleared/reset first.
  A doc with no 3D now clears the previous doc's 3D.
- **GARP pools and UI state machines now actually save to OPFS** (they were silently lost on reload before).
- **Kitbash character groupings now save with autosave** (only `.frogmarks` had them before).
- **Undo history is cleared on load** for 2D shapes too (Ctrl+Z after opening a doc could replay the previous doc).
- `enableAutoSave(...)` called again now stops the previous autosave instead of leaving it running.
- **Dependency security:** Salsa's `fflate` (zip) is now 0.8.3, which fixes an infinite loop on crafted ZIP64 files —
  relevant because `.frogmarks` / `.frogcart` imports parse user-supplied zips. `npm audit` on Salsa is now clean.
- `setSceneGraphJSON(json, opts?)` gained an optional `{ rethrow?: boolean }` (default behaviour unchanged).
- **Documents are now versioned** (`manifest.schemaVersion`). If a document was saved by a NEWER Salsa build than the
  one running (e.g. a stale cached build, or a second tab on an older build), it still opens, but **saving is
  blocked** — `getSaveBlockedReason()` explains it ("saved by a newer version of Salsa…"). Show the same notice as
  for a failed load; for this case the right advice is **"reload to get the latest version"** rather than "keep what
  loaded" (don't offer `clearSaveBlock()` — it would overwrite the newer data).
- **Autosave now also saves when the tab is hidden or closed** (`visibilitychange` / `pagehide`) — previously up
  to 30s of 3D/vector edits were lost on close. No wiring needed; it's attached by `enableAutoSave`.
- **Saves no longer overlap**: `saveDocument()` while an autosave is writing now waits for it, and saves hold a
  per-document Web Lock so two tabs on the same doc can't interleave writes. (Two tabs editing the SAME doc is still
  last-writer-wins — consider warning the user if Frogmarks can detect it.)
- **Replacing a library texture with a raw one no longer reverts on reload** (the stale library link re-bound the
  old texture); a normal-map flag with no map behind it is dropped on load.
- **Multi-material meshes (submesh slots) now save** — per-slot materials used to reset on reload.
- **Autosave pauses during UI preview (`setUIInteractive(true)`) and Player mode**, like it already did in Play mode,
  so a scrubbed/playing animation pose can't be saved over the authored one. It resumes when preview ends; an
  explicit `saveDocument()` still works during preview.

## Please verify in the browser

- Open doc A, draw, immediately open doc B → A and B are each intact after reload.
- Open a doc with an imported GLB, make one 2D stroke, wait for autosave, reload → the GLB is still there.
- Author a GARP skin variant / a UI state machine, reload → it's still there.
- Export `.frogmarks` from a character doc with UV paint + face → import into a fresh doc → paint, face, clothing all
  come back; procedural/city content isn't duplicated as loose meshes.
- Import an OLD `.frogmarks` file → loads as before.
- Open a doc with characters, then one without → the second has no leftover rigs/clothes.
- Hover outline on any mesh (not just the first) is positioned correctly (silhouette shader fix).
- (Hard to trigger by hand) a doc whose manifest has a higher `schemaVersion` opens read-only with the notice.
- Edit something in 3D, then close the tab within a few seconds → reopen → the edit is there.
- Give a mesh 2+ material slots with different materials, reload → the slots and materials are kept.
- Preview a UI machine that plays/seeks an animation, wait >30s, stop preview, reload → the character is in its
  authored pose, not the scrubbed one.
