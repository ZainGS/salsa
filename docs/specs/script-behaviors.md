# Script Behaviors — custom per-object game logic

**Date:** 2026-09-17 · **Status: S1–S4 BUILT 2026-09-27/28 — full engine + editor aids + host doc. Only the QuickJS
sandbox + real spawn/animation remain (the "Later" items). Play integration is browser-unverified.**

**S4 shipped** (+2 tests, 1546 total): `src/services/scripting/script-context-dts.ts` — `SCRIPT_CONTEXT_DTS` (ambient
`.d.ts` string mirroring ScriptContext + hooks, for Monaco extraLib IntelliSense; keep in sync with script-types.ts, a
test compiles the snippets to catch example drift) + `SCRIPT_SNIPPETS` (Spinner / Patrol / Follow player / Proximity
switch / Interactable counter — each compiles clean, uses only applied verbs). Facade: `sm.getScriptContextTypes3D()` +
`sm.getScriptSnippets3D()`. Host guide: `docs/ui/script-behaviors.md` (Behavior inspector: Monaco + extraLib + snippet
picker + inline `validateScript3D` errors + outliner script icon; coexistence w/ UI machine; v1 limits; browser-verify).

**S2 shipped** (+8 runner tests, 1544 total): `ScriptRunner` (`src/services/scripting/script-runner.ts` — compiles+instantiates enabled behaviors on start→onStart, `tick(dt)`→onTick, `fireTrigger`/`fireInteract` route to the matching node; ★per-hook try/catch error isolation: a behavior disabled after `maxStrikes` (default 3) throws, surfaced via `onError`, never crashes the loop; compile errors skip that instance). Wired into scene3d-manager Play: `_buildScriptAdapter()` (real `ScriptSceneAdapter` — transforms via setPosition3D/setRotation3D, raycast via MeshPicker, input snapshot from merged Play input, `now` from Play start; **play/stop + spawn deferred v1**, **destroy hides + restores on Stop** = non-destructive); runner `start()` on enterPlayMode3D (guarded on `_scriptManager.size>0` → zero cost when unused), `tick(dt)` in the fixed loop, `stop()` + un-hide on exit; trigger/interact events also route to scripts. **var/emit bridge**: ShapeManager wires `setScriptVarBridge` → active UI layer's `getUIVariable`/`setUIVariable` + `ui.emitCustom` (scripts ↔ UI machine share vars). **S3 bits done early**: persistence `GlobalScene3DSettings.scriptBehaviors` (get + restore, restore clears stale first) + `validateScript3D`. Facade on both scene3d + ShapeManager: `setScriptBehavior3D`/`get`/`remove`/`setScriptEnabled3D`/`listScriptBehaviors3D`/`validateScript3D`. **NEXT: S4** — `getScriptContextTypes3D` (.d.ts string for editor IntelliSense) + `docs/ui/script-behaviors.md` host panel + snippet templates. (drive-scripts Node harness skipped — the live Play loop needs a GPU/canvas; the ScriptRunner vitest suite covers patrol/error-isolation/var-handoff instead.)

**S1 shipped** (`src/services/scripting/`, +20 tests, 1536 total): `sucrase` dep added; **ScriptCompiler**
(`script-compiler.ts` — TS→JS via `transform(..., ['typescript','imports'])` → `new Function('exports','require','module',…)`
factory, collects `onStart/onTick/onTrigger/onInteract` from `exports` OR bare top-level fns, cached by source text,
compile/module-eval errors captured never thrown, `require` hard-disabled so a *used* import throws at load while an
unused one is stripped); **ScriptContext** factory (`script-context.ts` — derived math move/moveLocal/lookAt/distanceTo
over a `ScriptSceneAdapter` seam; ★yaw about +Y, local forward +Z = `(sin,0,cos)`); **ScriptBehaviorManager**
(`script-behavior-manager.ts` — nodeId-keyed set/get/remove/enable/list/serialize/restore); types in `script-types.ts`.
Per-instance state = the runner calls hooks with `.call(stateBag,…)`. **Next: S2** (Play-loop hooks + a
ShapeManager-backed `ScriptSceneAdapter` + error isolation + drive-scripts harness).
**Origin:** the state machine (triggers→actions→states) covers game *flow*, but not open-ended per-object
behavior — a patrolling enemy, a homing projectile, a grappling hook, spawn waves, damage formulas. That
ceiling is what makes a bare scene "just a walking sim." This adds **behavior scripts** attached to scene
objects: the open-ended layer, coexisting with the state machine (scripts do custom logic; the machine does
flow/UI — like Unity's prefabs *and* scripts). Play-mode only, non-destructive.

## 0. Language decision: author TS, run JS

The browser executes **JS** — that's the runtime, non-negotiable. The only choice is the *authoring*
language, and it's **TypeScript**, because:
- Editor autocomplete + type-checking against the behavior API catch the errors a beginner hits most
  (wrong method name, wrong arg) *before* running — the single biggest ergonomics win.
- We ship a **`.d.ts`** describing the `ScriptContext`/API surface; a Monaco editor (or any TS-aware editor)
  gives full IntelliSense from it.
- To run, **strip the types** with `sucrase` (tiny, pure-JS, ~ms per script — no wasm, no full `tsc`).
  Type errors surface in the editor but do NOT block running by default (author's call; a "strict" toggle
  can gate Play on a clean typecheck later). Plain JS also works (TS is a superset), so a user can ignore
  types entirely.

So: **TS in, JS out.** The runtime, sandbox, and API are identical either way; TS is purely the nicer pen.

## 1. What already exists to build on (don't rebuild)

| Piece | Where | Role for scripts |
| --- | --- | --- |
| Play loop (fixed timestep) | `game/game-loop.ts`, Scene3DManager Play | `onTick(dt)` hangs off this tick |
| Character controller + input | `game/character-controller.ts`, `setPlayInput3D` | `ctx.input`, player-driven scripts |
| Trigger volumes + interact | `game/trigger-volumes.ts`, `game/interaction.ts` | route to `onTrigger` / `onInteract` |
| Transform snapshot/restore on Play enter/exit | Scene3DManager `_snapshotTransforms`/`_restoreTransforms` | scripts mutate freely in Play; **all reverts on Stop** (non-destructive, no new work) |
| Animation Library + `playSkeletonClipBlended` | animation-library.ts, scene3d-animation | `this.play(clip, {blend})` |
| UI machine variables (incl. `player.*`) | ui-manager/ui-state-machine | scripts share `getVar`/`setVar` with the machine → they compose |
| MeshPicker raycast | scene3d picker | `ctx.raycast()` |

Scripts are **not** a parallel engine — the API wraps these.

## 2. Model

### 2.1 The component

A **ScriptBehavior** is attached to a scene node (Mesh3D / MeshGroup3D / SkinnedMesh3D / emitter):

```ts
interface ScriptBehavior {
  nodeId: string;      // the object this drives
  source: string;      // TS/JS text the user authored
  enabled: boolean;    // toggle without deleting
  name?: string;       // for the outliner/inspector
}
```

Stored in a **manager map keyed by nodeId** (like the animation library / packaging registries), NOT baked
into each node's `toJSON` — keeps node serialization untouched and lets a script reference a node that
regenerates.

### 2.2 The script shape

The source defines lifecycle hooks — either top-level functions or a returned object. It's compiled once
(cached by source hash) into a factory that, given the API, returns the hooks:

```ts
// author writes (TS):
export function onStart(ctx: ScriptContext) { this.speed = 2; }        // `this` = per-instance state bag
export function onTick(ctx: ScriptContext, dt: number) {
  ctx.moveLocal(0, 0, this.speed * dt);                                // walk forward
  if (ctx.distanceTo(ctx.playerId) < 1) ctx.setVar('caught', true);
}
export function onTrigger(ctx: ScriptContext, e: { type: 'enter'|'exit'; id: string }) { … }
export function onInteract(ctx: ScriptContext) { … }
```

- **Per-instance state** lives on `this` (a plain object created per scripted node per Play run). Natural JS
  closures/fields — `this.health = 100`. Reset each Play (runtime state; the SOURCE persists, state does not
  — save-points are future work).
- All hooks optional. A pure-`onTick` mover needs one function.

### 2.3 The API (`ctx: ScriptContext`) — curated + stable

This is the **contract** (the expensive, forever part — designed small on purpose; NOT raw `ShapeManager`):

```ts
interface ScriptContext {
  // identity
  readonly id: string;               // this behavior's node id
  readonly playerId: string | null;  // the bound Player avatar, if any

  // transform (self)
  pos(): [number, number, number];
  setPos(x: number, y: number, z: number): void;
  move(dx: number, dy: number, dz: number): void;        // world delta
  moveLocal(dx: number, dy: number, dz: number): void;   // relative to own yaw
  rotateY(rad: number): void;
  setYaw(rad: number): void;
  lookAt(x: number, y: number, z: number): void;

  // animation (via the Animation Library / skeleton)
  play(clip: string, opts?: { loop?: boolean; blend?: number }): void;
  stop(): void;

  // scene queries
  find(id: string): NodeHandle | null;      // opaque handle, not the raw node
  posOf(id: string): [number, number, number] | null;
  distanceTo(id: string): number | null;
  raycast(origin: [number,number,number], dir: [number,number,number], maxDist?: number): { id: string; point: [number,number,number] } | null;

  // spawn / destroy (v1: clone an existing node as a template)
  spawn(templateId: string, pos: [number,number,number]): string | null;
  destroy(id: string): void;

  // variables — SHARED with the UI state machine (scripts + flow compose)
  getVar(name: string): number | string | boolean | null;
  setVar(name: string, v: number | string | boolean): void;

  // input (for player-controlled scripts)
  readonly input: { forward: number; right: number; jump: boolean; lookYaw: number; lookPitch: number; interact: boolean };

  // events (fires an `emitEvent`-style signal into the UI machine)
  emit(event: string): void;

  // time / util
  readonly time: number;   // seconds since Play start
  readonly dt: number;     // last tick seconds (also passed to onTick)
}
```

Every method wraps something that already exists. The surface is intentionally ~25 verbs; grow it
deliberately (each addition is a permanent contract). `NodeHandle` is a thin `{ id, pos(), setPos(), … }`
so scripts never touch engine internals.

### 2.4 Execution + lifecycle

- Scripts run **only in Play mode.** Edit mode never executes user code (safety + the snapshot/restore model
  already makes Play mutations non-destructive — Stop reverts everything).
- On Play enter: compile (if source changed), instantiate each enabled behavior's hook object + fresh
  `this`, call `onStart`. Each fixed tick: `onTick(ctx, dt)` for every scripted node. Trigger volume
  enter/exit and interact route to `onTrigger`/`onInteract` on the matching node (reuse the existing
  systems; a behavior can register its own volumes via the API later).
- On Play exit: drop instances; transforms restore via the existing snapshot.
- **Error isolation:** every hook call is `try/catch`. A throwing hook is disabled for the rest of the run
  (or N-strikes) with a surfaced message + node id — a bad script never crashes the loop or the editor.
  Per-frame error spam is throttled.

## 3. Security — un-hardened now, sandboxed later (deliberate, staged)

- **v1 (self-authored):** compile with `new Function('ctx', body)` in the main realm, invoked with the
  curated `ctx`. This is **NOT a security boundary** — a determined script can reach `window`. That's
  acceptable while Frogmarks is *you authoring your own games*. It ships the fun immediately.
- **★ Gate before public sharing:** the moment `.frogcart` cartridges are shared/imported from others,
  running their scripts in the main realm is an XSS hole. Phase 2 swaps the executor for **QuickJS-wasm**
  (synchronous, truly sandboxed — the natural fit for per-frame logic) or a **Worker** (async, message-API),
  behind the SAME `ScriptContext` — so **no user script changes** when the sandbox lands. Untrusted cartridge
  scripts stay disabled-by-default until the sandbox exists (a clear "contains scripts — run?" gate).
- This staging is the whole point: the cheap 80% (a working script runtime) ships now; the expensive 20%
  (bulletproof isolation) is deferred to exactly when sharing needs it, without a rewrite.

## 4. Persistence

- New `scriptBehaviors?: ScriptBehavior[]` in `GlobalScene3DSettings` (rides scene3dJSON.globalScene, like
  `animationLibrary`). Clear-on-load (stale-registry rule from `project_persistence_bug_family_2026_09`),
  then load the incoming set. Source is plain text → trivially serializable + diffable + **AI-authorable**
  (the thesis stays intact: the behavior's *source* is the persisted param).
- Only the source persists, never runtime `this` state (that resets each Play; save-points are §7).

## 5. Facade API (`sm.*`)

```ts
sm.setScriptBehavior3D(nodeId, source, opts?: { enabled?; name? }) → void   // attach/replace
sm.getScriptBehavior3D(nodeId) → ScriptBehavior | null
sm.removeScriptBehavior3D(nodeId) → boolean
sm.setScriptEnabled3D(nodeId, enabled) → void
sm.listScriptBehaviors3D() → ScriptBehavior[]
sm.getScriptContextTypes3D() → string        // the .d.ts text, for the editor's IntelliSense
sm.validateScript3D(source) → { ok: boolean; errors: {line, message}[] }   // transpile + optional typecheck
```

## 6. Host UI (Frogmarks — future `docs/ui/script-behaviors.md`)

- A **"Behavior" section in the object inspector**: a code editor (Monaco with the `.d.ts` loaded via
  `getScriptContextTypes3D`), enable toggle, and inline error list from `validateScript3D`.
- A **script icon** on scripted outliner rows.
- Snippet/template picker ("Patrol", "Follow player", "Spinner", "Projectile") to seed common behaviors —
  the on-ramp that makes scripting approachable.

## 7. Testing plan

- **Unit (pure, GPU-free):** the compiler/transpile wrapper (TS→hooks, error capture, source-hash cache);
  the `ScriptContext` implementation against a mock scene (move/setVar/distanceTo/spawn/raycast); error
  isolation (a throwing `onTick` disables that behavior, others keep running).
- **Harness:** `drive-scripts.js` — a "patrol" `onTick` mover (asserts the node walks), a "follow player"
  that reduces distance during Play, a `setVar` that a UI-machine `variable` transition reacts to (scripts
  ↔ machine compose), and an error-throwing script that gets disabled without killing the loop.
- Extend `drive-persist.js` with a scripted node (source round-trips; steady-state holds).

## 8. Build order

1. **S1 ✅ BUILT 2026-09-27:** compiler (sucrase transpile + `new Function` factory + cache + error capture) +
   `ScriptContext` factory (over a `ScriptSceneAdapter` seam — real adapter deferred to S2) + the manager
   (attach/list/enable/serialize/restore) — unit tested (`src/services/scripting/`, 20 tests).
2. **S2 ✅ BUILT 2026-09-27:** Play-loop integration (onStart/onTick/onTrigger/onInteract + per-hook error isolation) +
   real ShapeManager-backed `ScriptSceneAdapter` + var/emit bridge to the UI machine. (`drive-scripts` Node harness
   skipped — needs a GPU; the `ScriptRunner` vitest suite covers its cases. Live Play = browser-verify.)
3. **S3 ✅ BUILT 2026-09-27/28:** `GlobalScene3DSettings.scriptBehaviors` + clear-on-load + `validateScript3D` +
   `.d.ts` export (`getScriptContextTypes3D`).
4. **S4 ✅ BUILT 2026-09-28:** facade + host doc (`docs/ui/script-behaviors.md`) + snippet templates
   (`getScriptSnippets3D`).
5. Later: QuickJS/Worker sandbox (§3), spawn-real-prefabs, save-points (persist runtime state), a visual
   node front-end that emits the same behaviors, AI "describe it → onTick" authoring.

## 9. Relationship to the other systems

- **State machine** = flow/UI/one-shot reactions (data). **Scripts** = continuous custom behavior (code).
  They share **variables**, so a script computes and the machine reacts (or vice-versa) — the intended
  division, mirroring Unity.
- **Params-as-source thesis:** a script's *source text* is a persisted, diffable, AI-writable param — the
  thesis holds; scripts are just a more expressive param than a slider.
- **AI authoring:** once `ScriptContext` exists, "describe the behavior → AI writes the `onTick`" is the
  friendly front-end and the real differentiator vs. hand-written C#.
