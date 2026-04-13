# Frogmarks UI Spec — Animation System

> **For**: Frogmarks front-end team  
> **Salsa version**: Current (`npm run build` passing)  
> **Date**: April 2026

Everything below is already wired in Salsa's engine. Frogmarks just needs UI to expose it.

---

## Quick Summary

Animation in Salsa is **frame-by-frame cel animation** — the same workflow as Clip Studio Paint, TVPaint, and Flipnote. Every illustration is secretly a 1-frame animation. Toggling animation mode reveals the timeline. No file format conversion needed.

### New UI elements needed:

| Element | Priority |
|---------|----------|
| [Timeline Panel](#1-timeline-panel) | 🔴 Critical |
| [Playback Controls](#2-playback-controls) | 🔴 Critical |
| [Frame Navigation](#3-frame-navigation) | 🔴 Critical |
| [Onion Skin Controls](#4-onion-skin-controls) | 🔴 Critical |
| [Layer Animation Toggle](#5-layer-animation-toggle) | 🟡 High |
| [Cel Management](#6-cel-management) | 🟡 High |
| [Timeline Settings](#7-timeline-settings) | 🟡 Medium |
| [Export Options](#8-export-options) | 🟡 Medium |

---

## Core Concepts (for the UI team)

| Term | What it means | UI implication |
|------|--------------|----------------|
| **Frame** | A point in time on the timeline (1-indexed) | Each column in the timeline grid |
| **Cel** | A single drawing on one frame (or held across multiple frames) | A filled block in the timeline |
| **Hold frame** | A cel displayed for >1 frame (drawn once, shown for N frames) | A cel block spanning multiple columns |
| **Blank frame** | A frame with no drawing (transparent) | An empty cell in the timeline |
| **Key** | A cel marked as a "key" drawing | Diamond marker ◆ in timeline |
| **Inbetween** | A cel between two keys | Circle marker ○ in timeline |
| **Static layer** | A layer with one texture visible on ALL frames (e.g. background) | No frame blocks — just a solid bar |
| **Animated layer** | A layer with per-frame cels | Individual frame blocks in timeline |

---

## 1. Timeline Panel

The timeline is the main animation workspace. It appears at the bottom of the screen when animation mode is enabled.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ Layer Name    │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │ 8 │ ... │
├───────────────┼───┼───┼───┼───┼───┼───┼───┼───┼───────┤
│ 🔒 Background │███████████████████████████████████████████│ ← static layer (solid bar)
│ ✏️ Character  │[◆]│   │[○]│   │[◆]│   │[○]│   │       │ ← animated layer (cels)
│ ✏️ Effects    │   │[◆]│[◆]│[◆]│   │   │   │   │       │
├───────────────┴───┴───┴───┴───┴───┴───┴───┴───┴───────┤
│  ◄◄  ◄  ▶  ►  ►►  │  ⟲ Loop  │  FPS: 12  │  1/24    │
└──────────────────────────────────────────────────────────┘
          ▲                                        ▲
     playback controls                     frame counter
```

### API

```ts
// Enable animation mode (reveals the timeline)
shapeManager.setAnimationEnabled(true);

// Check if animation mode is on
shapeManager.isAnimationEnabled();
```

### UI Controls

| Control | Type | Tooltip |
|---------|------|---------|
| **Animation mode toggle** | Toggle button (in toolbar or menu) | `"Enable animation timeline. Your illustration becomes the first frame — add more frames to start animating."` |
| **Frame scrubber** | Clickable/draggable timeline header | `"Click a frame to jump to it. Drag to scrub through the animation."` |
| **Current frame indicator** | Vertical line / highlight in timeline | `"The frame you're currently drawing on."` |
| **Frame counter** | Text display (e.g., "5/24") | `"Current frame / total frames."` |

### Behavior
- Clicking a frame cell calls `shapeManager.setCurrentFrame(n)`.
- The canvas immediately updates to show the correct cel for each layer.
- Static layers don't change appearance when scrubbing.
- Animated layers swap their visible drawing per frame.
- Blank frames show nothing (transparent) for that layer.

---

## 2. Playback Controls

A transport bar for playing/pausing the animation.

### UI Controls

| Control | Icon | Action | Tooltip |
|---------|------|--------|---------|
| **First frame** | `⏮` | `shapeManager.setCurrentFrame(1)` | `"Jump to the first frame."` |
| **Previous frame** | `◀` | `shapeManager.prevFrame()` | `"Step back one frame. Keyboard: , (comma)"` |
| **Play / Pause** | `▶` / `⏸` | `shapeManager.togglePlayPause()` | `"Play or pause the animation. Keyboard: Space"` |
| **Next frame** | `▶` | `shapeManager.nextFrame()` | `"Step forward one frame. Keyboard: . (period)"` |
| **Last frame** | `⏭` | `shapeManager.setCurrentFrame(shapeManager.getFrameCount())` | `"Jump to the last frame."` |
| **Stop** | `⏹` | `shapeManager.stopPlayback()` | `"Stop playback and return to frame 1."` |

### Keyboard Shortcuts (suggested)

| Key | Action |
|-----|--------|
| `Space` | Toggle play/pause |
| `,` (comma) | Previous frame |
| `.` (period) | Next frame |
| `Home` | First frame |
| `End` | Last frame |

### Playback State

Subscribe to playback events to update the UI:

```ts
const unsub = shapeManager.onAnimationEvent((event) => {
  if (event.type === 'frame-changed') {
    updateFrameCounter(event.frame);
    highlightTimelineFrame(event.frame);
  }
  if (event.type === 'playback-state-changed') {
    updatePlayButton(); // toggle ▶/⏸ icon
  }
});
```

---

## 3. Frame Navigation

### API

```ts
shapeManager.setCurrentFrame(5);      // Jump to frame 5
shapeManager.getCurrentFrame();        // → 5
shapeManager.nextFrame();              // → 6
shapeManager.prevFrame();              // → 5
```

### Timeline UI interactions

| Interaction | What it does |
|-------------|-------------|
| Click on frame number in header | Jump to that frame |
| Click-drag across frame numbers | Scrub through frames (live preview) |
| Scroll wheel on timeline | Scroll the visible frame range |
| Ctrl + scroll wheel | Zoom timeline (wider/narrower frame cells) |

---

## 4. Onion Skin Controls

Onion skinning shows ghost images of adjacent frames so the animator can see what comes before and after the current drawing.

### UI Controls

| Control | Type | Range | Default | Tooltip |
|---------|------|-------|---------|---------|
| **Enable** | Toggle | on/off | off | `"Show ghost images of adjacent frames. Previous frames appear in red, next frames in blue. Essential for smooth animation."` |
| **Frames Before** | Slider (int) | 0–6 | 2 | `"How many previous frames to show as ghosts. More frames = more context but more visual clutter."` |
| **Frames After** | Slider (int) | 0–6 | 1 | `"How many upcoming frames to show as ghosts."` |
| **Opacity** | Slider | 0–1 | 0.3 | `"How visible the ghost frames are. Lower = more subtle, higher = more visible."` |
| **Previous Tint** | Color picker | RGB | Red (1.0, 0.2, 0.2) | `"Color tint for previous frames. Red is the industry standard — it's easy to distinguish from your current drawing."` |
| **Next Tint** | Color picker | RGB | Blue (0.2, 0.5, 1.0) | `"Color tint for upcoming frames. Blue is the industry standard."` |

### API

```ts
shapeManager.setOnionSkin({
  enabled: true,
  framesBefore: 3,
  framesAfter: 1,
  opacity: 0.25,
  tintBefore: [1.0, 0.2, 0.2],   // red
  tintAfter: [0.2, 0.5, 1.0],    // blue
});

// Read current config
const config = shapeManager.getOnionSkin();
```

### Data Shape

```ts
interface OnionSkinConfig {
  enabled: boolean;
  framesBefore: number;       // 0–6
  framesAfter: number;        // 0–6
  opacity: number;            // 0–1
  tintBefore: [number, number, number];  // RGB 0–1
  tintAfter: [number, number, number];   // RGB 0–1
}
```

### UX Notes
- The onion skin toggle should be **prominent** — a toolbar button, not buried in settings. Animators toggle this constantly.
- Consider showing a small preview icon: 🧅 or a stacked-frames icon.
- The tint colors don't need a full color picker — a simple preset row (red, green, orange for "before"; blue, cyan, purple for "after") is enough.
- Ghost frames **only render for animated layers**, not static layers.
- During playback, onion skinning should auto-disable (for performance) and re-enable when paused.

---

## 5. Layer Animation Toggle

Each layer can be either **static** (visible on all frames) or **animated** (per-frame cels).

### UI Controls

| Control | Where | Tooltip |
|---------|-------|---------|
| **Animation toggle** | Per-layer in the layers panel — small icon or context menu option | `"Static: this layer shows the same drawing on every frame (backgrounds, overlays). Animated: this layer has separate drawings per frame (characters, effects)."` |

### API

```ts
// Convert a layer to animated mode
shapeManager.setLayerAnimated(layerId, true);

// Convert back to static
shapeManager.setLayerAnimated(layerId, false);

// Check current mode
shapeManager.isLayerAnimated(layerId);  // → true/false
```

### Visual indicator in timeline

| Layer type | Timeline appearance |
|---|---|
| **Static** | Solid colored bar spanning all frames. No individual frame cells. |
| **Animated** | Individual frame cells. Filled cells = cels with drawings. Empty cells = blank frames. |

### UX Notes
- When a layer is first set to animated, its current content becomes **cel 1** (held for the entire timeline). This is non-destructive — nothing is lost.
- Converting back to static keeps the first cel as the layer's content. Other cels are discarded (confirm with user first!).
- New layers should default to **static** unless the user is in animation mode and explicitly adds an animated layer.
- The "Background" layer should almost always be static. Consider defaulting it to locked + static.

---

## 6. Cel Management

Cels are individual drawings on animated layers. The animator adds, removes, and extends cels as they work.

### UI Controls

| Action | Trigger | API | Tooltip |
|--------|---------|-----|---------|
| **New blank cel** | Click empty frame cell, or `+` button | `shapeManager.addCelAtCurrentFrame(layerId)` | `"Add a new blank drawing on this frame. Start drawing to fill it in."` |
| **New cel at frame** | Right-click frame → "New cel" | `shapeManager.addCelAtFrame(layerId, frame)` | `"Create a new blank cel at this specific frame."` |
| **Delete cel** | Right-click cel → "Delete", or `Del` key | `shapeManager.deleteCel(layerId, celId)` | `"Remove this drawing. The frame becomes blank."` |
| **Insert frame** | Right-click → "Insert frame" | `shapeManager.insertFrame(at)` | `"Insert a blank frame here. All subsequent frames shift right."` |
| **Delete frame** | Right-click → "Delete frame" | `shapeManager.deleteFrame(at)` | `"Remove this frame from the timeline. All subsequent frames shift left."` |
| **Extend hold** | Drag cel's right edge in timeline | (use `setCelDuration` via timeline) | `"Hold this drawing for more frames. Drag the edge to extend or shrink."` |

### API

```ts
// Add cel at current frame — returns cel id
const celId = shapeManager.addCelAtCurrentFrame(layerId);

// Add cel at specific frame
const celId = shapeManager.addCelAtFrame(layerId, 5);

// Delete a cel
shapeManager.deleteCel(layerId, celId);

// Insert/delete frames (shifts all cels)
shapeManager.insertFrame(5);   // insert at frame 5
shapeManager.deleteFrame(5);   // delete frame 5
```

### Timeline Frame Cell States

Show these visually in the timeline grid:

| State | Appearance | Meaning |
|---|---|---|
| **Key cel** | Filled cell with ◆ diamond | A key drawing |
| **Inbetween cel** | Filled cell with ○ circle | An intermediate drawing |
| **Hold frame** | Filled cell with → arrow or connected bar | This frame shows the previous cel's drawing |
| **Blank frame** | Empty cell | No drawing — transparent |
| **Current frame** | Blue highlight / border | The frame you're viewing and drawing on |

### UX Notes
- Double-clicking a blank frame cell should auto-create a new cel there and select it.
- Dragging a cel in the timeline should move it to a different frame position.
- Copying cels (Ctrl+C/V) between frames is a common workflow — plan for it.
- "Duplicate cel" (copy drawing to another frame) is extremely common for animation holds where you want to make a slight modification.

---

## 7. Timeline Settings

Global settings for the animation timeline.

### UI Controls

| Control | Type | Range | Default | Tooltip |
|---------|------|-------|---------|---------|
| **FPS** | Number input or dropdown | 1–120 | 12 | `"Frames per second. 8 = simple/slow, 12 = standard anime (drawing on 2s), 24 = full animation, 30/60 = smooth motion graphics."` |
| **Frame count** | Number input | 1–9999 | 24 | `"Total number of frames in the animation. You can also add frames at the end with the + button."` |
| **Loop mode** | Segmented toggle | None / Loop / Ping-pong | Loop | (see below) |
| **Play range start** | Number input or draggable marker | 1–frameCount | 1 | `"Playback starts from this frame. Useful for previewing a specific section."` |
| **Play range end** | Number input or draggable marker | start–frameCount | frameCount | `"Playback ends at this frame."` |
| **Add frames** | Button (+) | — | — | `"Add more frames to the end of the timeline."` |

### Loop Mode Tooltips

| Mode | Tooltip |
|------|---------|
| **None** | `"Play once and stop at the last frame."` |
| **Loop** | `"Repeat the animation continuously. Standard for previewing walk cycles and loops."` |
| **Ping-pong** | `"Play forward, then backward, then forward again. Good for previewing bouncing or breathing animations."` |

### FPS Preset Buttons (optional nice-to-have)

| Preset | FPS | Label | Tooltip |
|--------|-----|-------|---------|
| Simple | 8 | `8` | `"8 fps — simple flipbook style. Good for rough animation and storyboarding."` |
| Anime (2s) | 12 | `12` | `"12 fps — standard anime timing. Each drawing is held for 2 film frames (called 'on 2s')."` |
| Full | 24 | `24` | `"24 fps — full film animation. Every frame is a new drawing. Smoother but much more work."` |
| Smooth | 30 | `30` | `"30 fps — smooth digital animation and motion graphics."` |

### API

```ts
shapeManager.setFps(12);
shapeManager.setFrameCount(48);
shapeManager.setLoopMode('loop');       // 'none' | 'loop' | 'ping-pong'
shapeManager.addFrames(24);             // add 24 frames at the end
```

---

## 8. Export Options

### Export Formats

| Format | What it produces | API approach | Tooltip |
|--------|-----------------|-------------|---------|
| **GIF** | Animated GIF | Export frame data → encode with a GIF library (e.g. gif.js) | `"Export as an animated GIF. Good for sharing on social media, Discord, and messaging apps."` |
| **MP4** | Video file | Export frame data → encode with WebCodecs or WASM ffmpeg | `"Export as a video file. Best quality and smallest file size."` |
| **Sprite sheet** | Single PNG with all frames in a grid | Direct API call | `"Export all frames in a single image grid. Used for game development, web animations, and spritesheets."` |
| **PNG sequence** | One PNG file per frame | Export each frame individually | `"Export every frame as a separate PNG file. Standard for professional animation pipelines."` |
| **GIF sticker** | Transparent animated GIF | Same as GIF but with alpha | `"Export as a transparent animated sticker. Perfect for messaging apps and stream overlays."` |

### Sprite Sheet API

```ts
// Frogmarks would access the exporter through the layer manager
// or wrap it in a ShapeManager convenience method.

// The exporter is available as:
import { AnimationExporter } from '@zaings/salsa';

const exporter = new AnimationExporter(device);

// Sprite sheet
const { blob, columns, rows, frameWidth, frameHeight } =
  await exporter.toSpriteSheet(frameTextures, {
    columns: 8,
    padding: 2,
  });

// Individual frames
const frameData = await exporter.toFrameDataArray(frameTextures);
// → [{ frame: 1, width, height, pixels: Uint8Array }, ...]
```

### Export Dialog UI

| Control | Type | Tooltip |
|---------|------|---------|
| **Format** | Dropdown (GIF / MP4 / Sprite Sheet / PNG Sequence) | `"Choose the output format for your animation."` |
| **Frame range** | Start / End inputs | `"Export only a section of the animation. Leave as default to export all frames."` |
| **Scale** | Dropdown (1x, 2x, 0.5x) | `"Scale the output. 2x doubles the resolution, 0.5x halves it."` |
| **Sprite columns** | Number (sprite sheet only) | `"How many frames per row in the sprite sheet grid."` |
| **Background** | Toggle (transparent / solid color) | `"Include a background color or keep transparency (GIF/PNG only)."` |
| **Quality** | Slider (MP4 only) | `"Video quality. Higher = larger file."` |

---

## 9. Suggested Keyboard Shortcuts

| Key | Action | Tooltip |
|-----|--------|---------|
| `Space` | Toggle play/pause | `"Play or pause the animation."` |
| `,` (comma) | Previous frame | `"Step back one frame."` |
| `.` (period) | Next frame | `"Step forward one frame."` |
| `Home` | First frame | `"Jump to the first frame."` |
| `End` | Last frame | `"Jump to the last frame."` |
| `F5` | New blank cel on current frame | `"Add a new blank drawing on this frame."` |
| `F6` | New blank cel on next frame + advance | `"Create a new frame and advance to it. The fastest way to animate."` |
| `F7` | Insert blank frame | `"Insert a blank frame at the current position."` |
| `O` | Toggle onion skin | `"Show or hide ghost frames."` |
| `Alt + ,` | Decrease FPS by 1 | `"Slow down playback."` |
| `Alt + .` | Increase FPS by 1 | `"Speed up playback."` |

---

## 10. Animation Event System

Frogmarks should subscribe to animation events to keep the UI in sync with Salsa's state.

### API

```ts
const unsubscribe = shapeManager.onAnimationEvent((event) => {
  switch (event.type) {
    case 'frame-changed':
      // Update frame counter, scrubber position, canvas
      updateUI(event.frame);
      break;
    case 'playback-state-changed':
      // Toggle play/pause button icon
      updatePlayButton();
      break;
    case 'timeline-changed':
      // Frame count changed, play range changed, etc.
      rebuildTimeline();
      break;
    case 'cel-added':
      // New cel created — update timeline grid
      addCelToTimeline(event.layerId, event.celId);
      break;
    case 'cel-removed':
      // Cel deleted — update timeline grid
      removeCelFromTimeline(event.layerId, event.celId);
      break;
    case 'layer-type-changed':
      // Layer switched between static/animated
      updateLayerRow(event.layerId);
      break;
    case 'onion-skin-changed':
      // Onion skin config updated — re-render
      updateOnionSkinUI();
      break;
  }
});

// Clean up when component unmounts
unsubscribe();
```

### Event Types

| Event | When it fires | Payload |
|-------|--------------|---------|
| `frame-changed` | Current frame changes (navigation, playback, scrub) | `{ frame }` |
| `playback-state-changed` | Play/pause/stop | — |
| `timeline-changed` | Frame count, FPS, play range, or cel duration changes | — |
| `cel-added` | New cel created | `{ layerId, celId, frame }` |
| `cel-removed` | Cel deleted | `{ layerId, celId }` |
| `layer-type-changed` | Layer toggled between static/animated | `{ layerId }` |
| `onion-skin-changed` | Onion skin config updated | — |

---

## 11. Full Tooltip Reference

### Animation Mode
| Element | Tooltip |
|---------|---------|
| Animation toggle | `"Enable animation timeline. Your illustration becomes the first frame — add more frames to start animating."` |
| Frame counter | `"Current frame / total frames."` |

### Playback
| Element | Tooltip |
|---------|---------|
| First frame | `"Jump to the first frame."` |
| Previous frame | `"Step back one frame. Keyboard: , (comma)"` |
| Play/Pause | `"Play or pause the animation. Keyboard: Space"` |
| Next frame | `"Step forward one frame. Keyboard: . (period)"` |
| Last frame | `"Jump to the last frame."` |
| Stop | `"Stop playback and return to frame 1."` |

### Timeline
| Element | Tooltip |
|---------|---------|
| Frame cell (empty) | `"Blank frame — no drawing. Click to jump here, double-click to create a new cel."` |
| Frame cell (filled) | `"This frame has a drawing. Click to select it."` |
| Frame cell (hold) | `"This frame holds the previous drawing. The original cel is displayed again."` |
| Key marker ◆ | `"Key drawing — an important pose in the animation."` |
| Inbetween marker ○ | `"Inbetween drawing — a transitional frame between two keys."` |
| Static layer bar | `"This layer shows the same image on every frame. Right-click to convert to animated."` |

### Onion Skin
| Element | Tooltip |
|---------|---------|
| Enable toggle | `"Show ghost images of adjacent frames. Previous frames appear in red, next frames in blue. Essential for smooth animation."` |
| Frames before | `"How many previous frames to show as ghosts. More frames = more context but more visual clutter."` |
| Frames after | `"How many upcoming frames to show as ghosts."` |
| Opacity | `"How visible the ghost frames are. Lower = more subtle, higher = more visible."` |
| Previous tint | `"Color tint for previous frames. Red is the industry standard."` |
| Next tint | `"Color tint for upcoming frames. Blue is the industry standard."` |

### FPS & Loop
| Element | Tooltip |
|---------|---------|
| FPS input | `"Frames per second. 8 = simple, 12 = standard anime, 24 = full animation, 30 = smooth."` |
| Loop: None | `"Play once and stop at the last frame."` |
| Loop: Loop | `"Repeat the animation continuously."` |
| Loop: Ping-pong | `"Play forward, then backward, then forward again."` |

### Cel Actions
| Element | Tooltip |
|---------|---------|
| New cel | `"Add a new blank drawing on this frame."` |
| Delete cel | `"Remove this drawing. The frame becomes blank."` |
| Insert frame | `"Insert a blank frame here. All subsequent frames shift right."` |
| Delete frame | `"Remove this frame. All subsequent frames shift left."` |
| Extend hold | `"Hold this drawing for more frames. Drag the edge to extend."` |

### Layer Animation
| Element | Tooltip |
|---------|---------|
| Static toggle | `"Static: this layer shows the same drawing on every frame (backgrounds, overlays)."` |
| Animated toggle | `"Animated: this layer has separate drawings per frame (characters, effects)."` |

### Export
| Element | Tooltip |
|---------|---------|
| GIF | `"Export as an animated GIF. Good for sharing on social media, Discord, and messaging apps."` |
| MP4 | `"Export as a video file. Best quality and smallest file size."` |
| Sprite sheet | `"Export all frames in a single image grid. Used for game development and spritesheets."` |
| PNG sequence | `"Export every frame as a separate PNG. Standard for professional animation pipelines."` |
| Sticker | `"Export as a transparent animated sticker. Perfect for messaging apps and stream overlays."` |

---

## 12. Types Exported from Salsa

Frogmarks can import these from `@zaings/salsa/shape-manager`:

```ts
import ShapeManager from '@zaings/salsa/shape-manager';
import type {
  OnionSkinConfig,
  LoopMode,
  PlaybackState,
  TimelineState,
} from '@zaings/salsa/shape-manager';
```

The animation event listener type is inferred from the method signature:
```ts
const unsub = shapeManager.onAnimationEvent((event) => {
  // event: { type: string; frame?: number; layerId?: string; celId?: string }
});
```
