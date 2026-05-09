# Frogmarks UI Spec: Layer Folders & 3D Divider

> **Date:** April 14, 2026  
> **Salsa version:** Current build  
> **Scope:** Layer panel UI updates to support folders, the 3D scene divider, and BG/FG raster compositing.

---

## What Changed in Salsa

### 1. Layer Stack Entries Now Have Types

`getRasterLayers()` (or `shapeManager.raster.getLayers()`) now returns entries with additional fields:

```ts
{
  id: string;
  name: string;
  type: 'layer' | 'folder' | '3d-divider';  // NEW — defaults to 'layer'
  parentId: string | null;                    // NEW — null = root level
  visible: boolean;
  locked: boolean;
  blendMode: LayerBlendMode;
  opacity: number;
  clipped: boolean;
  lockTransparency: boolean;
  collapsed?: boolean;                        // NEW — only meaningful for folders
}
```

Three entry types now exist in the flat ordered array:

| `type` | What it is | Has texture? | Paintable? |
|---|---|---|---|
| `'layer'` | Normal raster layer (existing) | Yes | Yes |
| `'folder'` | Organizational group | No | No |
| `'3d-divider'` | 3D scene render insertion point | No | No |

### 2. Layer Folders

Folders are purely organizational — they group layers visually in the panel. The compositor ignores them; only `'layer'` entries have textures.

Hierarchy is defined by `parentId`. A layer with `parentId: 'r_abc123'` is a child of the folder with `id: 'r_abc123'`. Folders can nest inside other folders.

### 3. 3D Scene Divider

The 3D divider is a special entry in the layer stack. It defines where 3D meshes render relative to raster layers:

```
┌─ Ink Lines (layer)         ─┐ FG: composited AFTER 3D meshes
├─ Color (layer)               │
├─ ── 3D Scene ── (divider)   ←  3D meshes render HERE
├─ Ground (layer)              │ BG: composited BEFORE 3D meshes
└─ Sky (layer)                ─┘
```

Only one divider is allowed. If no divider exists, all layers are background (original behavior).

---

## New API Methods

### Via `shapeManager.raster.*` (recommended) or `shapeManager.*` (legacy)

#### Layer Folders

| Method | Legacy Name | Description |
|---|---|---|
| `raster.addFolder(name?)` | `addRasterFolder(name?)` | Create a folder. Returns `{ id, name, type }` |
| `raster.setFolderCollapsed(id, collapsed)` | `setRasterFolderCollapsed(id, collapsed)` | Toggle folder open/closed in UI |
| `raster.setLayerParent(layerId, parentId)` | `setRasterLayerParent(layerId, parentId)` | Move layer into folder (or `null` for root) |
| `raster.deleteFolder(id)` | `deleteRasterFolder(id)` | Delete folder, children promoted to parent |

#### 3D Divider

| Method | Legacy Name | Description |
|---|---|---|
| `raster.add3DDivider(name?)` | `addRaster3DDivider(name?)` | Insert 3D divider (replaces existing). Returns divider id |
| `raster.remove3DDivider()` | `removeRaster3DDivider()` | Remove divider. All layers become BG |
| `raster.get3DDivider()` | `getRaster3DDivider()` | Get divider `{ id, name }` or `null` |
| `raster.has3DDivider()` | `hasRaster3DDivider()` | Boolean check |

#### Existing (updated return type)

| Method | Change |
|---|---|
| `raster.getLayers()` | Now returns `type`, `parentId`, `collapsed` fields |
| `raster.deleteLayer(id)` | Now handles folder deletion (promotes children) |
| `raster.reorderLayers(ids)` | Works with all entry types (layers, folders, dividers) |

---

## UI Implementation Guide

### Layer Panel Tree Rendering

The API returns a **flat ordered array** with `parentId` pointers. Build the tree in the UI:

```tsx
// Example: build tree from flat layer list
function buildLayerTree(layers: LayerEntry[]) {
  const root: TreeNode[] = [];
  const map = new Map<string, TreeNode>();

  // Create nodes
  for (const l of layers) {
    map.set(l.id, { ...l, children: [] });
  }

  // Link parents (preserve array order — it's bottom-to-top)
  for (const l of layers) {
    const node = map.get(l.id)!;
    if (l.parentId && map.has(l.parentId)) {
      map.get(l.parentId)!.children.push(node);
    } else {
      root.push(node);
    }
  }

  return root;
}
```

### Rendering Each Entry Type

```tsx
function LayerEntry({ entry }: { entry: TreeNode }) {
  switch (entry.type) {
    case 'layer':
      return <RasterLayerRow layer={entry} />;  // existing layer row

    case 'folder':
      return (
        <FolderRow
          name={entry.name}
          collapsed={entry.collapsed}
          onToggle={() => sm.raster.setFolderCollapsed(entry.id, !entry.collapsed)}
        >
          {!entry.collapsed && entry.children.map(c => (
            <LayerEntry key={c.id} entry={c} />
          ))}
        </FolderRow>
      );

    case '3d-divider':
      return <DividerRow name={entry.name} onRemove={() => sm.raster.remove3DDivider()} />;
  }
}
```

### 3D Divider Row

The divider should look distinct — a horizontal separator with a label:

```
╌╌╌╌╌╌╌╌ 🎲 3D Scene ╌╌╌╌╌╌╌╌ [✕]
```

- Non-selectable (can't paint on it)
- Locked by default (shows lock icon)
- Draggable to reorder (user drags it up/down to change which layers are BG vs FG)
- Has a remove button (×) that calls `raster.remove3DDivider()`

### Folder Row

Standard collapsible folder:

```
📁 ▸ Character Art              [👁] [🔒]
   ├─ Ink Lines
   ├─ Flat Colors
   └─ Sketch
```

- Click chevron to toggle collapsed
- Drag layers into/out of folders
- Visibility toggle hides all children
- Name is editable (rename via existing `setNodeName` if supported, or layer rename)

### Toolbar Buttons

Add two buttons to the layer panel toolbar:

| Button | Action | Icon |
|---|---|---|
| **New Folder** | `sm.raster.addFolder()` | 📁 |
| **Add 3D Divider** | `sm.raster.add3DDivider()` | 🎲 or ⬡ |

The 3D divider button should be disabled/hidden if one already exists (`sm.raster.has3DDivider()`).

### Drag-and-Drop Reorder

When the user drags a layer:

1. **Into a folder:** Call `sm.raster.setLayerParent(layerId, folderId)`
2. **Out of a folder (to root):** Call `sm.raster.setLayerParent(layerId, null)`
3. **Reposition in stack:** Call `sm.raster.reorderLayers(newOrderedIds)` with the full flat ID list in new order
4. **Moving the 3D divider:** Same as reposition — include the divider's ID in the reorder array

When reordering, include ALL entry IDs (layers + folders + divider) in the ordered array.

### Preventing Invalid Operations on Non-Layer Entries

Folders and the 3D divider are **not paintable**. Guard against:

- **Selecting a folder or divider as the active painting target** — skip them in selection. When the user clicks a folder, expand/collapse it instead of selecting it as the active layer.
- **Applying blend modes, opacity, clipping to folders** — these fields exist on the entry but have no effect. Hide or disable those controls when a folder/divider is selected.
- **The 3D divider should not be deletable via the normal "delete layer" button** — use `remove3DDivider()` instead, or let `deleteLayer()` handle it (it works, but the UX should signal it's a divider removal).

### Example: Full Layer Panel Setup with 3D Scene

```ts
const sm = shapeManager;

// Create background layers
sm.raster.addLayer('Sky');
sm.raster.addLayer('Mountains');

// Insert the 3D divider
sm.raster.add3DDivider();

// Create foreground layers
sm.raster.addLayer('Rain Overlay');
sm.raster.addLayer('Ink Lines');

// Organize foreground into a folder
const folder = sm.raster.addFolder('Foreground Art');
const layers = sm.raster.getLayers();
const inkLayer = layers.find(l => l.name === 'Ink Lines');
const rainLayer = layers.find(l => l.name === 'Rain Overlay');
if (folder && inkLayer) sm.raster.setLayerParent(inkLayer.id, folder.id);
if (folder && rainLayer) sm.raster.setLayerParent(rainLayer.id, folder.id);

// Result layer stack (bottom to top):
// Sky (BG)
// Mountains (BG)
// ── 3D Scene ──         ← 3D meshes render here
// 📁 Foreground Art (FG)
//    Rain Overlay (FG)
//    Ink Lines (FG)

// Now create 3D content that renders between BG and FG
sm.scene3d.createBox(0, 0, 0, 1, 1, 1, { diffuse: { r: 0.8, g: 0.2, b: 0.2, a: 1 } });
sm.scene3d.createCamera({ position: [0, 2, 5], target: [0, 0, 0] });
sm.scene3d.enableOrbitControls();
```

---

## Render Order Visualization

```
┌─────────────────────────────────────────┐
│            Final Composite              │
├─────────────────────────────────────────┤
│  5. Vector shapes (SDF text, scribbles, │  ← drawVectorShapes()
│     panels, speech balloons, stamps)    │
├─────────────────────────────────────────┤
│  4. FG Raster Quad                      │  ← rasterTextureFG (layers above divider)
│     (Ink Lines, Rain Overlay)           │
├─────────────────────────────────────────┤
│  3. 3D Meshes                           │  ← draw3DMeshes() with depth testing
│     (PS1-style boxes, spheres, etc.)    │
├─────────────────────────────────────────┤
│  2. BG Raster Quad                      │  ← rasterTexture (layers below divider)
│     (Sky, Mountains)                    │
├─────────────────────────────────────────┤
│  1. Artboard Checkerboard               │  ← transparency indicator
└─────────────────────────────────────────┘
```

---

## Performance Notes

- **Zero cost when no divider exists.** Without a divider, the old single-composite path runs unchanged.
- **With a divider:** +1 compositor call for FG layers, +1 grain/dither pass (~0.3ms), +8MB VRAM for the FG texture, +1 quad draw call (negligible). Total overhead < 1ms on mid-range GPU at 1080p.
- **Folders have no GPU cost.** They're metadata-only — the compositor never sees them.

---

## Serialization

Both `getLayerMetadata()` and `getLayers()` now include `type`, `parentId`, and `collapsed`. When saving/loading documents:

- Save the full layer metadata array (already includes new fields)
- On load, restore folders and the divider via `addLayerWithId()` or re-create them
- The `type` field defaults to `'layer'` for backward compatibility — old saved documents load fine
