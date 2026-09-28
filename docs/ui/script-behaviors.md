# Script Behaviors — the code editor (Frogmarks UI guide)

Attach **custom logic** to any scene object with a small TypeScript/JavaScript script — a patrolling enemy, a spinner, a
"follow the player", a proximity switch. Scripts run **only in Play** and are **non-destructive** (everything reverts on
Stop). They **share variables with the UI state machine**, so a script computes and a UI transition reacts (or vice
versa). See the engine spec: `docs/specs/script-behaviors.md`.

> Status: engine S1–S3 built (compile/run/persist/validate + editor types & snippets). The **live Play path is
> browser-unverified** — verify a script actually drives its object in Play before shipping the panel. The **security
> sandbox is not built yet**, so this is for **self-authoring only** — do not run scripts from imported/shared
> cartridges until the sandbox lands (a later phase).

## The model in one line

A **ScriptBehavior** is `{ nodeId, source, enabled, name? }` stored per object. On Play, each enabled script is compiled
and its lifecycle hooks run against a curated `ctx` API. Sources persist with the document automatically.

## Engine API (all on `sm` = ShapeManager)

```ts
sm.setScriptBehavior3D(nodeId, source, opts?: { enabled?; name? }): void   // attach / replace
sm.getScriptBehavior3D(nodeId): ScriptBehavior | null
sm.removeScriptBehavior3D(nodeId): boolean
sm.setScriptEnabled3D(nodeId, enabled): boolean                            // toggle without deleting
sm.listScriptBehaviors3D(): ScriptBehavior[]                               // for the outliner script icons

sm.validateScript3D(source): { ok: boolean; error?: { message; line? } }   // inline error list (transpile check)
sm.getScriptContextTypes3D(): string                                       // the .d.ts → Monaco extraLib (IntelliSense)
sm.getScriptSnippets3D(): { name; description; source }[]                  // the "insert snippet" picker
```

There is **no separate "run" call** — pressing **Play** (`sm.enterPlayMode3D()`) compiles + runs the enabled scripts;
**Stop** (`sm.exitPlayMode3D()`) drops them and reverts. The Play loop ticks them for you.

## The lifecycle hooks a script can define

Author as `export function …` (or a bare `function`). Per-instance state lives on `this` (fresh per object per Play).

| Hook | When |
|---|---|
| `onStart(ctx)` | once, when Play starts (set up `this.speed = …` etc.) |
| `onTick(ctx, dt)` | every fixed tick; `dt` = seconds |
| `onTrigger(ctx, e)` | a trigger volume **named after this node** fired (`e.type` = 'enter'/'exit') |
| `onInteract(ctx)` | the player "used" this node |

The `ctx` API (move / moveLocal / rotateY / lookAt / find / distanceTo / raycast / getVar / setVar / emit / input /
time / dt / playerId …) is fully described by the **`.d.ts` from `getScriptContextTypes3D()`** — load it into the editor
and authors get autocomplete + type-checking on all of it.

## Suggested panel — a "Behavior" section on the selected object

```
▾ Behavior                       (selected object)
  ☑ Enabled                       → setScriptEnabled3D(id, on)  /  attach on first edit
  [ Insert snippet ▾ ]            → getScriptSnippets3D()  → setScriptBehavior3D(id, snippet.source)
  ┌───────────────────────────────────────────────┐
  │  export function onTick(ctx, dt) {             │   ← Monaco editor
  │    ctx.rotateY(1.5 * dt);                      │     • extraLib = getScriptContextTypes3D()
  │  }                                             │     • language: typescript
  └───────────────────────────────────────────────┘
  ⚠ 1 error: line 3 — ';' expected           → from validateScript3D(source) (debounced)
```

Wiring notes:
- **Monaco setup:** register the `.d.ts` once as an extraLib —
  `monaco.languages.typescript.typescriptDefaults.addExtraLib(sm.getScriptContextTypes3D(), 'salsa-script.d.ts')` — then
  authors get full IntelliSense on `ctx` and the hooks with **no imports**.
- **On edit (debounced):** `sm.setScriptBehavior3D(selectedId, source)` to store it, and show `sm.validateScript3D(source)`
  errors inline (it transpiles; a syntax error carries a `line`). Type errors are advisory — they don't block Play.
- **Enable toggle:** `sm.setScriptEnabled3D(id, on)`; seed the panel from `sm.getScriptBehavior3D(id)` on selection
  (null → show empty + Enabled off).
- **Snippet picker:** populate from `sm.getScriptSnippets3D()` (Spinner / Patrol / Follow player / Proximity switch /
  Interactable counter); inserting replaces the editor content.
- **Outliner:** show a small **script icon** on rows whose id appears in `sm.listScriptBehaviors3D()`.
- **No save work, no redraw work** — sources persist with the document; Play drives ticks.

## Coexistence with the UI state machine

Scripts and the UI machine **share variables** (`ctx.getVar/setVar` ↔ the active UI layer's variables), and `ctx.emit(name)`
surfaces a `custom` UIEvent to `sm.onUIEvent(...)`. So the division is: **scripts = continuous per-object logic**, **UI
machine = flow / menus / one-shot reactions** — a script sets `playerNear`, a UI transition conditions on it. (See
`docs/ui/ui-system.md` for the machine side.)

## What Salsa handles for you

- Compile (TS→JS, cached), instantiate, and tick every enabled script during Play, with **per-hook error isolation** — a
  throwing script disables itself after a few strikes and is surfaced; it never crashes the loop or the editor.
- **Non-destructive Play** — transforms revert on Stop; `ctx.destroy()` hides a node and it's restored on Stop.
- Persistence — sources save/load with the document (and travel in `.frogcart`).

## v1 limits (call these out in the panel where relevant)

- **`ctx.play/stop` (animation) and `ctx.spawn` are not applied yet** — no-ops in v1. Drive clips via the UI machine's
  `playAnimation` action for now; real spawn is a later phase.
- **No sandbox yet** → self-authoring only; don't run untrusted/imported scripts until the QuickJS sandbox ships.
- Scripts target **Mesh3D nodes by id** (the object you selected). `onTrigger` fires when a trigger volume shares the
  node's id.

## Browser-verify checklist

- Attach the **Spinner** snippet to a mesh, press Play → it rotates; Stop → it returns to its original orientation.
- **Patrol** walks and ping-pongs; **Follow player** turns toward and approaches the avatar.
- A **Proximity switch** sets `playerNear` → a UI transition conditioned on it fires.
- A deliberately broken script shows an inline error (`validateScript3D`) and, if run, disables itself without freezing.
- Save/reload → the script text persists.

## Related
- Engine spec + data model: `docs/specs/script-behaviors.md`.
- UI state machine (shared vars, flow): `docs/ui/ui-system.md`, `docs/ui/ui-authoring-panel.md`.
</content>
