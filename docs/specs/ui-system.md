# Salsa UI System — Spec

**Status:** Phases 1 & 2 COMPLETE + Phase 3 MOSTLY DONE (2026-08-30) — engine + host adapter + ShapeManager API + pointer/cursor + keyboard/focus + timers + persistence + modal DIM + fade transitions + authored focus ring + 3D-mesh targets, all unit-tested (30 tests). NOT yet (Phase 3 remainder): true Gaussian `worldBlur` (only the flat dim exists), directional slide/wipe shaders (fall back to fade), applying world-control effects (freezeWorld/camera → deferred `effectHook`; no global pause API). Editor → Phase 5; HTML forms → Phase 4; packaging/Player → Phase 6. Aside from the dim/fade, a UI layer drives EXISTING shapes/layers.
**Last Updated:** 2026-08-30

### Implementation log

**2026-08-30 — Phase 3: 3D-MESH interactive targets, +1 test (30 total):**
- `UIManager.setMeshPicker(fn)` (canvas px → picked mesh node id) + `hitTestMesh(cx,cy)` (picked mesh must be an interactive+enabled shape). `pointerDown`/`pointerMove` now take canvas coords too and try the 3D pick when the 2D `hitTest` misses. Renderer hook signature extended to pass `canvasX/Y` (offsetX/offsetY). ShapeManager wires the picker to `scene3d.pick3D(cx, cy, canvas.clientWidth, canvas.clientHeight)?.meshId` — so a Mesh3D whose node id is in `shapeInteractions` is a clickable/hoverable 3D button. Testable via a mock picker; the GPU ray-cast is delegated.

**2026-08-30 — Phase 3: authored FOCUS RING, +1 test (29 total):**
- `ShapeInteractionProps.focusIndicatorShapeId` — a shape the author designed as an element's focus ring (glow/outline). `UIManager._applyFocusVisuals` shows the focused element's indicator + hides all others (reuses the shape-visibility path — no new GPU). Fires on `focusNext`/`focusPrev` and clears on `setInteractive(false)`. Spec-aligned ("author designs the focus visual as a shape").

**2026-08-30 — Phase 3: state-transition FADE, +1 test (28 total):**
- The engine already emits a `transition` effect (animation, from, to) on any animated transition/goTo. `UIManager._startTransition` begins a fullscreen fade (interactive only); `tick(dtMs)` advances `elapsedMs` and repaints; `getActiveOverlay` returns the fade colour with `alpha = 1 - ease(progress)` (fades the NEW state in from black; `wipe` → white) — it takes precedence over the modal dim while playing, then hands back to the dim. Easings: linear/easeIn/easeOut/easeInOut. `ShapeManager.goToUIState(layer, state, animation)` already threads the animation; transitions declared on `StateTransition.animation` fire the same path. ⚠️ slide/zoom/wipe currently fall back to a fade (directional shaders TBD); state swaps synchronously so it reads as fade-IN, not a true crossfade (would need capturing the outgoing framebuffer).

**2026-08-30 — Phase 3 start: modal backgroundOverlay DIM render pass, +1 test (27 total):**
- `UIManager.getActiveOverlay(): [r,g,b,a] | null` — the world-dim for the first visible+live layer whose CURRENT state is modal (`worldBlur > 0`), using that layer's `backgroundOverlay.color` (else default black α .55). Only while interactive. Tested.
- `PipelineManager.createUIScrimRenderPipeline()` / `getUIScrimPipeline()` — a fullscreen NDC quad, one `vec4` colour uniform, alpha-blended, always-pass depth (mirrors the grid-overlay pipeline).
- `WebGPURenderer.renderUIScrim(pass)` (+ `setUIScrimProvider`) — draws the dim BEFORE `drawVectorShapes` (line ~3372), so the world (raster+3D) darkens while the UI's own above-raster vector shapes stay crisp. Reuses the background fullscreen quad (`bgQuadVB`); no-op when the provider returns null/α≤0 → zero impact on editing.
- ShapeManager: wires `setUIScrimProvider(() => this.ui.getActiveOverlay())`; `updateUILayer` (set `backgroundOverlay`); `setUIInteractive` now repaints.
- ⚠️ BROWSER-VERIFY: enter interactive preview, drive to a `worldBlur` state (e.g. pause) → the scene dims, menu stays crisp; assumes the author's buttons are above-raster vector shapes.

**2026-08-30 — Phase 2 completion (timers + keyboard/focus), +4 tests (26 total):**
- Timer triggers: `UIStateMachineRuntime.tick(dtMs)` tracks per-state elapsed time (reset on state entry) + a fired-once set; fires a state's `timer` transition when its delay elapses. `UIManager.tick(dtMs)` (interactive-gated) + `ShapeManager.tickUI(dtMs)` (host calls each frame in preview).
- Keyboard: `WebGPURenderer.setUIKeyHandler` called at the top of `handleKeyDown` (consumes + preventDefaults when the UI took the key; no-op off-preview). `UIManager.handleKey(key,shift)`: Tab→focusNext/Prev, Enter/Space→activateFocused, else→keyDown trigger (Escape→pause etc.).
- Focus nav: `UIManager.focusNext/focusPrev` (focusable shapes by tabIndex, wrap), `getFocusedShape`, `activateFocused` (clicks the focused shape). Visual focus RING is Phase 3 (needs the render pass).
- This completes Phase 2's trigger/action/condition/variable/history vocabulary — all of it was already in the pure engine; timers were the last trigger type.

**2026-08-30 — Phase 1 pointer wiring + persistence (+5 tests, 22 total):**
- Pointer hit-testing in `UIManager`: `hitTest(wx,wy)` (top-most interactive+visible+enabled shape via `node.containsPoint` + z-order; honors `disabled` / `disabledWhenVariable`), `pointerMove` (hover enter/leave → cursor + hover/hoverEnd), `pointerDown` (click dispatch; consumes on hit or when the layer is modal). Gated by `setInteractive(on)` — OFF by default.
- Renderer hook: `WebGPURenderer.setUIPointerHandler({onDown,onMove})` called in `handlePointerDown` (right after the left-button check — UI gets first crack, consumes + returns when it hit) + `handlePointerMove` (sets the hover cursor, idle only). No-ops entirely unless interactive → **zero impact on editing by default**.
- ShapeManager: `setUIInteractive(on)` / `uiInteractive`; wires the handler → `this.ui.pointerDown/pointerMove`.
- Persistence: `DocumentSavePayload.uiLayersJSON` (additive/optional); saved in `gatherDocumentState` (`JSON.stringify(this.ui.serialize())`), restored in `restoreDocumentState` after the scene graph (so interaction props re-attach by shape id) via `this.ui.restore(...)`.

**2026-08-30 — Phase 1 core (engine + manager + API), 17 tests:**
- `src/ui/ui-types.ts` — the full data model (UILayerData, UIStateMachine, SceneState, StateTransition, InteractionTrigger, Action, Condition, SceneVariable, ShapeInteractionProps, HtmlFormElement, TransitionAnimation) + a host-facing `UIEffect` union + `UIEvent`.
- `src/ui/ui-state-machine.ts` — `UIStateMachineRuntime`, a **pure** engine: holds current state / variables / history, and turns triggers into an ordered `UIEffect[]` for the host to apply (never touches layers/renderer/DOM/clock → deterministic, GPU-free). Handles the whole trigger+action+condition vocabulary; cascades (goToState-in-onEnter, variable-watch, stateEnter) are bounded by `MAX_CASCADE_DEPTH` so circular authoring can't hang. Tests: `ui-state-machine.test.ts` (12).
- `src/services/managers/ui-manager.ts` — `UIManager` (delegate, `sm.ui`): owns UI layers + their runtimes + a `UIEvent` EventEmitter; applies effects → real layer visibility (`rasterLayerManager.setVisibility` + `webgpuRenderer.setVectorLayerVisible`), shape visibility (`sceneGraph.findNodeById(id).visible`), `openUrl` (window.open), and emits stateChange/variableChange/custom events. World-control effects (freeze/camera/animation/sound) route to an optional `effectHook` (deferred). Tests: `ui-manager.test.ts` (5).
- `src/services/shape-manager.ts` — wired `this.ui = new UIManager(ctx)` in initDelegates + public API: `createUILayer / getUILayer / setStateMachine / getStateMachine / goToUIState / getCurrentUIState / getUIStateHistory / getUIVariable / setUIVariable / setShapeInteraction / clearShapeInteraction / getShapeInteraction / clickUIShape / onUIEvent`.
- **Design note:** a UI layer is currently a LOGICAL behavior container (not yet a `'ui-layer'` entry in the raster stack, no render pass) — the author draws buttons in an ordinary vector layer and this wires their interactivity. The seam for the real layer-stack entry + on-canvas compositing (backgroundOverlay/worldBlur) + pointer hit-test dispatch (`clickUIShape` is the entry point) is left for the next step.

A custom interactive UI system built on top of Salsa's renderer. Lets creators design styled 2D/2.5D/3D UI — buttons, menus, transitions, navigation — using Salsa's existing drawing tools, then package the result as a distributable `.frogcart` file that runs in the Frogmarks Player.

---

## Vision

Persona 5's menus are as visually memorable as the game's art. Nintendo's UI has a physical satisfaction that HTML/CSS cannot replicate. Both are possible here because they are not HTML — they are custom-rendered vector geometry, animated with full keyframe control, composited over a 3D scene.

The key insight: **Salsa's existing tools are already the right UI design tools.** The polygon tool draws buttons. The keyframe system drives hover/press animations. The GP renderer draws stylized borders. The layer stack is already a compositing system. The UI system is not a new renderer — it is an interaction and state machine layer attached to the existing one.

---

## Goals

- Any shape in any Salsa layer can be made interactive (clickable, hoverable, focusable)
- A scene-level state machine routes between named states (title screen, settings, scene select, dialogue, etc.)
- State transitions control layer visibility, camera position, animation playback, and world freeze
- Variables (boolean/number/string) enable branching logic without scripting
- HTML-in-Canvas provides browser-native form inputs (text fields, dropdowns, checkboxes) when needed
- The full system packages into a `.frogcart` file that runs in the standalone Frogmarks Player
- All of this is opt-in — projects without a UI layer are completely unaffected

## Non-Goals

- A scripting language (no user JS execution in v1; actions are a typed vocabulary)
- Physics-based UI (spring animations are handled by the keyframe/animation system, not the UI system)
- Multi-player / server-synchronized state
- Native mobile app packaging (`.frogcart` targets the browser)

---

## Architecture Overview

```
Frogmarks Scene
  ├── Layer Stack (raster, 3D scene, GP, ...)
  │     └── [any shape can have ShapeInteractionProps]
  │
  └── UI Layer  ← new layer type; sits on top; owns the state machine
        ├── UIStateMachine
        │     ├── SceneState[]       — named screens/modes
        │     ├── StateTransition[]  — event → state change rules
        │     ├── SceneVariable[]    — boolean/number/string runtime values
        │     └── HtmlFormElement[]  — positioned native HTML form controls
        │
        └── Renderer
              ├── Salsa GPU renderer (polygon shapes, GP strokes, text, 3D UI meshes)
              └── HTML overlay layer (form elements, positioned over canvas via CSS)
```

The UI layer composites last — on top of 3D content, raster layers, and GP layers. It can optionally render a semi-transparent background overlay behind its own shapes to dim the world content.

Hit testing for interactions uses the existing 2D shape picker for polygon/GP shapes and `worldToScreen3D` + ray-OBB for 3D mesh UI elements.

---

## Data Model

### UILayer

```typescript
interface UILayerData {
  id: string;
  name: string;
  type: 'ui-layer';
  visible: boolean;

  /** The state machine that governs this scene's interactivity. */
  stateMachine: UIStateMachine;

  /**
   * When true, pointer events that do not hit any interactive shape
   * pass through to layers below (orbit camera, brush tool, etc.).
   * When false, the UI layer captures all pointer events while visible.
   */
  passThroughPointer: boolean;

  /**
   * Optional semi-transparent overlay drawn behind UI shapes
   * to dim the world content when a modal-style UI is active.
   */
  backgroundOverlay?: { color: [number, number, number, number] };

  /** Per-shape interaction props, keyed by shapeId. Shapes can live in any layer. */
  shapeInteractions: Record<string, ShapeInteractionProps>;
}
```

---

### UIStateMachine

```typescript
interface UIStateMachine {
  id: string;

  /** ID of the state shown on scene load. */
  initialStateId: string;

  states: SceneState[];
  transitions: StateTransition[];
  variables: SceneVariable[];

  /**
   * HTML form elements positioned over the canvas.
   * Each element is shown/hidden according to its `visibleInStates` list.
   */
  htmlForms: HtmlFormElement[];

  /**
   * Transitions that are active regardless of which state is current.
   * Use for global keyboard shortcuts (e.g. Escape → pause menu from any state).
   */
  globalTransitions?: StateTransition[];
}
```

---

### SceneState

A named mode of the scene. Defines which layers are visible, what's playing, and whether the world is frozen.

```typescript
interface SceneState {
  id: string;
  name: string;

  /** Layer visibility overrides for this state. Omitted layers keep their current visibility. */
  layerVisibility: Record<string, boolean>;

  /** Fine-grained per-shape visibility overrides (for showing/hiding individual buttons). */
  shapeVisibility: Record<string, boolean>;

  /**
   * When true, all AnimationPlayer3D instances and NLA tracks are paused
   * while this state is active. The 3D scene is frozen in time.
   * Use for pause screens, inventory menus, dialogue boxes.
   */
  frozen: boolean;

  /** Actions executed once when this state becomes active. */
  onEnter?: Action[];

  /** Actions executed once when leaving this state (before onEnter of the next state). */
  onExit?: Action[];

  /**
   * If set, a blur effect is applied to the scene content beneath the UI layer.
   * Useful for modal dialogs, pause screens.
   */
  worldBlur?: number;  // 0–20px equivalent, GPU Gaussian blur on the world framebuffer
}
```

---

### StateTransition

A rule: when `trigger` fires (optionally satisfying `conditions`), run `actions` and move to `toState`.

```typescript
interface StateTransition {
  id: string;

  /**
   * Source state ID. '*' means this transition fires from any state.
   * Used for global shortcuts (globalTransitions also supports this).
   */
  fromState: string | '*';

  /** Destination state ID. */
  toState: string;

  trigger: InteractionTrigger;

  /** All conditions must be true for the transition to fire. */
  conditions?: Condition[];

  /** Side-effect actions to run during the transition (before onEnter of toState). */
  actions?: Action[];

  /** Visual animation played between states. */
  animation?: TransitionAnimation;
}
```

---

### InteractionTrigger

All the ways a transition can be triggered:

```typescript
type InteractionTrigger =
  // Pointer interactions on a specific shape
  | { type: 'click';     targetId: string }
  | { type: 'hover';     targetId: string }
  | { type: 'hoverEnd';  targetId: string }
  | { type: 'pointerDown'; targetId: string }
  | { type: 'pointerUp';   targetId: string }

  // Keyboard
  | { type: 'keyDown';   key: string }   // e.g. 'Escape', 'Enter', 'ArrowUp'
  | { type: 'keyUp';     key: string }

  // Automatic
  | { type: 'timer';     delay: number } // fire N ms after entering fromState

  // Variable watch — fires when variable reaches a condition
  | { type: 'variable';  variableId: string; op: '==' | '!=' | '>' | '<' | '>=' | '<='; value: number | string | boolean }

  // Form submission
  | { type: 'formSubmit'; formId: string }

  // State lifecycle
  | { type: 'stateEnter'; stateId: string }  // fires when a specific state is entered
  | { type: 'stateExit';  stateId: string }

  // Gamepad (Phase 2+)
  | { type: 'gamepadButton'; button: number }
  | { type: 'gamepadAxis';   axis: number; direction: 'positive' | 'negative' };
```

---

### Action

All the things a transition can do:

```typescript
type Action =
  // Navigation
  | { type: 'goToState';       stateId: string; animation?: TransitionAnimation }
  | { type: 'goBack' }                        // return to previous state (stack-based history)
  | { type: 'openUrl';         url: string; target?: '_blank' | '_self' | '_parent' }

  // Layer/shape visibility
  | { type: 'showLayer';       layerId: string }
  | { type: 'hideLayer';       layerId: string }
  | { type: 'showShape';       shapeId: string }
  | { type: 'hideShape';       shapeId: string }
  | { type: 'toggleLayer';     layerId: string }
  | { type: 'toggleShape';     shapeId: string }

  // Animation
  | { type: 'playAnimation';   targetId: string; clipId?: string; loop?: boolean }
  | { type: 'stopAnimation';   targetId: string }
  | { type: 'pauseAnimation';  targetId: string }
  | { type: 'seekAnimation';   targetId: string; frame: number }

  // World state
  | { type: 'freezeWorld';     frozen: boolean }
  | { type: 'setWorldSpeed';   speed: number }    // 0 = paused, 1 = normal, 0.5 = slow-mo
  | { type: 'setCamera';       position?: [number, number, number]; target?: [number, number, number]; duration?: number }

  // Variables
  | { type: 'setVariable';     variableId: string; value: number | string | boolean }
  | { type: 'addVariable';     variableId: string; amount: number }
  | { type: 'toggleVariable';  variableId: string }

  // Sound (Phase 2+)
  | { type: 'playSound';       assetId: string; volume?: number; loop?: boolean }
  | { type: 'stopSound';       assetId: string }
  | { type: 'setVolume';       assetId: string; volume: number }

  // Forms
  | { type: 'clearForm';       formId: string }
  | { type: 'focusFormField';  elementId: string }

  // Frogmarks host communication
  | { type: 'emitEvent';       eventName: string; payload?: Record<string, unknown> };
  // emitEvent fires a named event that Frogmarks can listen to via sm.onUIEvent().
  // Enables custom logic in Frogmarks (e.g. "sceneUnlocked" → update Frogmarks's own state).
```

---

### Condition

Guards on transitions — all must pass for the transition to fire:

```typescript
type Condition =
  | { type: 'variable';     variableId: string; op: '==' | '!=' | '>' | '<' | '>=' | '<='; value: number | string | boolean }
  | { type: 'stateHistory'; stateId: string; visited: boolean }  // has the user been to this state?
  | { type: 'formValid';    formId: string }                      // are all required fields filled?
  | { type: 'not';          condition: Condition };               // logical NOT
```

---

### SceneVariable

Runtime values that persist across state transitions and drive conditional logic:

```typescript
interface SceneVariable {
  id: string;
  name: string;
  type: 'boolean' | 'number' | 'string';
  defaultValue: boolean | number | string;

  /**
   * When true, the variable's value is saved to localStorage keyed by scene ID.
   * Use for progress tracking, unlockables, settings.
   * When false (default), variable resets to defaultValue on scene reload.
   */
  persistent: boolean;
}
```

Example variables: `hasVisitedSettings` (boolean), `selectedCharacterIndex` (number), `playerName` (string), `musicEnabled` (boolean, persistent).

---

### ShapeInteractionProps

Attached to any shape in any layer to make it respond to pointer/keyboard events:

```typescript
interface ShapeInteractionProps {
  shapeId: string;

  /** CSS cursor style when pointer is over this shape. */
  cursor?: 'pointer' | 'default' | 'text' | 'grab' | 'crosshair' | 'none';

  /** Animation clip to play while the shape is hovered (loops until hover ends). */
  hoverAnimationClipId?: string;

  /** Animation clip to play on press (plays once). */
  pressAnimationClipId?: string;

  /** Whether this shape can receive keyboard focus (tab-navigable). */
  focusable?: boolean;

  /** Tab order index (lower = earlier in tab sequence). */
  tabIndex?: number;

  /** ARIA label for screen readers. */
  ariaLabel?: string;

  /** When true, pointer events are ignored. Shape appears but does not respond. */
  disabled?: boolean;

  /** ID of a SceneVariable. When the variable is falsy, shape is auto-disabled. */
  disabledWhenVariable?: string;
}
```

---

### HtmlFormElement

Browser-native form controls positioned over the canvas. Salsa owns the layout (position in scene/canvas coordinates); the browser renders the native control.

```typescript
interface HtmlFormElement {
  id: string;
  type: 'text' | 'password' | 'number' | 'email' | 'tel'
      | 'textarea' | 'select' | 'checkbox' | 'radio';

  /**
   * Position in canvas pixels (top-left origin).
   * The HTML element is absolutely positioned over the canvas at these coords.
   * When the canvas resizes, positions are recalculated proportionally.
   */
  canvasBounds: { x: number; y: number; width: number; height: number };

  placeholder?: string;
  label?: string;           // visually rendered via canvas GP text above the element
  required?: boolean;
  options?: string[];       // for select / radio

  /**
   * Two-way binding: element value ↔ SceneVariable.
   * Reading the variable gives the current input value.
   * Setting the variable updates the input programmatically.
   */
  variableBinding?: string;

  /** State IDs in which this form element is visible. Hidden in all others. */
  visibleInStates?: string[];

  /** CSS overrides applied to the HTML element. Use sparingly — prefer canvas-rendered labels. */
  style?: {
    fontSize?: number;
    fontFamily?: string;
    color?: string;
    backgroundColor?: string;
    border?: string;
    borderRadius?: number;
    padding?: string;
    outline?: string;
  };
}
```

**How HTML forms work:** Salsa creates `<div class="salsa-ui-form-overlay">` absolutely positioned over the canvas. Each `HtmlFormElement` becomes an `<input>` or `<select>` inside that div. On state transitions, the div's child elements are shown/hidden. Variable bindings are kept in sync via `input` event listeners. The visual label and decorative border around each field are drawn on canvas by the GP renderer (the author designs these like any other GP shape).

---

### TransitionAnimation

Visual effect played between two states:

```typescript
interface TransitionAnimation {
  type: 'none' | 'fade' | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown'
      | 'zoom' | 'zoomOut' | 'wipe' | 'custom';

  /** Duration in milliseconds. */
  duration: number;

  /** CSS easing or WGSL-equivalent for GPU passes. */
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring';

  /**
   * For 'custom': ID of a GP animation clip or 3D animation that plays
   * as the transition. The outgoing state freezes, the incoming state
   * appears after the clip finishes.
   */
  customClipId?: string;
}
```

Transitions are implemented as a short fullscreen GPU effect between the "out" and "in" state renders. For `fade`: two framebuffer textures blended over `duration` ms. For `slide`: the in-state texture slides in from one edge while the out-state slides out. For `custom`: a Salsa animation clip plays, then the new state renders.

---

## Interaction Hit Testing

**2D shapes (polygon, GP stroke, path):**  
Uses the existing 2D shape picker infrastructure. The UI layer registers a pointer-move / pointer-down listener on the canvas (below the orbit controller, above brush tool handlers in z-priority). Hit testing checks shapes in `shapeInteractions` against canvas pointer coordinates using point-in-polygon (winding number test for filled shapes, stroke distance test for paths).

**3D mesh UI elements:**  
Any `Mesh3D` can also appear in `shapeInteractions`. Hit testing uses `MeshPicker.pickMesh` restricted to the set of interactive meshes. Enables 3D buttons that exist in world space (e.g. a floating holographic panel).

**Pointer event priority:**
1. UI layer interactive shapes (consume event if hit)
2. If `passThroughPointer = true` and no hit: pass to orbit controller / brush tool
3. If `passThroughPointer = false`: consume all events regardless

**Focus / keyboard navigation:**  
Tab key cycles through focusable shapes in `tabIndex` order. The focused shape receives a "focus" visual state (the author designs this via a separate visible/hidden shape in the same layer — a glow polygon, an outline stroke, etc.). Enter/Space triggers `click` on the focused shape.

---

## World Freeze

When the active state has `frozen: true`:

```typescript
// Pseudocode — what happens on state enter when frozen = true:
for (const player of allAnimationPlayers) player.pause();
for (const [id, nlap] of nlaPlayers) nlap.pause();
clothSimulator?.pause();
particleEmitters.forEach(e => e.pause());
worldTimeSpeed = 0;
```

On state exit:
```typescript
for (const player of frozenPlayers) player.resume();
worldTimeSpeed = 1;
```

The UI layer's own animations (button hover effects, transition animations) continue to run regardless of world freeze — they operate on a separate "UI time" that is never paused.

---

## State History (Back Navigation)

The state machine maintains a navigation stack:

```typescript
// Internal state:
stateHistory: string[] = [];  // stack of visited state IDs

// On goToState:
stateHistory.push(currentStateId);
currentStateId = newStateId;

// On goBack:
currentStateId = stateHistory.pop() ?? initialStateId;
```

The `goBack` action enables Escape key → previous menu, breadcrumb-style navigation, and wizard flows.

---

## `.frogcart` Packaging Format

A `.frogcart` is a ZIP archive with the extension renamed. It is self-contained — every asset the scene needs is bundled.

```
my-scene.frogcart (ZIP)
  manifest.json
  scene.salsa               ← full project file (OPFS format, binary or JSON)
  state-machine.json        ← extracted UIStateMachine (pre-parsed for the Player)
  player-config.json        ← Player runtime settings
  assets/
    textures/               ← all texture assets referenced by the scene
    audio/                  ← sound files (Phase 2+)
    fonts/                  ← any custom fonts used by GP text
```

### manifest.json

```json
{
  "version": "1.0",
  "frogmartsPlayerMinVersion": "1.0.0",
  "sceneId": "abc123",
  "title": "My Interactive Scene",
  "author": "username",
  "description": "...",
  "thumbnail": "assets/textures/thumbnail.png",
  "createdAt": "2026-06-07T00:00:00Z",
  "tags": ["ps1", "interactive", "portfolio"]
}
```

### player-config.json

```json
{
  "initialState": "title",
  "aspectRatio": "4:3",
  "canvasWidth": 1280,
  "canvasHeight": 960,
  "lockAspectRatio": true,
  "allowFullscreen": true,
  "backgroundColor": "#000000",
  "showLoadingScreen": true,
  "loadingScreenColor": "#000000",
  "deepLinkStateParam": "state"
}
```

### Export API

```typescript
// Export current project as a .frogcart Blob:
const blob = await sm.exportFrogcart({
  title: 'My Scene',
  author: 'me',
  description: 'An interactive PS1-style scene',
});

// Trigger download:
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'my-scene.frogcart';
a.click();
URL.revokeObjectURL(url);
```

---

## Frogmarks Player

A standalone minimal runtime (`player.frogmarks.app`) that loads and runs `.frogcart` files. No editor UI. No toolbars. Just the rendered scene with its interaction system active.

### Player Features

- Load `.frogcart` from URL parameter: `player.frogmarks.app?cart=https://...`
- Drag-and-drop a local `.frogcart` file onto the player page to open it
- iframe-embeddable: `<iframe src="player.frogmarks.app?cart=..."></iframe>`
- Deep linking: `?state=settingsMenu` loads the scene at a specific state
- Fullscreen toggle
- Host page communication via `postMessage` (for Frogmarks integration)

### Player `postMessage` API

The Player emits messages that the embedding page can listen to:

```typescript
// Events from Player to parent page:
{ type: 'frogcart:ready' }
{ type: 'frogcart:stateChange', from: string, to: string }
{ type: 'frogcart:uiEvent', eventName: string, payload: Record<string, unknown> }  // from emitEvent actions
{ type: 'frogcart:urlOpen', url: string, target: string }  // before navigating away

// Messages from parent page to Player:
{ type: 'frogcart:goToState', stateId: string }
{ type: 'frogcart:setVariable', variableId: string, value: unknown }
{ type: 'frogcart:getVariable', variableId: string }   // Player responds with uiEvent
```

This lets Frogmarks (the host page) react to scene events — e.g. a "sceneComplete" emitEvent action can tell Frogmarks to unlock the next scene in a playlist.

---

## ShapeManager Public API

New methods on `ShapeManager`:

```typescript
// ── UI Layer ────────────────────────────────────────────────────

/** Create a UI layer (sits on top of all other layers). Returns the layer ID. */
createUILayer(name?: string): string;

/** Get the UILayerData for a UI layer. */
getUILayer(layerId: string): UILayerData | null;

/** Update top-level UI layer properties (passThroughPointer, backgroundOverlay, etc.). */
updateUILayer(layerId: string, updates: Partial<UILayerData>): void;

// ── State Machine ────────────────────────────────────────────────

/** Set the full state machine on a UI layer (replaces existing). */
setStateMachine(layerId: string, machine: UIStateMachine): void;

/** Get the current state machine. */
getStateMachine(layerId: string): UIStateMachine | null;

/** Programmatically move to a named state. */
goToState(layerId: string, stateId: string, animation?: TransitionAnimation): void;

/** Get the currently active state ID. */
getCurrentState(layerId: string): string | null;

/** Get the state history stack. */
getStateHistory(layerId: string): string[];

// ── Variables ────────────────────────────────────────────────────

/** Read a scene variable's current value. */
getUIVariable(layerId: string, variableId: string): boolean | number | string | null;

/** Set a scene variable. Triggers any variable-watch transitions. */
setUIVariable(layerId: string, variableId: string, value: boolean | number | string): void;

// ── Shape Interactions ───────────────────────────────────────────

/** Attach interaction properties to a shape (shape can be in any layer). */
setShapeInteraction(shapeId: string, props: ShapeInteractionProps): void;

/** Remove interaction properties from a shape. */
clearShapeInteraction(shapeId: string): void;

/** Get current interaction props for a shape. */
getShapeInteraction(shapeId: string): ShapeInteractionProps | null;

// ── HTML Form Elements ───────────────────────────────────────────

/** Add a native HTML form element positioned over the canvas. */
addHtmlFormElement(layerId: string, element: HtmlFormElement): void;

/** Remove a form element by ID. */
removeHtmlFormElement(layerId: string, elementId: string): void;

/** Get the current value of a form element (reads from the DOM). */
getFormValue(elementId: string): string | boolean | null;

// ── Events ───────────────────────────────────────────────────────

/**
 * Subscribe to UI interaction events and emitEvent actions.
 * Returns an unsubscribe function.
 *
 * @example
 * const off = sm.onUIEvent((e) => {
 *   if (e.type === 'stateChange') console.log(`Went to: ${e.toState}`);
 *   if (e.type === 'custom' && e.eventName === 'sceneComplete') unlockNext();
 * });
 */
onUIEvent(callback: (event: UIEvent) => void): () => void;

// ── Packaging ────────────────────────────────────────────────────

/** Export the current project as a .frogcart Blob. */
exportFrogcart(options?: FrogcartExportOptions): Promise<Blob>;
```

### UIEvent Types

```typescript
type UIEvent =
  | { type: 'stateChange';   fromState: string; toState: string }
  | { type: 'shapeClick';    shapeId: string }
  | { type: 'shapeHover';    shapeId: string }
  | { type: 'shapeHoverEnd'; shapeId: string }
  | { type: 'variableChange'; variableId: string; oldValue: unknown; newValue: unknown }
  | { type: 'formSubmit';    formId: string; values: Record<string, string | boolean> }
  | { type: 'custom';        eventName: string; payload?: Record<string, unknown> };
```

---

## Frogmarks Editor UI

### UI Layer Panel

When a UI Layer is selected in the layer list, the right panel shows:

```
▸ UI LAYER ─────────────────────────────
  Name    [UI Layer 1]
  [✓] Pass-through pointer
  Overlay  [■] 0.4 opacity

▸ STATE MACHINE ────────────────────────
  [Open State Machine Editor]   ← opens the flowchart editor
  Current state: [title ▾]      ← live dropdown during preview
  Variables: 3   States: 5

▸ SHAPE INTERACTIONS ───────────────────
  (Select a shape to assign interactions)
  (No shape selected)

▸ HTML FORMS ───────────────────────────
  [+ Add Form Field]
  text    "playerName"    [Edit] [✕]
  select  "difficulty"    [Edit] [✕]
```

### Shape Interaction Panel

When a shape is selected AND a UI layer exists:

```
▸ INTERACTION ──────────────────────────
  Cursor     [Pointer ▾]
  Focusable  [✓]  Tab index [1]
  ARIA label [Start Button]
  Disabled   [  ]

  Hover animation  [hover_glow ▾]
  Press animation  [press_shrink ▾]
```

### State Machine Editor

A dedicated full-panel (or modal) flowchart editor:

```
┌─────────────────────────────────────────────────────────────┐
│  State Machine — "My Scene"              [+ State]  [▶ Test] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌───────────┐          click:btnStart          ┌────────┐ │
│   │  [title]  │ ──────────────────────────────▶ │ [game] │ │
│   └───────────┘                                  └────────┘ │
│         │  click:btnSettings                          │      │
│         ▼                                   Esc:goBack│      │
│   ┌──────────────┐    click:btnBack                   ▼      │
│   │  [settings]  │ ◀─────────────────────────── [pause]│     │
│   └──────────────┘                                         │ │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Selected: [title → game]                                   │
│  Trigger:  click on [Start Button]                          │
│  Actions:  playAnimation("title_exit") → goToState("game")  │
│  Animation: fade, 300ms, easeOut                            │
└─────────────────────────────────────────────────────────────┘
```

States are draggable nodes. Transitions are drawn as arrows between states. Click a transition arrow to edit its trigger, conditions, and actions. A "Test" button activates preview mode inside the editor.

---

## Interaction With Existing Systems

### How UI Layer + PS1 Style Work Together

A PS1-style scene with custom UI is exactly as intended. The UI Layer renders at the same reduced resolution as the rest of the scene (if `renderResolution` is set), so button outlines stagger, menu text is pixelated, and hover effects animate at lo-fi resolution. The whole thing looks native to the aesthetic.

Alternatively: render the world at low resolution but render the UI Layer at full canvas resolution (crisp UI over pixelated world — a common stylistic choice in modern lo-fi games). This requires the UI layer to opt out of the low-res render buffer.

### How GP + UI Layer Work Together

GP strokes are ideal for UI decorative elements — animated underlines, selection brackets, ink-drawn button borders. Place GP shapes in the UI layer. Assign hover animations that play a GP stroke animation (the border draws itself in). No special integration needed — GP rendering already happens last in the pipeline.

### How 3D + UI Layer Work Together

3D meshes can serve as UI elements: a rotating emblem, a floating cursor, a 3D button that depresses on press. Set `mesh.material.renderStyle = 'gouraud'` for PS1-style shading. Assign the mesh to `shapeInteractions` for click/hover events. The mesh renders in the 3D pass; the interaction system detects hits via `MeshPicker`.

---

## Frogcart Use Cases

| Use case | How it works |
|----------|-------------|
| **Title screen → scene select → scene** | 3 states, 2 transitions, no variables |
| **Pause menu (Escape from any state)** | globalTransition: Escape → pause state, frozen=true |
| **Settings screen with save** | HTML form fields bound to persistent variables |
| **Branching visual novel** | Variable tracks story flags; conditions on transitions enable branching |
| **Portfolio with scene routing** | States = scenes; clicking artwork → opens scene or URL |
| **Interactive game map** | Shape per location; click → goToState with slide transition |
| **PS1-style main menu** | Low-res render, Gouraud shading, polygon tool buttons, hover animations |
| **Dialogue box system** | State per dialogue line; keyboard/click → next; variable tracks progress |

---

## Implementation Phases

### Phase 1 — Core Interaction System (~2–3 sessions)

- `UILayerData` type and layer creation
- `ShapeInteractionProps` — click and hover events on 2D polygon/path shapes (point-in-polygon hit test)
- Basic `Action` vocabulary: `goToState`, `showLayer`, `hideLayer`, `showShape`, `hideShape`, `openUrl`, `emitEvent`
- `SceneState` with `layerVisibility`, `shapeVisibility`, `frozen`
- `StateTransition` with `click` trigger
- `goToState` / `getCurrentState` / `onUIEvent` API on ShapeManager
- Pointer cursor changes on hover

### Phase 2 — Full State Machine (~2–3 sessions)

- All `InteractionTrigger` types (keyboard, timer, variable watch, form)
- All `Action` types (animation, variable, camera, world speed, sound)
- `SceneVariable` (get/set, persistent, variable-watch triggers)
- `Condition` guards on transitions
- State history stack + `goBack` action
- `globalTransitions` (active from any state)
- `onEnter` / `onExit` action lists on states

### Phase 3 — Visual Polish (~1–2 sessions)

- `TransitionAnimation` (fade, slide, zoom, custom clip)
- `worldBlur` on states (GPU Gaussian blur on world framebuffer)
- `backgroundOverlay` on UI layer
- Hover/press animation clips on shapes
- Focus ring (tab navigation, keyboard Enter/Space to click)
- 3D mesh shapes as interactive targets (via MeshPicker)

### Phase 4 — HTML Forms (~1 session)

- `HtmlFormElement` — positioned native HTML controls over the canvas
- Variable two-way binding
- `visibleInStates` show/hide logic
- `formSubmit` trigger
- Canvas-rendered labels and decorative borders (GP shapes designed by the author)

### Phase 5 — State Machine Editor (~4–5 sessions)

- Flowchart canvas in Frogmarks (draggable state nodes, arrow transitions)
- Shape Interaction panel (assign events per-shape in the inspector)
- Preview / test mode (run state machine in editor without leaving edit mode)
- Variable inspector (live variable values during preview)
- State properties panel (visibility overrides, frozen flag, onEnter actions)

### Phase 6 — Packaging + Player (~3–4 sessions)

- `exportFrogcart()` on ShapeManager
- Asset bundling (textures, fonts into ZIP)
- Frogmarks Player page (loads `.frogcart`, runs state machine, no editor)
- iframe embed + `postMessage` host API
- Deep link via `?state=` URL parameter
- Drag-and-drop local `.frogcart` support in Player

### Phase 7 — Advanced (~future)

- Sound system (audio assets, playSound/stopSound actions)
- Gamepad / touch input triggers
- Visual scripting node editor (for complex conditional logic beyond the condition vocabulary)
- Analytics events (track which states users visit, where they drop off)
- Scene playlist (multiple `.frogcart` files in a series, Player advances between them)
- Accessibility pass (full ARIA, screen reader announcement of state changes)

---

## Design Principles

**Non-destructive.** A project without a UI layer is completely unaffected. No performance cost. No API changes to existing features.

**Author shapes the UI; the system wires the behavior.** The creator draws buttons with the polygon tool and animates them with keyframes — the same way they create everything else in Salsa. The UI system adds interaction semantics on top.

**No scripting in v1.** The action vocabulary covers the common cases. When a creator needs logic that the vocabulary can't express, they use `emitEvent` to hand off to Frogmarks. Scripting would be powerful but introduces security, sandboxing, and debugging complexity that isn't worth it for a first version.

**The Player is minimal.** It is a renderer + state machine runtime. No editor code ships in the Player. The separation keeps the Player fast to load and trivially embeddable.
