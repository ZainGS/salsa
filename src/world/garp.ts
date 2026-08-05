// ── GARP — Grouped Asset Randomizer Pool (data model + selection) ────────────────────────────────
// docs/specs/city-props-garp.md §2. A POOL holds a set of coordinated SKINS for one prop family (vending
// machines, shop signage, poster boards…). A SKIN is a NAMED set of textures that belong together, one per
// SLOT the pool defines (a vending machine's `fascia` + `products`). The unit of randomisation is the SKIN,
// never the individual texture — picking per-slot would put a Coke fascia over Pocari products. Each placed
// object picks a skin by POSITION HASH (deterministic → selective regen stays idempotent, the same rule the
// rest of the city follows).
//
// This module is the PURE half — types + selection. Texture keys are opaque strings; resolving them to atlas
// layers (and the "all textures in a pool must be the same size/format" rule) is the renderer/services half,
// wired later. Lives in src/world so the city generator can pick skins; services may import world, never the
// reverse.

import { hash2 } from './util';

/** One coordinated look: a texture key per slot the pool defines, plus an optional pick weight + body tint.
 *  `slots` values are opaque texture KEYS (resolved to atlas layers downstream). A skin may omit a slot; the
 *  caller falls back to the pool's per-slot default (see {@link skinSlot}). */
export interface GarpSkin {
    name: string;
    slots: Record<string, string>;
    /** Relative pick frequency (default 1). 0 disables the skin without removing it. */
    weight?: number;
    /** Optional per-skin body tint (for props whose base colour co-varies with the skin). */
    tint?: [number, number, number];
}

/** A pool of coordinated skins for ONE prop family. `size` is the px dimensions every skin texture MUST match
 *  (the atlas packs one fixed resolution per pool — a mismatch falls back to blank downstream). `slots` names
 *  the texture slots; `defaults` supplies a fallback texture key per slot for skins that omit one.
 *
 *  ★ IDENTITY: `id` is the STABLE, author-namespaced key everything references (a saved city, a consumer) —
 *  never a bare display `name`, which collides the instant two users publish a pool. `version` bumps on any
 *  content/schema change; a saved city can pin `id`+`version` so it renders as painted (persistence decides
 *  pin-vs-latest). NOTHING serialized ever holds an atlas LAYER INDEX — those are session-local (a dedicated
 *  atlas with dynamic pool load/unload repacks, so a stored layer breaks on the first unload). */
export interface GarpPool {
    id: string;
    name: string;
    version: number;
    size: [number, number];
    slots: string[];
    skins: GarpSkin[];
    defaults?: Record<string, string>;
}

/** Salt so a prop's skin choice is independent of its foliage/tint/other position-hashed rolls. */
const GARP_SALT = 0x6a12b3;
/** Placement grid for the position hash: 1 world unit / this = one cell. ★ We hash INTEGER cell coords, not
 *  raw floats — float hashing drifts across platforms and shifts the moment layout math changes by an ULP,
 *  which would silently reskin a saved/shared city. 64 cells per world unit ≈ 23 cm at the city's ~15 m/unit
 *  — fine enough to distinguish neighbouring props, coarse enough to absorb sub-unit float noise. */
const GARP_GRID = 64;

/** The texture key for `slot` on `skin`, falling back to the pool default, or null if neither defines it. */
export function skinSlot(pool: GarpPool, skin: GarpSkin, slot: string): string | null {
    return skin.slots[slot] ?? pool.defaults?.[slot] ?? null;
}

/** FNV-1a hash of a skin's (stable) NAME → folds into the position hash so each skin draws an INDEPENDENT random
 *  stream per cell (the basis of rendezvous hashing below). */
function skinNameHash(name: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
    return h >>> 0;
}

/** Pick a skin for an object at world (x, z) — deterministic per (grid cell, seed), weighted by `skin.weight`.
 *  Returns null only for an empty pool.
 *
 *  ★ WEIGHTED RENDEZVOUS HASHING (highest-random-weight), NOT roulette-wheel. Each skin scores `w / -ln(h)`, where
 *  `h ∈ (0,1)` is hashed from (cell, seed, skin NAME); the argmax wins. This is what makes a MUTABLE pool safe: a
 *  roulette-wheel walk over cumulative weights re-rolls nearly every cell when a skin is added (every boundary
 *  shifts), so a user adding one variant would reshuffle the WHOLE city on the next regen, and two users with
 *  different-sized pools would see unrelated cities. With rendezvous, adding/removing a skin only flips the ~w/total
 *  of cells where that skin now wins/loses — every other cell KEEPS its assignment — and registration ORDER is
 *  irrelevant. Referenced by `skin.name` (stable); integer grid cell → platform-stable. Weight 0 → never wins. */
export function pickSkin(pool: GarpPool, x: number, z: number, seed: number): GarpSkin | null {
    if (pool.skins.length === 0) return null;
    if (pool.skins.length === 1) return pool.skins[0];
    const gx = Math.round(x * GARP_GRID), gz = Math.round(z * GARP_GRID);   // integer cell → platform-stable
    let best: GarpSkin | null = null, bestScore = -Infinity;
    for (const s of pool.skins) {
        const w = Math.max(0, s.weight ?? 1);
        if (w <= 0) continue;                                              // disabled → never wins
        const h = hash2(gx, gz, (seed ^ GARP_SALT ^ skinNameHash(s.name)) >>> 0);
        const hc = h <= 0 ? 1e-9 : h >= 1 ? 1 - 1e-9 : h;                  // guard -ln(0)/-ln(1)
        const score = w / -Math.log(hc);
        // Strict > keeps the first-seen on an (astronomically rare) exact tie; break ties by name for determinism.
        if (score > bestScore || (score === bestScore && best !== null && s.name < best.name)) { bestScore = score; best = s; }
    }
    return best ?? pool.skins[0];   // all weights 0 → fall back to the first skin
}

/** Validate a pool's shape (NOT texture sizes — that needs the loaded images, done in the renderer half).
 *  Returns the list of problems; empty = OK. Every skin must supply every slot either directly or via a
 *  pool default, or the object renders a hole. */
export function validateGarpPool(pool: GarpPool): string[] {
    const errs: string[] = [];
    if (!pool.id) errs.push(`pool "${pool.name}" has no id (a stable, author-namespaced key is required)`);
    if (!Number.isFinite(pool.version)) errs.push(`pool "${pool.id || pool.name}" has no version`);
    if (!pool.slots.length) errs.push(`pool "${pool.name}" defines no slots`);
    if (!pool.skins.length) errs.push(`pool "${pool.name}" has no skins`);
    const names = new Set<string>();
    for (const skin of pool.skins) {
        if (names.has(skin.name)) errs.push(`pool "${pool.name}" has a duplicate skin "${skin.name}"`);
        names.add(skin.name);
        for (const slot of pool.slots) {
            if (skinSlot(pool, skin, slot) === null) errs.push(`skin "${skin.name}" is missing slot "${slot}" (no default)`);
        }
    }
    return errs;
}
