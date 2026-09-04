# UI System — Frogmarks UI Integration Guide

Spec: `docs/specs/ui-system.md`. Status: **Phases 1–2 complete, Phase 3 mostly done** (see §9). Everything below is live and unit-tested (30 tests) unless flagged "not yet."

The UI System lets a creator make an illustration **interactive** — menus, HUDs, title screens, pause screens — by drawing buttons with the normal Salsa tools and wiring behavior with a **state machine**. It is fully opt-in: a project with no UI layer is completely unaffected.

---

## 0. The model in one line

A **UI layer** owns a **state machine**: named **states** (screens/modes) connected by **transitions** (trigger → conditions → actions → next state). Any **shape** (2D or a 3D mesh, in any layer) can be made **interactive**. At runtime the engine toggles real layer/shape visibility, navigates states, and emits **events**. The engine is pure and deterministic; Salsa applies the effects and renders the modal dim/fade. **You author the data; the system runs it.**

Two mental notes that save the most confusion:
- **The UI layer drives EXISTING shapes.** It is a behavior container, not a canvas. The author draws buttons in an ordinary vector layer; the UI layer wires their interactivity and visibility. (The only things the UI layer draws itself are the modal dim + fade.)
- **Edit vs preview.** Interactivity is OFF by default (so authoring is never intercepted). You turn it on with `sm.setUIInteractive(true)` for preview/play, and off to edit.

---

## 1. The API surface (all on `sm` = the ShapeManager)

Import the types from the package: `import type { UIStateMachine, UILayerData, ShapeInteractionProps, UIEvent, Action, InteractionTrigger, Condition, SceneVariable, SceneState, StateTransition } from '@zaings/salsa'`.

### Layer lifecycle
UI layers live in a **dedicated "UI" panel**, NOT the Layers list — they're behavior, not pixels (like the "Global" scene-settings tab). Manage them entirely through these:
```ts
sm.createUILayer(name?: string): string            // → layerId (also becomes the active layer)
sm.listUILayers(): UILayerData[]                   // enumerate for the UI panel's tabs
sm.getUILayer(layerId): UILayerData | null
sm.updateUILayer(layerId, updates)                 // { name?, passThroughPointer?, backgroundOverlay?, visible? } — name = rename
sm.deleteUILayer(layerId): boolean                 // the ✕ on a UI-panel tab
sm.activeUILayerId: string | null                  // selected tab
sm.setActiveUILayer(layerId): void
```
**Rename** = `updateUILayer(layerId, { name })`. There is no Layers-panel row — the visibility eye / drag-order / etc. of the Layers list don't apply (a UI layer has no visual content of its own beyond the modal dim).

### State machine
```ts
sm.setStateMachine(layerId, machine: UIStateMachine): void   // installs + enters the initial state
sm.getStateMachine(layerId): UIStateMachine | null
sm.goToUIState(layerId, stateId, animation?: TransitionAnimation): void   // programmatic navigation
sm.getCurrentUIState(layerId): string | null
sm.getUIStateHistory(layerId): string[]            // the back-stack (for goBack / breadcrumbs)
```

### Variables
```ts
sm.getUIVariable(layerId, variableId): boolean | number | string | null
sm.setUIVariable(layerId, variableId, value): void  // fires any variable-watch transition
```

### Shape interactions (make a shape clickable/hoverable/focusable)
```ts
sm.onShapeSelectionChanged(cb: (ids: string[]) => void): () => void  // viewport selection → drives the panel
sm.getSelectedShapeIds(): string[]                  // current selection, on demand
sm.setShapeInteraction(props: ShapeInteractionProps, layerId?): void  // layerId defaults to the active UI layer
sm.clearShapeInteraction(shapeId, layerId?): void
sm.getShapeInteraction(shapeId, layerId?): ShapeInteractionProps | null
sm.clickUIShape(shapeId, layerId?): void            // simulate a click (also what a real pointer hit calls)
```
**Wiring the "SHAPE INTERACTIONS" panel:** subscribe to `onShapeSelectionChanged`; when exactly one id is selected, show the make-interactive controls and call `setShapeInteraction({ shapeId: id, … })`. The id is the object id of a vector, text, or 3D-mesh shape, **or an ephemera placement** — `onShapeSelectionChanged` fires for scene-graph node selection AND ephemera placement selection, and both work as interactive targets (an ephemera's placement id is its `shapeId`). Select an object with the **arrow/pointer tool** (or click an ephemera), not the raster marquee. A raster **pixel region is not an object** (it has no id) and cannot be a UI target; interactions attach to objects/ephemera, not painted pixels. ⚠️ **Ephemera are layer-scoped** — selectable only when their vector layer is active; generic Boards-era vector shapes with no `layerId` are always selectable (see `docs/specs/ui-ephemera-and-vector-layer-selection.md` Issue B).

### Preview / runtime
```ts
sm.setUIInteractive(on: boolean): void              // preview/play mode ON/OFF (OFF by default)
sm.uiInteractive: boolean                           // getter
sm.tickUI(dtMs: number): void                       // ADVANCE timers + transition fades — call every frame in preview
```
**Pointer + keyboard are auto-wired** inside Salsa (the canvas hooks). While `uiInteractive`, clicking/hovering an interactive shape (2D or a 3D mesh) fires it, the cursor updates on hover, **Tab** cycles focusable shapes, **Enter/Space** activates the focused one, and other keys fire `keyDown` triggers (e.g. `Escape → pause`). You do **not** wire pointer/keyboard yourself — just `setUIInteractive(true)` and pump `tickUI(dt)`.

### Events
```ts
const off = sm.onUIEvent((e: UIEvent) => { ... });  // returns an unsubscribe fn
```

### Advanced (via `sm.ui`, the UIManager)
`sm.ui.focusNext()/focusPrev()/getFocusedShape()/activateFocused()` if you want to drive focus yourself; `sm.ui.setEffectHook(fn)` to receive world-control effects (see §5). Rarely needed — the keyboard wiring covers focus.

---

## 2. Data model shapes

These are exactly what you build and pass to `setStateMachine` / `setShapeInteraction`. `UIValue = boolean | number | string`.

```ts
interface UIStateMachine {
  id: string;
  initialStateId: string;              // the state entered on load
  states: SceneState[];
  transitions: StateTransition[];
  variables: SceneVariable[];
  globalTransitions?: StateTransition[]; // fire from ANY state (fromState:'*') — e.g. Escape→pause
  htmlForms?: HtmlFormElement[];         // Phase 4 (not wired yet)
}

interface SceneState {
  id: string; name: string;
  layerVisibility?: Record<string, boolean>;   // applied on enter (layerId → visible)
  shapeVisibility?: Record<string, boolean>;    // applied on enter (shapeId → visible)
  frozen?: boolean;                             // "pause the world" — emitted but NOT yet applied (see §5)
  worldBlur?: number;                           // > 0 ⇒ MODAL: the scene dims behind the UI (see §5)
  onEnter?: Action[];                           // run once when the state becomes active
  onExit?: Action[];                            // run once when leaving
}

interface StateTransition {
  id: string;
  fromState: string | '*';             // '*' = from any state (put these in globalTransitions)
  toState: string;
  trigger: InteractionTrigger;
  conditions?: Condition[];            // ALL must pass for the transition to fire
  actions?: Action[];                  // side effects run before entering toState
  animation?: TransitionAnimation;     // fade played on the transition
}

type InteractionTrigger =
  | { type:'click'|'hover'|'hoverEnd'|'pointerDown'|'pointerUp'; targetId: string }  // targetId = a shapeId
  | { type:'keyDown'|'keyUp'; key: string }        // e.g. 'Escape', 'Enter', 'ArrowUp'
  | { type:'timer'; delay: number }                // fires `delay` ms after entering the state
  | { type:'variable'; variableId: string; op: UICompareOp; value: UIValue }  // fires when a var reaches this
  | { type:'formSubmit'; formId: string }          // Phase 4
  | { type:'stateEnter'|'stateExit'; stateId: string }
  | { type:'gamepadButton'; button: number } | { type:'gamepadAxis'; axis: number; direction:'positive'|'negative' }
  // ── Spatial gameplay triggers — fired by Play mode; make an illustration into a walkable game (docs/ui/play-mode.md).
  //    You author these transitions here; the Play runtime dispatches them into the active UI layer automatically.
  | { type:'enterVolume'|'exitVolume'; volumeId: string }  // player's feet cross a trigger volume (sm.setTriggerVolumes3D)
  | { type:'interact'; targetId: string };                 // player pressed "use" (F) on a nearby interactable (sm.setInteractables3D)

type UICompareOp = '=='|'!='|'>'|'<'|'>='|'<=';

type Action =
  | { type:'goToState'; stateId: string; animation?: TransitionAnimation }
  | { type:'goBack' }                                    // pop the back-stack
  | { type:'openUrl'; url: string; target?:'_blank'|'_self'|'_parent' }
  | { type:'showLayer'|'hideLayer'|'toggleLayer'; layerId: string }
  | { type:'showShape'|'hideShape'|'toggleShape'; shapeId: string }
  | { type:'setVariable'; variableId: string; value: UIValue }
  | { type:'addVariable'; variableId: string; amount: number }
  | { type:'toggleVariable'; variableId: string }
  | { type:'emitEvent'; eventName: string; payload?: Record<string, unknown> }   // → onUIEvent (host hand-off)
  // Applied in a later phase (currently routed to sm.ui.setEffectHook, see §5):
  | { type:'freezeWorld'; frozen: boolean } | { type:'setWorldSpeed'; speed: number }
  | { type:'setCamera'; position?:[number,number,number]; target?:[number,number,number]; duration?: number }
  | { type:'playAnimation'|'stopAnimation'|'pauseAnimation'; targetId: string; clipId?: string; loop?: boolean }
  | { type:'seekAnimation'; targetId: string; frame: number }
  | { type:'playSound'|'stopSound'; assetId: string; volume?: number; loop?: boolean }
  | { type:'setVolume'; assetId: string; volume: number }
  | { type:'clearForm'; formId: string } | { type:'focusFormField'; elementId: string };

type Condition =
  | { type:'variable'; variableId: string; op: UICompareOp; value: UIValue }
  | { type:'stateHistory'; stateId: string; visited: boolean }   // has the user been to this state?
  | { type:'formValid'; formId: string }                          // Phase 4 (treated as true for now)
  | { type:'not'; condition: Condition };

interface SceneVariable { id: string; name: string; type:'boolean'|'number'|'string'; defaultValue: UIValue; persistent?: boolean; }

interface TransitionAnimation {
  type:'none'|'fade'|'slideLeft'|'slideRight'|'slideUp'|'slideDown'|'zoom'|'zoomOut'|'wipe'|'custom';
  duration: number;                    // ms
  easing?:'linear'|'easeIn'|'easeOut'|'easeInOut'|'spring';
  customClipId?: string;
}
```

```ts
interface ShapeInteractionProps {
  shapeId: string;                     // the node id of a 2D shape OR a 3D Mesh3D
  cursor?: 'pointer'|'default'|'text'|'grab'|'crosshair'|'none';
  focusable?: boolean; tabIndex?: number;             // Tab order
  focusIndicatorShapeId?: string;      // a shape you designed as the focus RING — shown while this element is focused
  ariaLabel?: string;
  disabled?: boolean;                  // present but inert
  disabledWhenVariable?: string;       // auto-disabled while this variable is falsy (0/false/''/unset)
  hoverAnimationClipId?: string; pressAnimationClipId?: string;  // Phase 3 remainder (not wired yet)
}

interface UILayerData {
  id: string; name: string; type: 'ui-layer'; visible: boolean;
  stateMachine: UIStateMachine;
  passThroughPointer: boolean;         // true (default): misses fall through to editing; false: MODAL, swallows all clicks
  backgroundOverlay?: { color: [number, number, number, number] };  // the modal DIM colour (rgba 0..1)
  shapeInteractions: Record<string, ShapeInteractionProps>;   // keyed by shapeId
}
```

---

## 3. What comes back on `onUIEvent`

```ts
type UIEvent =
  | { type:'stateChange';    fromState: string | null; toState: string }
  | { type:'shapeClick';     shapeId: string }
  | { type:'shapeHover';     shapeId: string }
  | { type:'shapeHoverEnd';  shapeId: string }
  | { type:'variableChange'; variableId: string; oldValue: UIValue; newValue: UIValue }
  | { type:'formSubmit';     formId: string; values: Record<string, string | boolean> }   // Phase 4
  | { type:'custom';         eventName: string; payload?: Record<string, unknown> };       // from `emitEvent` actions
```
`custom` is the **host hand-off**: an `emitEvent` action in the machine surfaces here so Frogmarks can run its own logic (e.g. `sceneComplete → unlock the next scene`). `stateChange` is handy for a live "current state" readout in the panel.

---

## 4. Persistence

UI layers are saved **with the document** automatically — no separate call. The whole machine + shape interactions round-trip: `gatherDocumentState` serializes them (`uiLayersJSON`), and `restoreDocumentState` re-installs them after the scene graph is back (so interaction props re-attach to their shapes by id). On reload each layer re-enters its initial state. `SceneVariable.persistent` is a marker for values that should survive across reloads (host-side storage hook — not auto-persisted yet).

**Portable `.frogmarks` / `.frogcart` export.** `sm.packProject(): Promise<Blob>` and `sm.unpackProject(file): Promise<void>` are the portable single-file export/import (a ZIP) — and they now carry the UI layers (in `ui.json`). So a bundle round-trips the whole interactive scene: **unpack → `sm.setUIInteractive(true)` + pump `tickUI` = the cart is playable in-app.** (`.frogmarks` = editable work file, `.frogcart` = the same container repurposed as a distributable app; Frogmarks owns that naming + the standalone Player page, which is just a thin host that unpacks and runs.)

---

## 5. Rules & gotchas

- **Interactivity is OFF by default.** Nothing intercepts input or dims the screen until `sm.setUIInteractive(true)`. Turn it off to return to editing. This is the single most important toggle.
- **You must call `sm.tickUI(dt)` every frame in preview** or `timer` transitions and transition **fades** won't advance. (Clicks/keys/hover work without it; only time-based things need the tick.)
- **`shapeId` = the scene-graph node id.** For a 2D shape it's the shape's id; for a 3D button it's the `Mesh3D` node id. Attach interactions to shapes that already exist.
- **Modal dim needs both a `worldBlur` state and a layer `backgroundOverlay`.** A state dims the world only when `worldBlur > 0`; the dim colour comes from the layer's `backgroundOverlay.color` (default black α 0.55). True Gaussian blur isn't implemented — it's a flat dim for now.
- **Buttons must be above-raster vector shapes** to stay crisp over the dim (the normal case). Shapes below the 3D divider get dimmed with the world.
- **`passThroughPointer`**: leave it `true` for a HUD (clicks miss → editing/orbit still work); set `false` for a modal menu that should swallow every click.
- **`frozen` / world-control actions are NOT applied yet.** `frozen`, `freezeWorld`, `setCamera`, `playAnimation`, `setWorldSpeed`, sound — these are emitted but Salsa doesn't act on them (there's no single "pause everything" API across animation/cloth/particles/world-time). Subscribe via `sm.ui.setEffectHook(fn)` to apply them host-side, or use them once Salsa wires them. Everything else (navigation, visibility, variables, openUrl, emitEvent, dim, fade, focus) **is** applied.
- **Transitions**: `fade` works; `slide/zoom/wipe` currently fall back to a fade (directional shaders TBD). Because state swaps synchronously, a fade reads as "new state fades in," not a true crossfade.
- **Cascades are safe.** goToState-in-onEnter, variable-watch chains, and stateEnter chains are depth-bounded — a circular authoring mistake stops emitting rather than hanging.
- **Multiple UI layers** are supported (a HUD layer + a pause layer). `setShapeInteraction` etc. default to the **active** layer (the last created); pass `layerId` to target another.

---

## 6. Minimal wiring

```ts
// 1. Author (once, at edit time)
const layer = sm.createUILayer('Main Menu');
sm.updateUILayer(layer, { backgroundOverlay: { color: [0, 0, 0, 0.6] } });   // pause dim colour

sm.setStateMachine(layer, {
  id: 'menu', initialStateId: 'title',
  variables: [{ id: 'coins', name: 'Coins', type: 'number', defaultValue: 0 }],
  states: [
    { id: 'title', name: 'Title',   layerVisibility: { menuLayer: true,  hudLayer: false } },
    { id: 'game',  name: 'Game',    layerVisibility: { menuLayer: false, hudLayer: true  }, onEnter: [{ type: 'emitEvent', eventName: 'gameStarted' }] },
    { id: 'pause', name: 'Pause',   worldBlur: 8 },   // modal → dims the world
  ],
  transitions: [
    { id: 't1', fromState: 'title', toState: 'game', trigger: { type: 'click', targetId: startBtnId }, animation: { type: 'fade', duration: 250 } },
  ],
  globalTransitions: [
    { id: 'g1', fromState: '*', toState: 'pause', trigger: { type: 'keyDown', key: 'Escape' } },
  ],
});
sm.setShapeInteraction({ shapeId: startBtnId, cursor: 'pointer', focusable: true, tabIndex: 0, focusIndicatorShapeId: startRingId });

// 2. React to events
const off = sm.onUIEvent((e) => {
  if (e.type === 'stateChange') updateStatePill(e.toState);
  if (e.type === 'custom' && e.eventName === 'gameStarted') myHostLogic();
});

// 3. Preview / play
sm.setUIInteractive(true);
// …in your rAF loop, while previewing:
function frame(now) { sm.tickUI(now - last); last = now; requestAnimationFrame(frame); }
```

---

## 7. Suggested authoring panel

The panel is the big Frogmarks build (Salsa's Phase 5 is explicitly "largely Frogmarks-side" — a flowchart editor). A pragmatic layout:

```
▸ UI LAYER ───────────────
  Name  [Main Menu]
  [✓] Pass-through pointer          Overlay [■] rgba
  [ ▶ Preview ]  ← toggles sm.setUIInteractive
  Current state: [title ▾]          ← live from onUIEvent(stateChange)

▸ STATES ─────────────────           ▸ TRANSITIONS (selected state) ──
  + Add state                          + Add transition
  title (initial)                      title → game   on click:[Start]
  game                                   actions: fade 250ms
  pause  [worldBlur 8]                 globals: Esc → pause

▸ SHAPE INTERACTIONS (selected shape)   ▸ VARIABLES ──────────────────
  [✓] Interactive   Cursor [pointer ▾]  + Add   coins (number) = 0
  [✓] Focusable  tabIndex [0]            hasVisitedShop (bool)
  Focus ring: [pick a shape ▾]
```

Build order that de-risks it: (1) create-layer + preview toggle + live state pill; (2) states list with visibility toggles; (3) per-shape interaction inspector (assign click/hover + cursor); (4) transitions editor (trigger → actions → toState); (5) variables; (6) the flowchart view last. The data model in §2 is the source of truth — validate against it as you author (e.g. a transition's `targetId`/`toState` must reference an existing shape/state).

---

## 8. Frogmarks integration checklist

1. **Browser-verify the render features first** (Salsa has flagged this): enter preview, drive to a `worldBlur` state → scene dims + menu crisp; Tab through focusable buttons → focus ring moves; click a 3D-mesh target. ~10 min.
2. **Pump `sm.tickUI(dt)`** in the frame loop while previewing.
3. **Then build the authoring panel** per §7.

---

## 9. Phase status (what's live)

| Area | Status |
|---|---|
| State machine engine (states/transitions/triggers/actions/conditions/variables/history/timers) | ✅ live, tested |
| Layer + shape-interaction API, `onUIEvent`, persistence | ✅ live, tested |
| Pointer hit-test + cursor, keyboard, focus nav | ✅ live (auto-wired) |
| Modal `backgroundOverlay` dim + `fade` transitions + authored focus ring + 3D-mesh targets | ✅ live — **browser-verify** |
| True Gaussian `worldBlur`, directional `slide`/`wipe`, `freezeWorld`/camera/animation application | ⬜ not yet (see §5) |
| HTML form elements (Phase 4) | ⬜ types only |
| Portable export/import carries UI layers (`sm.packProject`/`unpackProject`) → playable in-app | ✅ live, tested |
| Standalone Player page + `.frogcart` cart wrapper/manifest (Phase 6) | ⬜ Frogmarks-side (thin host over unpack + run) |
