# Frogmarks Phase 4 — New ShapeManager API Reference

All methods are on the `ShapeManager` singleton (`ShapeManager.getInstance()`).  
Types referenced below are exported from `salsa`.

---

## 1. Arrowheads on Lines

Lines now support arrowheads at either endpoint. Arrowheads are part of the geometry (GPU-rendered), serialize/deserialize, and work with all existing line tools.

### Types

```ts
type ArrowheadStyle = 'none' | 'triangle' | 'open';
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `createArrow` | `(x1, y1, x2, y2, strokeColor: RGBA, strokeWidth: number, arrowStart?: ArrowheadStyle, arrowEnd?: ArrowheadStyle, arrowSize?: number) → Line` | Create a line with arrowheads. Defaults: `arrowStart='none'`, `arrowEnd='triangle'`, `arrowSize=6`. Returns the `Line` instance. |
| `setArrowheads` | `(shapeId: string, arrowStart?: ArrowheadStyle, arrowEnd?: ArrowheadStyle, arrowSize?: number) → void` | Modify arrowheads on an existing Line by shape ID. Only provided values are changed. |
| `setDefaultArrowheads` | `(arrowStart: ArrowheadStyle, arrowEnd: ArrowheadStyle) → void` | Set default arrowhead styles for all **new** lines drawn with the line tool. |
| `ArrowheadStyles` (static) | `ArrowheadStyle[]` | `['none', 'triangle', 'open']` — useful for populating dropdowns. |

### Arrowhead Styles

- **`none`** — No arrowhead (plain line endpoint).
- **`triangle`** — Filled triangle pointing along the line direction.
- **`open`** — Open chevron (two thin lines forming a V).

### Serialization

Arrow properties (`arrowStart`, `arrowEnd`, `arrowSize`) are included in `toJSON()` and restored on `loadSceneGraphJSON()` automatically.

---

## 2. Raster Text Tool

Lets users type text and stamp it as pixels onto the active raster layer. Once committed, text becomes non-editable raster data (like Photoshop's "flatten text").

### Types

```ts
interface RasterTextState {
  isActive: boolean;
  text: string;
  destX: number;        // texel-space X
  destY: number;        // texel-space Y
  font: string;         // e.g. 'Arial'
  fontSize: number;     // px
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  color: [number, number, number, number]; // RGBA 0-1
  maxWidth: number;     // texels, 0 = no wrap
  lineHeight: number;   // multiplier, default 1.2
  caretIndex: number;
}
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `enableRasterText` | `() → void` | Activate the raster text tool. Disables raster brush/selection. Switches to raster render mode. |
| `disableRasterText` | `() → void` | Deactivate the tool. Commits any in-progress text first. |
| `getRasterTextState` | `() → RasterTextState \| null` | Get the current text entry state (for UI binding). |
| `updateRasterTextProperties` | `(props) → void` | Update font, fontSize, bold, italic, align, color, maxWidth, lineHeight during preview. Accepts a partial object. |
| `commitRasterText` | `() → void` | Stamp the current text onto the active raster layer. Pushes an undo snapshot. |
| `cancelRasterText` | `() → void` | Cancel text entry without stamping. |
| `onRasterTextStateChanged` | `(cb: (state: RasterTextState) => void) → { unsubscribe() }` | Subscribe to state changes. Returns an unsubscribe handle. |

### Keyboard Shortcuts (built-in)

| Key | Action |
|-----|--------|
| Click on canvas | Place text at click position |
| Type | Insert characters at caret |
| `Backspace` / `Delete` | Delete at caret |
| `←` / `→` | Move caret |
| `Home` / `End` | Move caret to line start/end |
| `Shift+Enter` | Insert newline |
| `Enter` | Commit (stamp text onto layer) |
| `Escape` | Cancel text entry |

---

## 3. Connection Ports & Snap-to-Port Connectors

Every shape exposes named **connection points** (world-space anchors at edge midpoints). Lines can **bind** their endpoints to these ports so they auto-update when the connected shape moves/resizes.

### Types

```ts
interface ConnectionPoint {
  id: string;   // 'top' | 'right' | 'bottom' | 'left' | 'center' (shapes)
                 // 'start' | 'end' | 'mid' (lines)
  x: number;    // world-space
  y: number;
}

interface SnapResult {
  shapeId: string;
  portId: string;
  x: number;
  y: number;
  distance: number;
}

interface ConnectorBinding {
  shapeId: string;
  portId: string;
}
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `findSnapTarget` | `(worldX, worldY, excludeShapeId?) → SnapResult \| null` | Find the nearest connection port within the snap threshold. Lines are excluded from results. |
| `getAllConnectionPoints` | `(nearWorldX?, nearWorldY?, radius?) → { shapeId, point }[]` | Get all port positions (for rendering snap indicators/dots). Optionally filter by proximity. |
| `getShapeConnectionPoints` | `(shapeId: string) → ConnectionPoint[]` | Get ports for one specific shape. |
| `setSnapThreshold` | `(threshold: number) → void` | Set the world-space distance for snapping (default `0.03`). |
| `bindLineStart` | `(lineId, targetShapeId, portId) → void` | Bind a line's start endpoint to a shape's port. |
| `bindLineEnd` | `(lineId, targetShapeId, portId) → void` | Bind a line's end endpoint to a shape's port. |
| `unbindLineStart` | `(lineId) → void` | Remove the start binding. |
| `unbindLineEnd` | `(lineId) → void` | Remove the end binding. |
| `updateConnectors` | `() → void` | Force-sync all bound connectors. Called automatically on scene graph changes, but can be called manually after programmatic moves. |
| `getConnectorService` | `() → ConnectorService \| undefined` | Get the raw service instance for advanced use. |

### Automatic Behavior

- **Line drawing tool**: Automatically snaps start/end points to nearby ports during drawing. Bindings are created on snap.
- **Auto-update**: When a shape moves/resizes (scene graph change event), all bound lines update their endpoints to track the port's new position.
- **Serialization**: `startBinding` and `endBinding` are included in Line's JSON and restored on load.

### Port IDs by Shape Type

| Shape | Port IDs |
|-------|----------|
| Rectangle, Circle, Diamond, Triangle, StickyNote, etc. | `top`, `right`, `bottom`, `left`, `center` |
| Line | `start`, `end`, `mid` |

---

## 4. SDF Text Editing Improvements

The SDF text tool now supports full cursor-based editing (previously only appended to end).

### New Keyboard Shortcuts (built-in, no Frogmarks changes needed)

| Key | Action |
|-----|--------|
| `←` / `→` | Move caret left/right |
| `Shift+←` / `Shift+→` | Extend selection |
| `Home` / `End` | Move to line start/end |
| `Shift+Home` / `Shift+End` | Select to line start/end |
| `Ctrl+A` | Select all |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste |
| `Delete` | Delete forward |
| `Backspace` | Delete backward |
| `Shift+Enter` | Insert newline |
| Click on active text | Position caret at click point |

These work automatically when the SDF text tool is enabled — no Frogmarks UI changes required.

---

## 5. SDF Text Word Wrapping

SDF text nodes now support a `maxWidth` for automatic word wrapping with mid-word fallback.

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `setSDFTextMaxWidth` | `(worldUnits: number) → void` | Set max width for the **active** SDF text being drawn. `0` or negative = no wrap. |
| `updateSDFText` | `(nodeId, props) → void` | *(changed)* Now accepts `maxWidth: number` in the props object. |

### `updateSDFText` full props (updated)

```ts
sm.updateSDFText(nodeId, {
  text?: string,
  font?: string,
  fontSize?: number,
  lineHeight?: number,
  maxWidth?: number,        // ← NEW — world units, 0 = no wrap
  fill?: string | RGBA,
  outline?: string | RGBA,
  outlineWidth?: number,
  threshold?: number,
  smoothing?: number,
});
```

### Serialization

`maxWidth` is included in `toJSON()` (as world units) and restored on `loadSceneGraphJSON()`.

---

## 6. Automatic Rendering Features (no Frogmarks code needed)

These features are now handled entirely by the Salsa renderer — they activate automatically and require **zero** Frogmarks UI work:

| Feature | When it renders | What it looks like |
|---------|----------------|-------------------|
| **SDF text selection highlight** | When user Shift+Arrow or Ctrl+A selects text in an SDFText node | Translucent blue rectangles behind selected character spans |
| **Raster text preview overlay** | While the raster text tool is active and user is typing | Live text preview composited on top of the raster canvas at the click position |
| **Connection port dots** | When the line drawing tool is enabled | Small translucent blue circles at all shape edge midpoints (top/right/bottom/left/center) |
| **Connector auto-update** | When shapes are dragged, rotated, or scaled | Bound line endpoints track their connected port's new position in real-time |

---

## Quick Integration Checklist for Frogmarks

### Arrowheads
- [ ] Add arrowhead controls to the line/arrow section of the toolbar (dropdown with `ShapeManager.ArrowheadStyles`)
- [ ] Wire dropdown changes to `sm.setArrowheads(selectedLineId, arrowStart, arrowEnd)`
- [ ] Add "Arrow" shape type to shape picker that calls `sm.createArrow(...)` or `sm.setDefaultArrowheads('none', 'triangle')` before enabling line tool

### Raster Text
- [ ] Add "Text" button to the raster toolbar section
- [ ] Wire to `sm.enableRasterText()` / `sm.disableRasterText()`
- [ ] Add font/size/color/bold/italic controls wired to `sm.updateRasterTextProperties({...})`
- [ ] Subscribe with `sm.onRasterTextStateChanged(...)` to update UI state

### Connection Ports (optional — for flowchart mode)
- [ ] Render snap indicator dots using `sm.getAllConnectionPoints(mouseWorldX, mouseWorldY, 0.1)`
- [ ] If building a "Connect shapes" mode, use `sm.bindLineStart/End` after creating lines
- [ ] Connection ports work automatically with the line drawing tool — no UI needed for basic snap behavior
- [ ] Port dots now render automatically when line tool is active — **no Frogmarks overlay code needed**

### SDF Text Word Wrapping
- [ ] Add a "Max Width" slider or input to the SDF text section of the properties panel
- [ ] Wire to `sm.updateSDFText(nodeId, { maxWidth: value })` for existing nodes
- [ ] Wire to `sm.setSDFTextMaxWidth(value)` for the active text tool
- [ ] Selection highlights and cursor editing work automatically within wrapped text
