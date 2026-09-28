# UI Authoring Panel + Outliner (Frogmarks build spec)

This is the **concrete spec for the Frogmarks-side UI editor** — the panel that creates UI layers, edits their state
machine, ties your drawn shapes to states, and controls per-state visibility. It's the missing "Phase 5" surface.

The **engine is already complete** (state machine, per-state visibility, interactions, transitions, variables, forms,
sound, preview, persistence). Nothing new is needed in Salsa to build this panel — it's all API calls on `sm`
(ShapeManager). For the full API/runtime reference + data model, see [ui-system.md](ui-system.md); this doc is the
**panel/outliner UX + wiring** on top of it.

## 0. The mental model (read this first — it answers "where's the UI Layer in the outliner?")

- A **UI layer is NOT a row in the Layers list and NOT a node in the scene outliner.** It's a **logical behavior
  container** (`UILayerData`, `type: 'ui-layer'`) that owns a **state machine** and composites last. It lives *only*
  inside this panel. (The engine comment says it verbatim: *"a behavior container; NOT a Layers-list row — managed from
  the dedicated UI panel."*) So **this panel is its outliner.** That's why you don't see it in the scene tree — by design.
- Your **drawn vector shapes stay where they are** (in normal vector/scene layers). The UI layer never *owns* shapes; it
  **references them by id** — a state says "shape `abc` visible, shape `def` hidden," and a shape can be made clickable.
- Two id-keyed mechanisms are the whole game:
  - **`SceneState.shapeVisibility` / `layerVisibility`** — `Record<id, boolean>` applied on state enter. *This is how a
    shape's visibility is controlled by the active state.*
  - **`ShapeInteractionProps`** (keyed by shapeId) — makes a shape clickable/hoverable/focusable.
- **Preview only.** All of this applies **only** while `sm.setUIInteractive(true)`. In edit mode, nothing hides or
  intercepts — you author freely.

## 1. Panel anatomy

```
┌─ UI ──────────────────────────────────────────────────────────────────────┐
│ Layers:  [ Main Menu ▾ ]  [+ New]  [✕]        [ ▶ Preview ]  state: title  │  A. Layer bar
│ ☑ Pass-through pointer     Modal dim ■[rgba]                                │
├───────────────────────────┬────────────────────────────────────────────────┤
│ STATES            [+ Add]  │  STATE: “Title”                                │  B. States outliner +
│  ● title  (initial)★       │   ┌ Visibility ─────────────────────────────┐ │     C. State inspector
│  ○ game                    │   │ Shapes visible in this state:            │ │
│  ○ pause  🌫 blur          │   │   ▸ [Start button]   ☑ visible   [–]     │ │
│                            │   │   ▸ [Logo]           ☑ visible   [–]     │ │
│  TRANSITIONS      [+ Add]  │   │   ▸ [HUD score]      ☐ hidden    [–]     │ │
│   title→game  click:Start  │   │   [+ Add selected shape ⟵ viewport]      │ │
│   *→pause     key:Escape   │   │ Layers visible: [menuLayer ☑][hud ☐] …   │ │
│                            │   └──────────────────────────────────────────┘ │
│  VARIABLES        [+ Add]  │   ☐ Frozen (pause world)   World blur ●── 0    │
│   coins (num) = 0          │   onEnter ▸ [actions…]     onExit ▸ [actions…] │
│   hasKey (bool)            │                                                │
├───────────────────────────┴────────────────────────────────────────────────┤
│ SHAPE INTERACTIONS (1 shape selected: “Start button”)                       │  D. Selection-driven
│  ☑ Interactive   Cursor [pointer ▾]   ☑ Focusable  tabIndex [0]             │     shape inspector
│  Focus ring: [pick a shape ▾]   Hover clip [ ▾ ]   Press clip [ ▾ ]         │
│  Disabled when var: [ ▾ ]                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ FORMS [+]   SOUNDS [+ register]                                              │  E. Forms / sounds
└─────────────────────────────────────────────────────────────────────────────┘
```

### A. Layer bar
| Control | API |
|---|---|
| Layer dropdown | `sm.listUILayers()` → tabs; select → `sm.setActiveUILayer(id)`; `sm.activeUILayerId` |
| `+ New` | `sm.createUILayer(name?)` (returns id, makes it active) |
| `✕` delete | `sm.deleteUILayer(id)` |
| Rename / pass-through / dim colour | `sm.updateUILayer(id, { name, passThroughPointer, backgroundOverlay, visible })` |
| `▶ Preview` toggle | `sm.setUIInteractive(on)` + pump `sm.tickUI(dt)` each frame while on |
| Live "state:" pill | `sm.onUIEvent(e => e.type==='stateChange' && …)`; seed with `sm.getCurrentUIState(id)` |

### B. States outliner
The **outliner you were missing** — it lists `machine.states`. Each row: name, an **initial** marker (`★` =
`machine.initialStateId`), badges for `frozen`/`worldBlur`, and (in preview) a highlight on the current state.
- `+ Add` → append a `SceneState` (`{ id, name }`) and commit (see §2).
- Select a row → drives the **State inspector** (C) and the **Transitions** list (filtered to that state's `fromState`).
- Row menu: rename, delete, **Set as initial** (`machine.initialStateId = id`), duplicate.

### C. State inspector — *this is where shapes bind to states*
Editing `SceneState.shapeVisibility` / `layerVisibility` / `frozen` / `worldBlur` / `onEnter` / `onExit`.
- **Shape visibility list** = the entries of `state.shapeVisibility`. Each row shows the shape's name (resolve id via
  the scene graph), a **visible/hidden** toggle (the boolean value), and remove.
- **`+ Add selected shape ⟵ viewport`** is the key workflow (see §3): whatever shape you've selected in the canvas gets
  added to this state's map.
- **Layers visible** = `state.layerVisibility`, same idea keyed by layer id (checkboxes over `sm.listUILayers()`-adjacent
  real layers / the Layers list).
- **Frozen** → `state.frozen`; **World blur** slider (0..1) → `state.worldBlur` (needs the layer's `backgroundOverlay`
  colour for the dim tint).
- **onEnter / onExit** → `Action[]` editors (reuse the transition action editor).

### D. Shape-interaction inspector (selection-driven)
Appears when **exactly one shape** is selected in the viewport. Subscribe with
`sm.onShapeSelectionChanged(ids => …)`; when `ids.length === 1`, show these controls; seed from
`sm.getShapeInteraction(id)`.
| Control | Field | API |
|---|---|---|
| Interactive (on/off) | (presence of props) | `sm.setShapeInteraction({ shapeId, … })` / `sm.clearShapeInteraction(shapeId)` |
| Cursor | `cursor` | `setShapeInteraction({ shapeId, cursor })` |
| Focusable / tabIndex | `focusable`, `tabIndex` | idem |
| Focus ring | `focusIndicatorShapeId` | pick another shape as the ring |
| Hover / press clip | `hoverAnimationClipId` / `pressAnimationClipId` | idem (skeleton/skinned targets) |
| Disabled when var | `disabledWhenVariable` | idem |

`setShapeInteraction` defaults to the **active** UI layer; pass `layerId` to target another.

### E. Forms & sounds
- **Forms**: `sm.addHtmlFormElement(el, layerId?)` / `removeHtmlFormElement` / `getUIFormValue` / `submitUIForm`. Each
  `HtmlFormElement` has `canvasBounds`, `type`, optional `variableBinding`, `visibleInStates`. (Details in
  [ui-system.md §4b](ui-system.md).)
- **Sounds**: a picker over `sm.listUISounds()`; register uploads with `sm.registerUISound(assetId, url)`. Machines then
  play by `assetId`. Bundled into `.frogcart` on export.

## 2. ★ The editing model — how the panel commits edits (important)

There are **no granular mutators** (no `addState`, `addTransition`, `setStateVisibility`…). The machine is edited as a
**whole object**: read → mutate a copy → commit.

```ts
const m = structuredClone(sm.getStateMachine(layerId)!);   // read the current machine
// …mutate m.states / m.transitions / m.variables / m.states[i].shapeVisibility[shapeId] = true …
sm.setStateMachine(layerId, m);                            // commit
```

Two rules that fall out of this:

1. **Edit while NOT in preview.** `setStateMachine` **re-enters the machine's `initialStateId`** on commit. That's fine
   at edit time (no visible state), but if you commit while previewing it'll snap back to the initial state. So: author
   with Preview **off**; commit; then Preview on. To jump to a specific state to check it, use
   `sm.goToUIState(layerId, stateId)` (don't re-commit the machine just to preview a state).
2. **The panel owns the working copy.** Keep the machine object in panel state, mutate it on every control change, and
   `setStateMachine` to persist. Re-reading with `getStateMachine` after external changes is fine; it's the source of
   truth and what serializes.

> Optional engine follow-up (not required to ship the panel): add granular mutators + an "edit commit that preserves the
> current state" so live editing during preview doesn't reset. Flag it if the whole-object commit becomes painful.

## 3. ★ Workflow: bind a drawn shape to a state's visibility

The thing you specifically asked about — "how do I tie vector shapes I draw to UI states, and control visibility by
selected state." End-to-end:

1. **Draw** your shapes normally (vector layer). They have ids like any node.
2. In the panel, **select the state** whose visibility you're defining (e.g. `title`).
3. In the **canvas, select the shape** (e.g. the Start button). The panel hears it via `onShapeSelectionChanged`.
4. Click **"+ Add selected shape"** in the State inspector → panel does:
   ```ts
   const m = structuredClone(sm.getStateMachine(layerId)!);
   const s = m.states.find(st => st.id === selectedStateId)!;
   (s.shapeVisibility ??= {})[selectedShapeId] = true;   // toggle the checkbox for hidden
   sm.setStateMachine(layerId, m);
   ```
5. Repeat for other states — e.g. in `game`, set that same shape to `false` so the Start button **hides** when you enter
   the game state.
6. **Preview** (`setUIInteractive(true)`), then `sm.goToUIState(layerId, 'game')` (or trigger a transition) → the shape
   shows/hides per the active state. That *is* "visibility controllable based on selected state," and it's already live
   in the engine (entering a state applies its `shapeVisibility`/`layerVisibility` maps).

Same pattern for **whole layers**: put the layer id in `state.layerVisibility` instead (hide a whole HUD vector layer in
the pause state, etc.).

## 4. Transitions & variables (brief — full model in ui-system.md §2)

- **Transition editor** row: `fromState` (or `*` = global), `trigger` (click/hover/key/timer/variable/formSubmit/
  gamepad/enterVolume/interact/animationFinished…), optional `conditions`, `actions[]`, `toState`, optional `animation`.
  Global transitions live in `machine.globalTransitions`.
- **Action editor** covers the full `Action` union (goToState, show/hide/toggle layer|shape, play/stop/pause/seek
  animation, freezeWorld, setWorldSpeed, setWorldBlur, setCamera, set/add/toggle variable, playSound/stopSound/setVolume,
  clear/submit/focus form, openUrl, emitEvent). The show/hide/toggle-shape actions are the **imperative** counterpart to
  per-state `shapeVisibility` — use whichever fits (declarative per state vs. one-off on a transition).
- **Variables**: `sm.getUIVariable` / `sm.setUIVariable` for live values; the machine's `variables[]` holds the
  definitions (`persistent: true` auto-saves to localStorage).

## 5. Persistence & what Salsa handles

- **Automatic.** UI layers + machines serialize with the document (`packProject` → `uiLayersJSON`/`ui.json`) and export
  in `.frogcart`. The panel does **no** save work — just `setStateMachine` and it's persisted.
- Salsa handles: pointer hit-testing + cursor, keyboard/focus nav, timers, transitions/scrim, world freeze/blur/camera,
  sound, gamepad, form mounting, and applying every per-state/`Action` effect to the real layers/shapes.

## 6. Build order (de-risked)

1. **Layer bar + Preview toggle + live state pill** (§A) — proves the loop end-to-end.
2. **States outliner** (§B) with add/rename/set-initial + the **read-edit-commit** helper (§2).
3. **Shape-visibility editor** (§C) + the **"add selected shape"** binding flow (§3) — *your core requirement.*
4. **Shape-interaction inspector** (§D) — make buttons clickable.
5. **Transitions editor** (§4), then **Variables**, then **Forms/Sounds** (§E).
6. Optional flowchart view of states/transitions last.

## 7. Browser-verify checklist

- Create a layer, add two states, bind a shape visible in one / hidden in the other, Preview + `goToUIState` → the shape
  toggles.
- Make a shape interactive → click it in preview fires its transition; cursor changes on hover; Tab moves the focus ring.
- Commit an edit while **not** previewing; confirm Preview then starts at the initial state.
- Save/reload (and `.frogcart` export/import) → layers, states, bindings, interactions all persist.
- Un-opted content and edit mode are unaffected when Preview is off.

## Related
- [ui-system.md](ui-system.md) — the API/runtime reference + full data model (§2), gotchas (§5), phase status (§9).
- Engine data model: `src/ui/ui-types.ts`. Runtime: `src/ui/ui-state-machine.ts`. Host adapter:
  `src/services/managers/ui-manager.ts`.
</content>
