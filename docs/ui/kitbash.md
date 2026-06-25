# Kitbash Character Creator — Frogmarks UI Integration
**Last Updated:** 2026-05-10

Covers how the Frogmarks Angular app wires the character creator panel to the Salsa kitbash engine API — **assembling** a character from a library of pre-made parts (slot swap). For **creating** the base body + custom clothing in-app (procedural body generator, offset-copy / draw-to-inflate garments), see [character-creator.md](./character-creator.md). For engine internals see [docs/specs/kitbash-armature-grease-pencil.md](../specs/kitbash-armature-grease-pencil.md).

---

## Prerequisites

Phase A (armatures) and Phase B (kitbashing) must be initialized. Call once during app boot, before the character creator panel is shown:

```typescript
// Fetch and parse the part catalog from the CDN (or bundled asset URL).
await shapeManager.loadKitbashLibrary3D('https://cdn.frogmarks.app/kitbash/v1/manifest.json');
```

Alternatively, if parts are bundled into the Angular app:

```typescript
import manifestJson from './assets/kitbash/manifest.json';
shapeManager.addKitbashParts3D(manifestJson.parts);
```

---

## Character creator panel

### Layout

```
┌──────────────────────────────────────────────────────────┐
│  Characters                                    [+ New]   │
│  ──────────────────────────────────────────────────────  │
│  ● Hero        [Edit]  [Duplicate]  [×]                  │
│  ● Sidekick    [Edit]  [Duplicate]  [×]                  │
│                                                          │
│  ─── Creator (shown when Edit is active) ─────────────  │
│  Slot tabs:                                              │
│    [Base] [Hair] [Top] [Bottom] [Shoes]                  │
│    [Head Acc] [Back Acc] [Left Hand] [Right Hand]        │
│                                                          │
│  Part grid (4 columns):                                  │
│    [img]  [img]  [img]  [img]                            │
│    [img]  [img]  [img]  [img]                            │
│    (selected part highlighted)                           │
│                                                          │
│  Skin tone  ● ● ● ● ●  (5 preset swatches + custom)    │
│  Hair color [color swatch]                               │
│                                                          │
│  [Add to Scene]  ← only shown for new characters         │
│  [Update]        ← shown when editing an existing char   │
└──────────────────────────────────────────────────────────┘
```

---

## Slot tab → Salsa CharacterSlot mapping

| Tab label       | `CharacterSlot` value  |
|-----------------|------------------------|
| Base            | `base_body`            |
| Hair            | `hair`                 |
| Face            | `face_overlay`         |
| Top             | `top`                  |
| Bottom          | `bottom`               |
| Shoes           | `shoes`                |
| Head Acc        | `accessory_head`       |
| Back Acc        | `accessory_back`       |
| Left Hand       | `accessory_left`       |
| Right Hand      | `accessory_right`      |
| Overlay         | `overlay`              |

---

## Wiring the part grid

```typescript
import type { CharacterSlot, KitbashPartMeta } from 'salsa';

// When user switches slot tab:
onSlotChange(slot: CharacterSlot) {
    this.currentSlot = slot;
    this.parts = shapeManager.getKitbashParts3D(slot);
    // Render thumbnail grid from parts[].thumbnail URLs.
}

// When user clicks a part thumbnail:
onPartSelect(part: KitbashPartMeta) {
    this.pendingDef.slots[this.currentSlot] = part.id;
    this.selectedPartIds[this.currentSlot] = part.id;
}
```

Thumbnails come from `part.thumbnail` (a URL or TextureLibrary ID).

---

## Creating a new character

```typescript
import { v4 as uuidv4 } from 'uuid';

async onAddToScene() {
    const def: CharacterDefinition = {
        id:   uuidv4(),
        name: this.characterName,
        slots: { ...this.pendingDef.slots },
        skinTone:  this.selectedSkinTone,   // { r, g, b } or undefined
        hairColor: this.selectedHairColor,  // { r, g, b } or undefined
    };

    // base_body is required — guard before calling.
    if (!def.slots['base_body']) {
        this.showError('Select a base body before adding to scene.');
        return;
    }

    const charId = await shapeManager.createCharacter3D(def, 0, 0, 0);
    this.characters.push({ id: charId, name: def.name });
}
```

`createCharacter3D` is async — it fetches and parses GLBs. Show a loading indicator while it resolves.

---

## Swapping a slot on an existing character (live update)

```typescript
// User selects a new hair part while editing character "charId":
async onSwapSlot(charId: string, slot: CharacterSlot, partId: string) {
    await shapeManager.swapCharacterSlot3D(charId, slot, partId);
    // The old mesh is removed and the new one appears immediately.
}
```

---

## Color tints

Apply after `createCharacter3D` resolves, or in response to the skin-tone / hair-color swatch pickers:

```typescript
// Skin tone (0–255 per channel):
shapeManager.setCharacterSlotColor3D(charId, 'base_body', skinTone.r, skinTone.g, skinTone.b);

// Hair color:
shapeManager.setCharacterSlotColor3D(charId, 'hair', hairColor.r, hairColor.g, hairColor.b);
```

Tints are diffuse-multiply — they work best on white or light-colored base textures.

---

## Removing a character

```typescript
shapeManager.removeCharacter3D(charId);
// The Skeleton3D and all SkinnedMesh3D nodes are removed from the scene.
```

---

## Posing / animation

The character's skeleton is exposed through the existing armature API. No new calls needed:

```typescript
// Get the skeleton ID for a character:
const def = shapeManager.getCharacterDefinition3D(charId);
// skeletonId is stored in CharacterData — access via getAllCharacters3D():
const charData = shapeManager.getAllCharacters3D().find(c => c.id === charId);
const skeletonId = charData?.skeletonId;

// Pose a joint:
shapeManager.setJointRotation3D(skeletonId, 'head', 0, 0.3, 0, 0.95);

// Play a bundled animation clip:
shapeManager.playSkeletonClip3D(skeletonId, 'walk', true);
```

---

## Save / restore

Characters are serialized automatically inside `packProject()` and restored by `unpackProject()`. No extra wiring needed — the `characters3d` array is included in `scene3d.json` within the `.frogmarks` ZIP.

On restore, mesh and skeleton nodes are re-created first (existing flow), then the character catalog entries are re-linked by ID.

**Note:** The GLB bytes for each character part are stored in `models3d/` inside the ZIP (keyed by SkinnedMesh3D ID), so the character is fully self-contained in the file — no CDN access needed on reload.
