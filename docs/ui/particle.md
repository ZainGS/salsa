# Frogmarks Particle Emitter UI Spec
**Last Updated:** 2026-04-28  

**Date:** 2026-05-07 (updated 2026-05-07)  
**Status:** Engineering handoff — build the UI against this spec

---

## What This Feature Is

A particle emitter is a 3D scene-graph node that continuously spawns and simulates small billboard sprites (camera-facing quads). It lives in the same scene as Mesh3D objects. The simulation runs on the CPU; every frame Salsa uploads a compact GPU buffer and draws all particles in one billboard pass.

Particles are **not** mesh objects. They don't appear in the mesh outliner. They need their own dedicated panel or section, similar to how cloth has its own modal.

---

## The API Surface (what Salsa exposes)

All calls go through `shapeManager`:

```typescript
// Create — returns an opaque string ID
const id = shapeManager.addParticleEmitter3D(x, y, z, config?, preset?)

// Destroy
shapeManager.removeParticleEmitter3D(id)

// Update any config field (partial update, all fields optional)
shapeManager.setParticleEmitterConfig3D(id, partialConfig)

// Get the node (for position changes, visibility toggle)
const node = shapeManager.getParticleEmitter3D(id)   // returns null if not found

// Bloom glow pass (applies to all particle emitters)
shapeManager.enableBloom3D(threshold?, intensity?)
shapeManager.disableBloom3D()
shapeManager.setBloomThreshold3D(t)    // 0–1; default 0.5; lower = more particles bloom
shapeManager.setBloomIntensity3D(v)    // multiplier; default 1.2; higher = brighter halos
```

### Config object — full shape

```typescript
interface ParticleEmitterConfig {
  maxParticles?:  number               // hard cap, default 200
  emitRate?:      number               // particles/second, default 30
  lifetime?:      [number, number]     // [min, max] seconds, default [1, 2]
  startSize?:     [number, number]     // [min, max] world units, default [0.05, 0.15]
  endSize?:       [number, number]     // [min, max] world units, default [0, 0]
  startColor?:    { r, g, b, a }      // color at birth, default white opaque
  endColor?:      { r, g, b, a }      // color at death, default white transparent
  speed?:         [number, number]     // [min, max] units/sec, default [0.3, 0.8]
  spread?:        number               // cone half-angle radians; 0=stream, π=sphere
  gravity?:       [number, number, number]   // [x, y, z] accel per second, default [0, -0.3, 0]
  turbulence?:    number               // random velocity kick/sec, default 0
  direction?:     [number, number, number]   // emit direction local space, default [0, 1, 0]
  loop?:          boolean              // false = one burst then stop, default true
  textureIndex?:  number               // texture atlas layer (0 = white default); ignored when animTextures set
  animTextures?:  string[]             // TextureLibrary IDs for flipbook animation
  animFrameTime?: number               // seconds per flipbook frame, default 0.1
}
```

### Moving / hiding an emitter after creation

```typescript
const node = shapeManager.getParticleEmitter3D(id)
if (node) {
  node.setPosition3D(x, y, z)   // repositions emitter in 3D world space
  node.visible = false           // hides without destroying (particles stop rendering)
  node.visible = true            // re-enables
}
```

---

## Presets

Four built-in presets ship with Salsa. Pass the preset name as the second argument to `addParticleEmitter3D`. You can override any field on top of a preset.

| Preset | Visual | Key params |
|--------|--------|-----------|
| `'dust'` | Slow drifting motes, brownish-tan, full sphere spread | Low speed, long lifetime, gentle gravity, turbulence |
| `'sparks'` | Fast orange-to-red streaks, narrow cone | High speed, short life, strong gravity |
| `'snow'` | Large soft white flakes, full sphere | Low speed, very long life, low gravity, direction downward |
| `'magic'` | Purple-to-violet orbs, full sphere | Medium speed, slight upward gravity, turbulence |

```typescript
// Start with a preset, no overrides
const id = shapeManager.addParticleEmitter3D(0, 0, 0, {}, 'sparks')

// Preset + override one field
const id = shapeManager.addParticleEmitter3D(0, 0, 0, { emitRate: 80 }, 'magic')
```

---

## Proposed UI

### Where It Lives

Add a **Particles** section in the 3D scene panel, below the mesh list. It should be collapsible. Particle emitters are not part of the mesh outliner tree — they are a parallel list in the same panel.

### Particles List

A flat list of all active particle emitters. Each row:

```
[●] Dust Emitter 1        [Edit]  [×]
[●] Sparks at origin      [Edit]  [×]
```

- `[●]` — colored dot matching the emitter's startColor; click to toggle visibility
- Name — click to rename inline
- `[Edit]` — opens the edit panel (see below)
- `[×]` — deletes the emitter

**Add new button** at bottom of the list:

```
[+ Add Particle Emitter]
```

Clicking opens a **preset picker** (see below), then adds to the list.

---

### Preset Picker (Add Flow)

A small dropdown or popup grid with 5 options:

```
┌─────────────────────────────────────────┐
│  Choose a starting preset               │
│                                         │
│  [Dust]   [Sparks]  [Snow]  [Magic]     │
│                                         │
│  [Custom (empty)]                       │
└─────────────────────────────────────────┘
```

After selecting, the emitter is created at world origin `(0, 0, 0)` and starts running immediately. The edit panel opens automatically.

---

### Edit Panel

A side panel or modal (similar in style to the cloth modal). Divided into sections.

#### Section 1 — Position

```
X  [  0.00  ]    Y  [  0.00  ]    Z  [  0.00  ]
```

Calls `node.setPosition3D(x, y, z)` on change (via `getParticleEmitter3D(id)`).

---

#### Section 2 — Emission

| Control | Maps to | Range | Notes |
|---------|---------|-------|-------|
| Emit Rate | `emitRate` | 1 – 500 particles/s | Slider + number input |
| Max Particles | `maxParticles` | 10 – 2000 | Slider + number input; warn above 1000 |
| Loop | `loop` | toggle | Off = single burst |
| Direction X/Y/Z | `direction[0/1/2]` | –1 to 1 each | Three sliders, auto-normalize on change |
| Spread | `spread` | 0 – 180° (map to 0–π internally) | 0° = stream, 180° = sphere; show as degrees |

---

#### Section 3 — Lifetime & Speed

| Control | Maps to | Range |
|---------|---------|-------|
| Lifetime Min | `lifetime[0]` | 0.1 – 20 s | Slider + input |
| Lifetime Max | `lifetime[1]` | 0.1 – 20 s | Slider + input; clamp ≥ min |
| Speed Min | `speed[0]` | 0 – 10 | Slider + input |
| Speed Max | `speed[1]` | 0 – 10 | Slider + input; clamp ≥ min |

---

#### Section 4 — Size

| Control | Maps to | Range | Notes |
|---------|---------|-------|-------|
| Start Size Min | `startSize[0]` | 0.01 – 5 | |
| Start Size Max | `startSize[1]` | 0.01 – 5 | |
| End Size Min | `endSize[0]` | 0 – 5 | 0 = particle shrinks to nothing |
| End Size Max | `endSize[1]` | 0 – 5 | |

---

#### Section 5 — Color

Two color pickers side by side, labeled **Birth** and **Death**:

```
[Birth color swatch + alpha slider]    [Death color swatch + alpha slider]
```

- Birth maps to `startColor { r, g, b, a }`
- Death maps to `endColor { r, g, b, a }`
- Use your existing RGBA color picker component
- Alpha slider shown explicitly (important — most death colors are fully transparent)

---

#### Section 6 — Physics

| Control | Maps to | Range | Notes |
|---------|---------|-------|-------|
| Gravity X | `gravity[0]` | –10 – 10 | |
| Gravity Y | `gravity[1]` | –10 – 10 | Default –0.3 |
| Gravity Z | `gravity[2]` | –10 – 10 | |
| Turbulence | `turbulence` | 0 – 2 | 0 = none; 0.1+ = noticeable shake |

Gravity Y can be a prominent single slider labeled "Gravity" if you want to simplify — most uses only change Y. Expose X/Z in an "Advanced" sub-section.

---

#### Section 7 — Texture & Flipbook

Two sub-modes, toggled by a radio or dropdown:

**Static texture** (default):
```
Texture  [Pick from library ▾]  [Clear]
```
Picks a single TextureLibrary entry. Maps to `textureIndex` (Salsa resolves the library ID to an atlas layer automatically). Showing the texture thumbnail next to the picker is ideal.

**Flipbook animation:**
```
[☑ Animate]
Frames  [+Add]  [Clear all]
  [thumbnail] Frame 1  [×]
  [thumbnail] Frame 2  [×]
  [thumbnail] Frame 3  [×]
Frame time  [  0.10  ] s   (≈ 10 fps)
```

- Enable/disable flipbook with a checkbox or toggle. When disabled, fall back to single texture / `textureIndex`.
- Each frame is a TextureLibrary ID. Display the texture thumbnail (small, ~24px).
- Reorder with drag handles.
- `animFrameTime` slider: 0.033–1.0 s (range 1–30 fps). Show equivalent FPS label.

```typescript
// Set flipbook frames:
shapeManager.setParticleEmitterConfig3D(id, {
  animTextures:  ['libId1', 'libId2', 'libId3'],
  animFrameTime: 0.083,   // ~12 fps
})

// Revert to static:
shapeManager.setParticleEmitterConfig3D(id, {
  animTextures: [],
  textureIndex: 0,
})
```

---

#### Section 8 — Bloom

Scene-level toggle (affects all emitters, not per-emitter):

```
[☑ Bloom glow]

Threshold  [━━━━━●━━] 0.50   (lower = more particles glow)
Intensity  [━━━●━━━━] 1.20   (higher = brighter halos)
```

- The bloom toggle calls `shapeManager.enableBloom3D()` / `shapeManager.disableBloom3D()`.
- Threshold slider: 0.0–1.0 (step 0.01). Calls `shapeManager.setBloomThreshold3D(t)`.
- Intensity slider: 0.1–3.0 (step 0.05). Calls `shapeManager.setBloomIntensity3D(v)`.
- Persist the enabled state + values in scene/project settings (not per-emitter config).
- Place this section **below** the emitter list, not inside individual emitter edit panels — bloom is a global pass.

```typescript
// Enable with custom settings:
shapeManager.enableBloom3D(0.5, 1.2)

// Live slider updates:
shapeManager.setBloomThreshold3D(sliderValue)
shapeManager.setBloomIntensity3D(sliderValue)

// Disable:
shapeManager.disableBloom3D()
```

---

#### Action Bar

At the bottom of the edit panel:

```
[Reset to Preset ▾]   [Duplicate]   [Delete]
```

- **Reset to Preset** — dropdown with the 4 preset names; resets all fields to that preset (requires user confirmation if they've edited)
- **Duplicate** — calls `addParticleEmitter3D` with the current config, offset position by `+0.5` in X
- **Delete** — calls `removeParticleEmitter3D(id)`

---

## Implementation Notes for Frogmarks

### On change, call `setParticleEmitterConfig3D`

Every field change in the edit panel should call:
```typescript
shapeManager.setParticleEmitterConfig3D(id, { fieldName: newValue })
```

This is a **live update** — the emitter restarts its pool with the new config immediately. For sliders that fire rapidly (e.g., dragging emitRate), debounce by ~50 ms to avoid churning the particle pool on every tick.

### Spread display

Convert between degrees (UI) and radians (API):
```typescript
const spreadDeg = Math.round(emitter.config.spread * (180 / Math.PI))
// on set:
shapeManager.setParticleEmitterConfig3D(id, { spread: deg * (Math.PI / 180) })
```

### Direction normalization

The `direction` vector should be kept unit-length. After the user edits any component:
```typescript
const [x, y, z] = rawDirection
const len = Math.sqrt(x*x + y*y + z*z) || 1
shapeManager.setParticleEmitterConfig3D(id, { direction: [x/len, y/len, z/len] })
```

A "Direction" preset dropdown (Up, Down, Forward, Back, etc.) is a nice shortcut:
```typescript
const DIRECTION_PRESETS = {
  'Up':       [0,  1,  0],
  'Down':     [0, -1,  0],
  'Forward':  [0,  0, -1],
  'Outward':  [0,  0,  1],
  'Scatter':  [0,  1,  0],  // use with spread = π
}
```

### Visibility toggle

```typescript
const node = shapeManager.getParticleEmitter3D(id)
if (node) node.visible = !node.visible
shapeManager.scheduleRender?.()  // trigger a repaint
```

### Name storage

`ParticleEmitter3D` inherits `name` from `Shape`. You can read/write it directly:
```typescript
const node = shapeManager.getParticleEmitter3D(id)
if (node) node.name = 'My Fire Effect'
```

### No undo/redo for now

Particle emitter config changes are not wired into `UndoManager3D`. Don't add undo buttons. If the user wants to experiment, they have the "Reset to Preset" button.

### Serialization

`ParticleEmitter3D.toJSON()` is wired into scene graph serialization. The load path (`setSceneGraphJSON`) now fully restores particle emitters including the tick callback — no special-casing needed in your document load flow. The `animTextures` IDs and `animFrameTime` are included in the serialized config automatically.

### Bloom persistence

Bloom is not per-emitter config — store the enabled state + threshold + intensity in your project/scene settings (the same place you'd store camera mode, grid visibility, etc.) and re-apply with `enableBloom3D(threshold, intensity)` when loading.

---

## Edge Cases

| Scenario | Expected behavior |
|----------|-------------------|
| `maxParticles = 0` | Don't allow — clamp to minimum 1 in the UI |
| Lifetime min > max | Clamp max ≥ min on input; show a warning color if equal (results in fixed lifetime) |
| Speed min > max | Same: clamp max ≥ min |
| `loop = false`, emitter spent | All particles die, nothing new spawns. Emitter stays in list. User can click "Restart" (call `setParticleEmitterConfig3D(id, { loop: false })` — re-applying config resets the pool) |
| Emitter moved while running | Particles already in flight keep their world-space positions. Only new spawns use the new position. This is correct behavior. |
| Tab hidden, then shown | The pre-render tick clamps `dt` to 100 ms so particles won't teleport on re-focus. |

---

## Suggested Rollout Order

1. Add particle emitters list section to 3D panel (empty state + add button + preset picker)
2. Wire create / delete / visibility toggle
3. Build edit panel: position + emission + lifetime/speed (Phase 1 controls)
4. Add color pickers for birth/death (Phase 2)
5. Add physics + advanced controls (Phase 3)
6. Add Reset to Preset / Duplicate to action bar (Phase 4)
7. Add static texture picker (Section 7 — single library texture) (Phase 5)
8. Add flipbook animation controls (Section 7 — animTextures + animFrameTime) (Phase 6)
9. Add Bloom toggle + threshold/intensity sliders (Section 8) (Phase 7)
