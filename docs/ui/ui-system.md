# UI System — Frogmarks UI Integration Guide

Spec: `docs/specs/ui-system.md`. Status: **FEATURE-COMPLETE on both sides** (2026-09-08, see §9) — Phases 1–4 + 6 + the Phase 7 tail: true Gaussian world blur, real slide/wipe/iris transitions, applied world freeze/speed/camera (eased tween) + per-target clip animation, sound (with `.frogcart` audio bundling), gamepad, HTML form elements, persistent variables, `.frogcart` export/import + Player mode — and the Frogmarks Player page/Export modal/drop zone are live. Remaining: Phase 5 authoring panel + postMessage bridge (Frogmarks-side), Phase 7 misc. Everything below is live and unit-tested unless flagged otherwise; **browser-verify checklist in §8**.

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
  htmlForms?: HtmlFormElement[];         // native form controls over the canvas (see §4b)
}

interface SceneState {
  id: string; name: string;
  layerVisibility?: Record<string, boolean>;   // applied on enter (layerId → visible)
  shapeVisibility?: Record<string, boolean>;    // applied on enter (shapeId → visible)
  frozen?: boolean;                             // "pause the world" — freezes world time + animation (see §5)
  worldBlur?: number;                           // > 0 ⇒ MODAL: the scene dims + Gaussian-blurs behind the UI, 0..1 (see §5)
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
  | { type:'formSubmit'; formId: string }          // fires on sm.submitUIForm / submitForm action / Enter (§4b)
  | { type:'stateEnter'|'stateExit'; stateId: string }
  // Gamepad — LIVE: polled automatically inside tickUI (standard-mapping indices; button = press edge,
  // axis = ±0.5 threshold crossing). No wiring needed — plug in a pad and author the transition.
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
  // World control — APPLIED by Salsa (freeze/speed/camera, see §5); also forwarded to sm.ui.setEffectHook:
  | { type:'freezeWorld'; frozen: boolean } | { type:'setWorldSpeed'; speed: number }
  | { type:'setWorldBlur'; amount: number }            // dynamic blur without a modal state (0..1)
  | { type:'setCamera'; position?:[number,number,number]; target?:[number,number,number]; duration?: number }  // duration ⇒ eased tween
  // Animation — APPLIED by Salsa (targetId = a Skeleton3D id OR a SkinnedMesh3D id; clipId matches the
  // clip's id or NAME, omitted = the skeleton's first clip; see §5):
  | { type:'playAnimation'|'stopAnimation'|'pauseAnimation'; targetId: string; clipId?: string; loop?: boolean }
  | { type:'seekAnimation'; targetId: string; frame: number }
  // Sound — APPLIED once the host registers assets via sm.registerUISound(assetId, url) (see §5):
  | { type:'playSound'|'stopSound'; assetId: string; volume?: number; loop?: boolean }
  | { type:'setVolume'; assetId: string; volume: number }
  // Forms — APPLIED (see §4b):
  | { type:'submitForm'; formId: string }          // gather values → formSubmit event + trigger (a submit button's action)
  | { type:'clearForm'; formId: string } | { type:'focusFormField'; elementId: string };

type Condition =
  | { type:'variable'; variableId: string; op: UICompareOp; value: UIValue }
  | { type:'stateHistory'; stateId: string; visited: boolean }   // has the user been to this state?
  | { type:'formValid'; formId: string }                          // all REQUIRED fields of the form filled (§4b)
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
  hoverAnimationClipId?: string; pressAnimationClipId?: string;  // LIVE: hover clip LOOPS while hovered (stops on
                                       // leave); press clip one-shots on click. Skinned 3D targets (clip id or name).
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
  | { type:'formSubmit';     formId: string; values: Record<string, string | boolean> }   // values keyed by element id
  | { type:'custom';         eventName: string; payload?: Record<string, unknown> };       // from `emitEvent` actions
```
`custom` is the **host hand-off**: an `emitEvent` action in the machine surfaces here so Frogmarks can run its own logic (e.g. `sceneComplete → unlock the next scene`). `stateChange` is handy for a live "current state" readout in the panel.

---

## 4. Persistence

UI layers are saved **with the document** automatically — no separate call. The whole machine + shape interactions round-trip: `gatherDocumentState` serializes them (`uiLayersJSON`), and `restoreDocumentState` re-installs them after the scene graph is back (so interaction props re-attach to their shapes by id). On reload each layer re-enters its initial state.

**`SceneVariable.persistent` is live**: a persistent variable's value is auto-saved to `localStorage` on every change (keyed `salsa-ui-vars:<machineId>`) and silently restored — over the default, without firing watch transitions — whenever the machine is (re)installed. Use it for progress/unlockables/settings (`coins`, `hasFinishedIntro`, `musicVolume`). Non-persistent variables reset to `defaultValue` per session as before. (`sm.ui.setVariableStorage(...)` swaps the backing store if Frogmarks wants its own.)

**Portable `.frogmarks` export.** `sm.packProject(): Promise<Blob>` and `sm.unpackProject(file): Promise<void>` are the portable single-file export/import (a ZIP) — and they carry the UI layers (in `ui.json`). So a bundle round-trips the whole interactive scene.

### `.frogcart` — the distributable cart (Phase 6, live)

A `.frogcart` is a ZIP **envelope around the full project package**, plus a manifest and Player config — the thing a creator publishes and the Player page runs:

```
my-scene.frogcart (ZIP)
  manifest.json        ← title/author/description/tags/sceneId/createdAt (FrogcartManifest)
  scene.salsa          ← the FULL project package (packProject bytes — scene, 3D, textures, UI layers)
  state-machine.json   ← pre-parsed UI layers (convenience copy for the Player; scene.salsa's ui.json is what restores)
  player-config.json   ← FrogcartPlayerConfig: initialState, canvasWidth/Height (default 1280×960 4:3),
                          lockAspectRatio, allowFullscreen, backgroundColor, loading screen, deepLinkStateParam ('state')
  audio.json + audio/* ← bundled sound assets (only when sounds are registered — see below)
```

**Audio is bundled automatically.** `exportFrogcart` fetches every URL registered via `registerUISound` and packs the bytes into the cart; `importFrogcart` re-registers them as object URLs. So a published cart's `playSound` actions work in the Player with **zero extra wiring** — the Player never needs to know about audio.

```ts
import type { FrogcartMeta, FrogcartManifest, FrogcartPlayerConfig } from '@zaings/salsa';

// EXPORT (the editor's "Publish cart" button):
const blob = await sm.exportFrogcart(
  { title: 'My Scene', author: 'zain', description: '…', tags: ['game'] },   // FrogcartMeta
  { initialState: 'title', canvasWidth: 1280, canvasHeight: 960 });          // Partial<FrogcartPlayerConfig> (optional)
// → trigger a download of `blob` as `my-scene.frogcart`

// IMPORT (the editor's "Open cart", or the Player page):
const { manifest, playerConfig } = await sm.importFrogcart(file);
// The FULL project is now loaded (scene + UI layers). Apply playerConfig (canvas size etc.), then:

// PLAYER MODE:
sm.enterUIPlayerMode(playerConfig.initialState || deepLinkState);  // interactive ON + editor box-select suppressed
//   …pump sm.tickUI(dt) each frame as usual…
sm.exitUIPlayerMode();                                             // back to editing
sm.isUIPlayerModeActive;                                           // getter
```

**Deep linking:** the Player page reads `?<deepLinkStateParam>=<stateId>` from its URL (default param name `state`, per `playerConfig.deepLinkStateParam`) and passes that state id to `enterUIPlayerMode`. **The standalone Player page is Frogmarks-side and is LIVE** (the `/player` route, plus the Export modal and the dashboard `.frogcart` drop zone) — a thin host: init Salsa on a canvas → `importFrogcart` → apply config → `enterUIPlayerMode` → rAF `tickUI`. A postMessage bridge (embedding a cart in an iframe and relaying `onUIEvent` out / commands in) remains host-side glue over the API above, not built yet.

---

## 4b. HTML form elements (Phase 4, live)

Native browser inputs (text, password, select, checkbox, radio, textarea…) positioned **over the canvas** — for settings screens, name entry, login-style gates. Salsa mounts them in a `<div class="salsa-ui-form-overlay">` next to the canvas; the author draws labels/borders on canvas like any other shape, so the controls stay visually integrated.

```ts
sm.addHtmlFormElement(el: HtmlFormElement, layerId?): void   // add/replace by id (defaults to the active UI layer)
sm.removeHtmlFormElement(elementId, layerId?): void
sm.getUIFormValue(elementId): string | boolean | null        // current DOM value (checkbox → boolean)
sm.submitUIForm(formId): void                                // programmatic submit
sm.repositionUIForms(): void                                 // call after a canvas resize/move
```

```ts
interface HtmlFormElement {
  id: string;
  type: 'text'|'password'|'number'|'email'|'tel'|'textarea'|'select'|'checkbox'|'radio';
  formId?: string;                     // form GROUP key — an element without one belongs to EVERY form
  canvasBounds: { x, y, width, height };   // canvas CSS px, top-left origin
  placeholder?: string; label?: string;    // label → aria-label (draw the visible label on canvas)
  required?: boolean;                  // feeds the formValid condition
  options?: string[];                  // select / radio
  variableBinding?: string;            // TWO-WAY: typing sets the SceneVariable; setting the variable updates the input
  visibleInStates?: string[];          // mounted only in these states (omit = all states)
  style?: Record<string, string | number>; // camelCase CSS overrides (numbers = px); use sparingly
}
```

How it behaves (all automatic once elements are in `stateMachine.htmlForms` or added via `addHtmlFormElement`):
- **Mounting follows state.** An element exists in the DOM only while interactive + its layer is visible + the layer's current state is in `visibleInStates`. Entering/leaving preview mounts/unmounts everything.
- **Submission**: a canvas-drawn submit button uses a `click` transition with a `{ type:'submitForm', formId }` action; **Enter** in a single-line field submits its form; or call `sm.submitUIForm(formId)`. Submission gathers `{ elementId: value }` from the form's mounted members → emits the `formSubmit` UIEvent (always) → fires the `formSubmit` trigger (transitions can gate on `formValid`).
- **`formValid`**: every mounted `required` member is non-empty (checkbox → checked). Use it as a condition on the formSubmit transition to keep the user on the form until it's filled.
- **`variableBinding`** makes form values first-class state-machine data: typing fires variable-watch transitions, and `setVariable` actions write back into the input.
- **`clearForm`** resets a form's fields AND their bound variables; **`focusFormField`** focuses a control (e.g. in a state's `onEnter`).

⚠️ Overlay positions are **canvas CSS px** anchored to the canvas's offset — call `sm.repositionUIForms()` from your resize observer. The overlay is created lazily on first `setUIInteractive(true)`.

---

## 5. Rules & gotchas

- **Interactivity is OFF by default.** Nothing intercepts input or dims the screen until `sm.setUIInteractive(true)`. Turn it off to return to editing. This is the single most important toggle.
- **You must call `sm.tickUI(dt)` every frame in preview** or `timer` transitions and transition **fades** won't advance. (Clicks/keys/hover work without it; only time-based things need the tick.)
- **`shapeId` = the scene-graph node id.** For a 2D shape it's the shape's id; for a 3D button it's the `Mesh3D` node id. Attach interactions to shapes that already exist.
- **Modal dim needs both a `worldBlur` state and a layer `backgroundOverlay`.** A state dims the world only when `worldBlur > 0`; the dim colour comes from the layer's `backgroundOverlay.color` (default black α 0.55). **`worldBlur` is now a TRUE Gaussian blur**: the world behind the UI is replaced with a blurred copy, blended at `min(worldBlur, 1)` strength (so treat it as 0..1; the old "8 px" style values just clamp to full blur). A `setWorldBlur` action blurs dynamically without a modal state (max()ed with the state's value; resets on state change).
- **Buttons must be above-raster vector shapes** to stay crisp over the dim (the normal case). Shapes below the 3D divider get dimmed with the world.
- **`passThroughPointer`**: leave it `true` for a HUD (clicks miss → editing/orbit still work); set `false` for a modal menu that should swallow every click.
- **World control IS applied now.** A state's `frozen: true` (and the `freezeWorld` action) pauses the world clock — shader time (waves/holograms/day-night), animation clips, procedural idle all freeze; UI time keeps running. `setWorldSpeed` scales it (0.5 = slow-mo, 0 = frozen). `setCamera` moves the 3D camera to `position`/`target` — instantly, or **eased over `duration` ms** (the tween runs on UI time, so it still plays inside a frozen pause state). **Animation actions are applied too**: `playAnimation` plays a skeleton clip on `targetId` (a Skeleton3D node id, or a SkinnedMesh3D id — its skeleton is resolved; `clipId` matches the clip's id **or name**, omitted = the first clip; `play` after `pause` resumes in place); `pauseAnimation`/`stopAnimation`/`seekAnimation` control that player. UI-driven players are killed when interactivity turns off (no orphan playback). Effects that Salsa applies are ALSO forwarded to the effectHook, so analytics/bridges see everything.
- **Sound is applied — after you register assets.** The machine speaks `assetId`s; the host maps them to audio: `sm.registerUISound(assetId, url)` (object URL from an upload, data URL, or bundled path; `sm.unregisterUISound` / `sm.listUISounds` round it out). Then `playSound` (restarts from 0; `loop: true` for music beds), `stopSound`, `setVolume` (live + remembered) just work, and everything is silenced when interactivity turns off. Unregistered ids no-op. First playback needs a user gesture (browser autoplay policy) — a click-to-start title screen satisfies it naturally. Registered sounds are **bundled into `.frogcart` on export and auto-re-registered on import** (see §4), so published carts keep their audio.
- **Hover/press micro-animations**: `ShapeInteractionProps.hoverAnimationClipId` loops a clip on the shape while hovered (stops on leave); `pressAnimationClipId` one-shots on click. Skinned 3D targets (the shape resolves to its skeleton).
- **Gamepads just work**: while interactive, `tickUI` polls connected pads — `gamepadButton` fires on press edges, `gamepadAxis` on ±0.5 crossings (standard mapping: axis 0/1 = left stick X/Y, button 0 = A/✕). Triggers dispatch into the ACTIVE UI layer.
- **Transitions are real now**: `fade` dissolves; `slideLeft/Right/Up/Down` sweep a soft curtain across the screen; `wipe` sweeps a hard white edge; `zoom` iris-opens centre-out; `zoomOut` iris-closes edge-in. Because state swaps synchronously, they read as "new state revealed from the curtain," not a true crossfade.
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

> **Full build spec:** [ui-authoring-panel.md](ui-authoring-panel.md) — the concrete panel + **states outliner** UX,
> the **read-edit-commit** editing model (there are no granular mutators; edit the machine object and `setStateMachine`),
> and the step-by-step flow for **binding a drawn shape to a state's visibility**. The sketch below is the summary.

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

1. **Browser-verify the render features first** (Salsa has flagged this): enter preview, drive to a `worldBlur` state → scene dims **and blurs** + menu crisp; play a `slideLeft` and a `wipe` transition → the curtain sweeps (not a plain fade); enter a `frozen: true` state → water/holograms/clip animation freeze, then unfreeze; Tab through focusable buttons → focus ring moves; click a 3D-mesh target; add an HtmlFormElement → the input appears over the canvas, typing drives its bound variable, Enter submits (§4b); `exportFrogcart` → re-`importFrogcart` → `enterUIPlayerMode` plays. ~20 min.
2. **Pump `sm.tickUI(dt)`** in the frame loop while previewing.
3. **Then build the authoring panel** per §7.

---

## 9. Phase status (what's live)

| Area | Status |
|---|---|
| State machine engine (states/transitions/triggers/actions/conditions/variables/history/timers) | ✅ live, tested |
| Layer + shape-interaction API, `onUIEvent`, persistence | ✅ live, tested |
| Pointer hit-test + cursor, keyboard, focus nav | ✅ live (auto-wired) |
| Modal `backgroundOverlay` dim + authored focus ring + 3D-mesh targets | ✅ live — **browser-verify** |
| True Gaussian `worldBlur` (+ dynamic `setWorldBlur` action) | ✅ live — **browser-verify** |
| Real transitions: `fade` / `slideL,R,U,D` / `wipe` / `zoom` / `zoomOut` (scrim mask shader) | ✅ live — **browser-verify** |
| `freezeWorld` / state `frozen` / `setWorldSpeed` (world clock + animation pause) + `setCamera` (with eased `duration` tween) | ✅ live — **browser-verify** |
| Hover/press animation clips (`hoverAnimationClipId` / `pressAnimationClipId`) | ✅ live, tested — **browser-verify** |
| Gamepad triggers (auto-polled in `tickUI`, edge-detected) | ✅ live, tested — **browser-verify** |
| `SceneVariable.persistent` (auto-saved to localStorage, seeded on load) | ✅ live, tested |
| Per-target `playAnimation`/`pause`/`stop`/`seekAnimation` (skeleton clips) | ✅ live, tested — **browser-verify** |
| Sound: `playSound`/`stopSound`/`setVolume` + `registerUISound` asset registry + `.frogcart` audio bundling (auto re-register on import) | ✅ live, tested — **browser-verify** |
| HTML form elements: state-mounted native controls + `formSubmit`/`formValid`/`submitForm`/`clearForm`/`focusFormField` + variable bindings (§4b) | ✅ live, tested — **browser-verify** |
| Portable export/import carries UI layers (`sm.packProject`/`unpackProject`) → playable in-app | ✅ live, tested |
| `.frogcart` export/import + Player mode (`exportFrogcart`/`importFrogcart`/`enterUIPlayerMode`) | ✅ live, tested (§4) |
| Standalone Player **page** (`/player` route) + Export modal (incl. bundled-sounds summary via `listUISounds`) + dashboard drop zone | ✅ LIVE in Frogmarks (thin host over `importFrogcart` + `enterUIPlayerMode`) |
