# Viewport Transform Shortcuts — Spec

**Status:** Completed June 2026  
**Files:** `src/services/managers/transform-controller-3d.ts`, `src/services/managers/scene3d-manager.ts`, `src/services/shape-manager.ts`

---

## Goal

Allow Frogmarks to offer Blender-style keyboard-driven transforms (G/R/S + axis constraint + numeric value) without Salsa owning any keyboard event listeners. Salsa exposes a pure state-machine API; Frogmarks calls it from its existing `@HostListener('document:keydown')` handler.

---

## Design Decisions

**Salsa owns state, Frogmarks owns keys.**  
Salsa must not attach a second `window.addEventListener('keydown')` — Frogmarks already owns that space and a second listener would create ordering races, `preventDefault` conflicts, and debugging headaches. The pre-existing `handleKeyDown` (which just switched gizmo mode) was removed.

**`beginTransform3D` reads selection internally.**  
The method derives the target meshes from Salsa's internal selected-node state at call time, not from a `meshId` argument. Passing a meshId would introduce a TOCTOU race between Frogmarks's keydown handler and the API call.

**`appendNumericInput` takes one character per call.**  
All numeric state lives inside Salsa. Frogmarks calls `appendNumericInput(e.key)` once per keypress — it never accumulates a string itself.

**Axis is required for numeric input.**  
Unconstrained numeric input (`R 45 Enter` without a prior axis) is a no-op. The user must first constrain the axis (`R Z 45 Enter`). This is an honest first-pass limitation.

**Snapshot on `beginTransform3D`.**  
A pre-transform snapshot is captured immediately when the shortcut begins. This enables `cancelTransform3D` to restore the original transforms in two cases:

1. **Shortcut active** — user pressed Escape before committing
2. **Gizmo drag in-flight** — user pressed Escape mid-drag (without a snapshot, the drag's partial state cannot be cleanly undone)

---

## State Machine

```
idle
 │
 ├─ beginTransform3D('grab'|'rotate'|'scale')
 │   → captures snapshot of selected meshes
 │
 ▼
shortcut_active { mode, axis: null, numericChars: '' }
 │
 ├─ constrainAxis3D('x'|'y'|'z')
 │   → sets axis, clears numericChars
 │
 ├─ appendNumericInput(char)   [requires axis set]
 │   → appends to numericChars, calls _applyShortcutPreview()
 │
 ├─ commitTransform3D()
 │   → fires onTransformComplete + onTransformDone → idle
 │
 └─ cancelTransform3D()
     → restores snapshot → idle

(cancelTransform3D also handles mid-drag gizmo cancel even when shortcut is idle)
```

---

## API

```ts
// Getters (read shortcut state for UI overlays)
sm.isShortcutActive3D          // boolean
sm.shortcutMode3D              // 'grab' | 'rotate' | 'scale' | null
sm.shortcutAxis3D              // 'x' | 'y' | 'z' | null
sm.shortcutNumericDisplay3D    // string — e.g. "-4.5" or "" when no input yet

// State machine methods
sm.beginTransform3D('grab')    // G key — move
sm.beginTransform3D('rotate')  // R key — rotate
sm.beginTransform3D('scale')   // S key — scale
sm.constrainAxis3D('x')        // X key
sm.constrainAxis3D('y')        // Y key
sm.constrainAxis3D('z')        // Z key
sm.appendNumericInput(char)    // digit, '.', or '-'
sm.commitTransform3D()         // Enter key
sm.cancelTransform3D()         // Escape key (also cancels mid-drag gizmo)
```

---

## Frogmarks Integration Pattern

```typescript
@HostListener('document:keydown', ['$event'])
onKeyDown(e: KeyboardEvent): void {
  // ... existing Frogmarks tool dispatch ...

  if (this.is3DViewActive()) {
    const key = e.key.toLowerCase();

    // Begin
    if (key === 'g') { sm.beginTransform3D('grab');   e.preventDefault(); return; }
    if (key === 'r') { sm.beginTransform3D('rotate');  e.preventDefault(); return; }
    if (key === 's') { sm.beginTransform3D('scale');   e.preventDefault(); return; }

    // While shortcut active
    if (sm.isShortcutActive3D) {
      if (key === 'x') { sm.constrainAxis3D('x'); e.preventDefault(); return; }
      if (key === 'y') { sm.constrainAxis3D('y'); e.preventDefault(); return; }
      if (key === 'z') { sm.constrainAxis3D('z'); e.preventDefault(); return; }
      if (key === 'enter') { sm.commitTransform3D(); e.preventDefault(); return; }
      if (/^[\d.\-]$/.test(e.key)) { sm.appendNumericInput(e.key); e.preventDefault(); return; }
    }

    // Escape: cancel shortcut OR cancel in-flight gizmo drag
    if (key === 'escape') { sm.cancelTransform3D(); e.preventDefault(); return; }
  }
}
```

---

## Numeric Preview Semantics

| Mode | Input | Effect |
|------|-------|--------|
| grab, axis X | `5` | Moves +5 world units along X |
| grab, axis X | `-2` | Moves -2 world units along X |
| rotate, axis Z | `45` | Rotates +45° around Z (input in degrees) |
| rotate, axis Z | `-90` | Rotates -90° around Z |
| scale, axis Y | `2` | Scales Y by factor 2× |
| scale, axis Y | `0.5` | Scales Y by factor 0.5× |

The preview updates on every `appendNumericInput` call. The mesh always restores to its snapshot first, then the full numeric value is applied — no incremental accumulation.

---

## Undo / Redo

`commitTransform3D()` fires `onTransformComplete(before, after)` and `onTransformDone(meshIds)` — the same callbacks used by gizmo drag. Frogmarks pushes an undo record from these callbacks identically to a completed gizmo drag.

Cancelled shortcuts (`cancelTransform3D`) restore from snapshot without firing any callbacks — nothing enters the undo stack.

---

## Known Limitations

- **No unconstrained numeric input** — `G 5 Enter` (move 5 units in some default direction) is not supported. Axis must be set first.
- **World-space only** — numeric moves/rotates/scales always use world axes. Local-axis numeric shortcuts are not yet implemented.
- **No backspace** — once a character is appended it cannot be removed without restarting the shortcut.
