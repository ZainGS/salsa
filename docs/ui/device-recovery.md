# GPU device-lost recovery — host guide

A WebGPU device can be **lost** at any time: a driver update or crash, a GPU process restart, the OS reclaiming the GPU
after sleep, or a TDR (a frame that took too long). Without handling, every later frame throws and the canvas stays
black until a reload. Salsa recovers by itself: it gets a new device and rebuilds the document from CPU-side data. The
host only shows the status.

Code: `src/renderer/core/gpu-device-handle.ts`, `src/renderer/core/gpu-device-recovery.ts`,
`src/renderer/core/webgpu-renderer.ts` (§ GPU DEVICE LOSS + RECOVERY), `src/services/persistence/device-recovery-coordinator.ts`,
`src/renderer/raster/gpu-pixel-epoch.ts`, `ShapeManager` (§ GPU device-lost recovery). Tests:
`gpu-device-recovery.test.ts`, `device-recovery-coordinator.test.ts`, `idle-gate.test.ts`, `document-persistence.test.ts`.

## What happens on a loss

1. **Detect.** `device.lost` resolves. The render loop stops (no frame is recorded against the dead device), status →
   `lost`. Saves and exports are gated while the device is lost (they wait; see below).
2. **Leave Play.** Play / UI preview are stopped first; their Stop paths restore the editor state (same rule as saves).
3. **Snapshot.** The normal save gather runs, but every GPU read-back (raster layers, cels, UV-paint / decal textures,
   hand-painted face textures) is taken from the **read-back shadow** (below), because a lost device can't be read.
4. **New device.** One request path for start-up and recovery (`requestSalsaDevice`, same features + limits), retried
   with a backoff (0 / 0.25 / 1 / 3 s). The **device handle** every engine object holds is re-pointed at it, so the ~100
   places that captured `device` (fields and closures) all use the new device without being touched.
5. **Rebuild.** The renderer's own resources (a fresh `Renderer3D` that keeps the camera object, a fresh grease-pencil
   renderer, swept lazy buffers), then the registered owners in order: the 2D render stack rebuilt in place (10), raster
   layer textures re-created blank (40), raster engines (60). Manager caches are reset (texture library, HTML textures,
   cloth sims, lazy raster engines).
6. **Restore.** The snapshot goes through the normal document restore: every mesh, texture, atlas, character, city tile
   and raster pixel re-uploads or regenerates on the new device.
7. **Runtime view.** The camera + orbit pose, City mode, city traffic on/off, UI preview / Player mode are put back.
   City mode is re-entered (with the in-flight build's params when the loss came during the FIRST build, which has no
   marker in the document yet); the pose goes back once the rebuild, the city's orbit controller and (tiled worlds) the
   tile settle are done — except after a loss during the build that ENTERS City mode, where the city's own framing stands.
   A second loss before that keeps the first capture. Status → `ok` with `unrecovered` listing anything that could not come
   back.

Measured (headless drive, private dev server): seed-5 r2 city (2.2 k meshes), 8 losses in a row — each `ok` in 70–185 ms
(the city then rebuilds in the background), 0 uses of a stale GPU object, 0 console / page errors, a screenshot diff
equal to the frame-to-frame noise (0.19–0.36 % of pixels vs 0.21 %), constant listener / pre-render callback counts, the
same GPU allocations per device, and exactly one live `Renderer3D` + one live device after each loss. Tiled r2 world with
HLOD outside tiles and the GPU-driven path, lost right after a re-stream request: 0.39 % diff vs before (noise 0.15 %).
A seed-3 r4 city (5.1 k meshes) recovers in 2.4–4.2 s; a procedural character pixel-identical.

## What comes back, and what doesn't

| Comes back | How |
|---|---|
| 3D meshes, materials, textures, GLB models, the texture library | document restore (CPU data) |
| Characters (body, clothing, hair, face, rig, spring bones) | document restore (regenerated from params) |
| Cities, streamed tiles, HLOD tiles, crowd, traffic | the city rebuilds from its marker; tiles stream back in |
| Raster layers, cels, UV paint, decals, hand-painted faces | the read-back shadow (exact unless edited after it, below) |
| Vector shapes, text, ephemera, packaging, GARP, UI layers | document restore |
| Scene settings (lighting, sky, IBL, fog, SSAO, outlines, post) | document restore |
| GPU-driven path (P15), GPU culling mode, shadow caches (P14), streaming upload ledger (P16) | live inside `Renderer3D` (rebuilt fresh) or in statics (kept); per-session switches (`shadowStaticCache`, PCF tier, frustum culling, distance LOD + scale + bias, ortho screen LOD) are carried to the new renderer |
| Camera pose, orbit, City mode, traffic on/off, UI preview / Player mode | captured before, re-applied after |
| An export or save asked for while lost or recovering | waits, then runs on the restored document |

| Does NOT come back | Why / what to do |
|---|---|
| Play | stopped first (Stop restores the editor state); press Play again |
| HTML textures (`setHtmlTexture3D`) | runtime-only, not document content; listed in `unrecovered` — set them again |
| Live cloth simulations | stopped; listed in `unrecovered` — start them again |
| An active UV-paint session | the controller is dropped; re-enter the tool |
| The Shell UI scene (dashboard) | owned by the host: re-mount it on `ok` |
| Raster / painted-texture edits made after the last read-back | listed in `unrecovered` (see the shadow) |
| Undo history of raster layers | the snapshot stacks lived on the old device; the restored pixels are the new base |

### The read-back shadow

Pixels that exist only on the GPU are kept as a CPU copy, the **shadow**:

- **seeded** blank at start-up and from every document restore (the restored pixels ARE the payload's), so an unedited
  document always recovers exactly — including a blank Background;
- **refreshed** by every save gather (autosave, export) and by a periodic read-back (default every 60 s, only when
  GPU-only pixels changed since the shadow; `sm.setDeviceReadbackShadowInterval(ms)`, 0 = only saves);
- each copy records the **GPU-pixel edit count** (`gpu-pixel-epoch.ts`) it matches. Every undoable raster edit pushes a
  snapshot and bumps the count (paint engines, selection / move / text tools, UV paint), as do undo / redo, direct pixel
  uploads, layer duplicate / merge / composite / resize, and `sm.notifyStrokeEnd()`.

At the loss, if the count has not moved since the shadow, nothing is reported. Otherwise `unrecovered` says
`raster / painted-texture edits made in the Ns before the loss (after the last read-back) are lost` (plus any raster
layer the shadow never saw). Call `sm.refreshDeviceReadbackShadow()` after a big edit to close the window;
`sm.isDeviceReadbackShadowCurrent()` tells whether a loss right now would cost anything.

## Host API (all on `ShapeManager`)

```ts
sm.getDeviceStatus(): {
  status: 'initializing' | 'ok' | 'lost' | 'recovering' | 'failed' | 'unavailable';
  reason: string | null; message: string | null;
  lostCount: number; recoveredCount: number;
  lastLostAt: number | null; lastRecoveredAt: number | null; lastRecoveryMs: number | null;
  gpuName: string | null;
  unrecovered: string[];        // what the last recovery could NOT bring back
};
sm.onDeviceStatusChange(fn): () => void;   // every transition: lost → recovering → ok | failed
sm.onDeviceLost(fn): () => void;           // the 'lost' transition only
sm.recoverDevice(): Promise<boolean>;      // retry (after 'failed', or with auto-recover off)
sm.setAutoRecoverDevice(on: boolean);      // default on
sm.simulateDeviceLoss();                   // TEST: destroys the device (the same path a real loss takes)
sm.refreshDeviceReadbackShadow(): Promise<boolean>;
sm.setDeviceReadbackShadowInterval(ms: number);
sm.isDeviceReadbackShadowCurrent(): boolean;
sm.onPersistDeferred(fn: (info: { kind: 'save' | 'export'; reason: 'play' | 'ui-preview' | 'player' | 'device-lost' }) => void): () => void;
```

`WebGPURenderer.showDeviceOverlays` (static, default true): the engine's own full-canvas overlay for "WebGPU
unavailable" at start-up and "couldn't recover". Set it false before `startWebGPURendering` to show only your own UI.

### Saves and exports while busy

`saveDocument()` / `packProject()` / `exportFrogcart()` asked for during Play, UI preview, Player mode or while the
device is lost **wait** and then run on the editor state (`idle-gate.ts`, `DocumentPersistence.saveNow`). A request
whose gather spans a loss AND recovery (the busy period came and went while it read back pixels) is re-gathered, never
written. A recovery's own restore does not count as "another document" (a waiting export still completes); a real
document load while waiting rejects with `IdleGateStaleError`. `onPersistDeferred` fires once per waiting request.

### Frogmarks (built 2026-10-03, `illustration.component.*`)

- Banner from `sm.onDeviceStatusChange`: **"Graphics device was reset — recovering…"** while lost / recovering →
  **"Recovered."** for 2.5 s (8 s with a Dismiss button when `unrecovered` is not empty, listing it) → or **"Couldn't
  recover the graphics device — reload."** with a **Reload** button on `failed`.
- Toast from `sm.onPersistDeferred`: "Export will finish when you stop Play" (save / export × Play / UI preview /
  Player mode / device recovery).

## Verifying

`scratchpad/pupdrive/robust/devlost2.js` (headless Chrome, `--enable-unsafe-webgpu`) against a no-HMR dev server.
Phases: `repeat N` (N losses in a row: heap, live renderers / devices via a FinalizationRegistry, per-device GPU
allocations, listeners, pre-render callbacks, screenshot diff vs the pre-loss frame, stale-object uses), `play`,
`build` (loss mid city build), `stream` (loss mid tile streaming), `save` (loss racing an export; save + export asked
for while lost), `cfg` / `cfgcity` (every `Renderer3D` getter / primitive field before vs after). The instrumentation
tags every GPU object with its device and records each use with another device's object.
