# Arrowhead Style Migration
**Last Updated:** 2026-04-27  

## Summary

Salsa's `ArrowheadStyle` type has been expanded with new circle styles. `'triangle'` is still a first-class style. The old `'open'` value still compiles (backward compatible) but is deprecated — it renders as `'openCircle'`.

## Available Styles

| Value           | Renders As         |
|----------------|---------------------|
| `'none'`       | No arrowhead        |
| `'triangle'`   | Filled triangle (▶) |
| `'closedCircle'`| Filled circle (●)  |
| `'openCircle'` | Hollow circle (○)   |
| `'open'`       | *(deprecated, alias for `openCircle`)* |

## What to Change in Frogmarks

1. **`brush-preset.model.ts`** — Update the `ArrowheadStyle` type:
   ```ts
   // Before
   export type ArrowheadStyle = 'none' | 'triangle' | 'open';

   // After
   export type ArrowheadStyle = 'none' | 'triangle' | 'closedCircle' | 'openCircle';
   ```

2. **Any UI dropdowns / selectors** — Add new options, replace `'open'`:
   - Keep `'triangle'` as-is
   - `'open'` → `'openCircle'` (label: "Open Circle")
   - Add `'closedCircle'` (label: "Closed Circle")

3. **Persisted data** — Saved boards with `'open'` will still work at runtime (salsa maps it to `openCircle` internally), but new saves should use `'openCircle'`.
