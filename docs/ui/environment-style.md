# Environment Style — city, blocks and props (Frogmarks UI guide)

**Built 2026-09-29.** Give the **environment** a look (render style, toon shadows, rim light) separately from the
**characters**, and have it **saved**.

Procedural objects (the City, Neighborhood Blocks, and the creator props: buildings, vending machines, foliage,
benches, lamp posts, crates…) are rebuilt from their parameters on every edit and on reload. A style set directly on
their meshes used to vanish on the next rebuild. Each object now saves its own style and re-applies it after every
rebuild.

## The style

```ts
type ObjectStyle = {
  renderStyle?: 'default' | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud';
  toonShadow?: boolean;   // coloured toon shadows (Cel / Cel HD); the shadow colour is the scene-wide setToonShadows3D
  rimLight?: boolean;     // rim light; the look is the scene-wide setRimLight3D
};
```

Every setter takes a **patch**:
- a value **sets** that field;
- `null` **clears** it: the object goes back to its generator's own look;
- a field you leave out is unchanged.

Unlit meshes (labels, the landmark info card) and characters are never restyled.

## API (on `ShapeManager`)

| Call | What |
|---|---|
| `setEnvironmentStyle3D(patch)` / `getEnvironmentStyle3D()` | **The whole environment at once:** applies the patch to the city + every block + every creator prop. **New** blocks and props start with it. Saved with the document. |
| `setCityStyle3D(patch)` / `getCityStyle3D()` | The city only. Saved with the city (the render style used to be lost on reload) and carried to cities generated later. `world.setRenderStyle(style)` still works (= `setCityStyle3D({ renderStyle })`). |
| `setBlockStyle3D(blockId, patch)` / `getBlockStyle3D(blockId)` | One neighborhood block (every building in it). Saved with the block. |
| `setCreatorStyle3D(id, patch)` / `getCreatorStyle3D(id)` | One creator prop (any creator type). Saved with it. |

**Precedence:** each object keeps its **own** saved style. The Environment style is a *bulk setter* plus the
*starting point for new objects*. Setting it overwrites those fields on everything; afterwards you can still restyle
one block or one prop.

## UI (built in Frogmarks 2026-09-29)

- **Scene settings → "Environment Style"** (next to PS1 Retro Style / Lighting): Style (Not set / PBR / Cel / Cel HD
  / Sketch / Ink / Gouraud), Toon shadows, Rim light.
- **Edit Block panel → "Style"**: the same three, for that block.
- **City panel → Look**: the existing Style dropdown (now saved), plus Toon shadows and Rim light.
- Every panel reads its values back from the engine when it opens / after a load. Checkboxes send `null` when
  unticked (don't override), not `false`.
- Not built yet: a per-prop style row in the generic creator panel (`setCreatorStyle3D` is ready for it).

## A Persona-style starting point

- **Characters:** Cel + outlines + Retro colour (character-shading.md).
- **Environment:** Cel HD (or PBR) + Toon shadows, with a cool tinted shadow (`setToonShadows3D({ shadowTint })`),
  no outlines.
- **Scene:** mood from colour grade, fog and time of day.

Keep the environment a step softer than the characters, so they stay separated.
