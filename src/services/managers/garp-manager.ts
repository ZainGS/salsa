// ── GarpManager — the dedicated GARP registry (pools + textures + stable atlas-layer assignment) ─────
// docs/specs/city-props-garp.md §2. Owns the host-facing GARP state: registered POOLS (from garp.ts), the
// TEXTURES their skins reference (each a DecalSource — the same ephemera/upload sources decals use), and a
// STABLE key → atlas-layer-index map. A consumer (the vending machine) asks `skinLayer(pool, skin, slot)` for
// the layer to write as a per-instance textureIndex (the renderer primitive added in array-group-3d.ts).
//
// This is the PURE-registry half — no GPU. Resolving the DecalSources to bitmaps and uploading them into the
// dedicated GARP texture_2d_array (+ the shader sampling it) is the renderer half, wired at the browser step.
// ★ Layer indices are assigned in REGISTRATION ORDER and never reused, so a key always maps to the same layer
// for the life of the session — a saved city that stored "skin X → layer 4" stays correct.

import type { GarpPool, GarpSkin } from '../../world/garp';
import { validateGarpPool, skinSlot } from '../../world/garp';
import type { DecalSource } from './decal-geometry';

/** Layer 0 of the GARP atlas is reserved as the BLANK/white fallback (an unknown or unresolved texture key
 *  renders blank rather than garbage), exactly like the mesh atlas's layer 0. Real textures start at 1. */
export const GARP_BLANK_LAYER = 0;

export class GarpManager {
    private readonly _pools = new Map<string, GarpPool>();
    private readonly _textures = new Map<string, DecalSource>();   // texture key → its source (ephemera/upload)
    private readonly _layer = new Map<string, number>();           // texture key → stable GARP atlas layer index
    private readonly _notLive = new Map<string, Set<string>>();    // poolId → slots that DON'T render in-city yet
    private _nextLayer = 1;                                        // 0 reserved (GARP_BLANK_LAYER)
    /** Set when a texture is (re)registered — the atlas must be (re)built before the next draw. */
    private _atlasDirty = false;

    /** Register (or replace) a texture under a stable KEY, from a DecalSource (an ephemera generator or an
     *  uploaded image — the same sources decals use). Assigns a stable atlas layer on first sight. Returns it. */
    registerTexture(key: string, source: DecalSource): number {
        this._textures.set(key, source);
        if (!this._layer.has(key)) this._layer.set(key, this._nextLayer++);
        this._atlasDirty = true;
        return this._layer.get(key)!;
    }

    /** The GARP atlas layer for a texture key — {@link GARP_BLANK_LAYER} for an unknown/null key. */
    layerOf(key: string | null): number {
        return key != null ? (this._layer.get(key) ?? GARP_BLANK_LAYER) : GARP_BLANK_LAYER;
    }

    /** Register (or replace) a pool, keyed by its STABLE `id` (never the display name — bare names collide the
     *  instant two users publish a pool). Returns the validation problems ([] = OK); a pool with problems is still
     *  stored so a half-authored pool can be fixed incrementally, but the caller should surface the errors. */
    registerPool(pool: GarpPool): string[] {
        const errs = validateGarpPool(pool);
        this._pools.set(pool.id, pool);
        return errs;
    }
    /** Append (or replace, by name) a SKIN in an existing pool and bump its version — for user-authored variants
     *  added at runtime. The skin's slot textures must be {@link registerTexture}ed (before the atlas rebuild).
     *  Returns validation problems, or `['no pool …']` if the pool isn't registered. */
    addSkin(poolId: string, skin: GarpSkin): string[] {
        const pool = this._pools.get(poolId);
        if (!pool) return [`no pool "${poolId}"`];
        const next: GarpPool = { ...pool, version: pool.version + 1, skins: [...pool.skins.filter((s) => s.name !== skin.name), skin] };
        return this.registerPool(next);
    }
    /** Remove a SKIN from a pool (bumps version) and free any slot textures no remaining skin/default references,
     *  so a user can iterate/delete variants. Returns validation problems, or `['no pool …']` if absent. */
    removeSkin(poolId: string, skinName: string): string[] {
        const pool = this._pools.get(poolId);
        if (!pool) return [`no pool "${poolId}"`];
        const removed = pool.skins.find((s) => s.name === skinName);
        const next: GarpPool = { ...pool, version: pool.version + 1, skins: pool.skins.filter((s) => s.name !== skinName) };
        if (removed) {
            const stillUsed = new Set<string>();
            for (const s of next.skins) for (const k of Object.values(s.slots)) stillUsed.add(k);
            for (const k of Object.values(pool.defaults ?? {})) stillUsed.add(k);
            for (const k of Object.values(removed.slots)) {
                if (!stillUsed.has(k)) { this._textures.delete(k); this._layer.delete(k); this._atlasDirty = true; }
            }
        }
        return this.registerPool(next);
    }

    /** Declare whether a pool `slot` actually RENDERS in the world yet — the host UI badges non-live slots
     *  ("saved, not shown in-city"). Slots are live by DEFAULT; the engine marks the ones it hasn't wired a
     *  consumer for (e.g. vending `products` is authorable but not yet instanced on city machines). */
    setSlotLive(poolId: string, slot: string, live: boolean): void {
        let set = this._notLive.get(poolId);
        if (live) { set?.delete(slot); }
        else { if (!set) { set = new Set(); this._notLive.set(poolId, set); } set.add(slot); }
    }

    getPool(id: string): GarpPool | undefined { return this._pools.get(id); }
    /** Pool summaries for the authoring UI. `skins` is the LIST of skins (each `{ name }`) — map it for the
     *  variant list + per-skin delete button, and `.length` for the count. `slots[i].live` = does that slot
     *  render in-world yet (default true; see {@link setSlotLive}) — drive the "not shown in-city" badge from it. */
    listPools(): { id: string; name: string; version: number; slots: { name: string; live: boolean }[]; skins: { name: string }[] }[] {
        return [...this._pools.values()].map((p) => ({
            id: p.id, name: p.name, version: p.version,
            skins: p.skins.map((s) => ({ name: s.name })),
            slots: p.slots.map((name) => ({ name, live: !(this._notLive.get(p.id)?.has(name)) })),
        }));
    }
    removePool(id: string): boolean { this._notLive.delete(id); return this._pools.delete(id); }

    /** Whether every texture a pool references (across all skins + defaults) has been registered yet. A pool can
     *  be registered before its skin textures resolve (ephemera generation / uploads are async) — until then a
     *  consumer gets the BLANK/default layer (see {@link skinLayer}) rather than an undefined race that shows up
     *  as intermittent holes. Consumers can gate on this and re-pick once true. */
    poolResolved(id: string): boolean {
        const pool = this._pools.get(id);
        if (!pool) return false;
        for (const skin of pool.skins) {
            for (const slot of pool.slots) {
                const key = skinSlot(pool, skin, slot);
                if (key != null && !this._layer.has(key)) return false;
            }
        }
        return true;
    }

    /** The GARP atlas layer for a SKIN's slot — the value a consumer writes as a per-instance textureIndex.
     *  ★ ONE fallback ladder, degrading to the pool DEFAULT rather than a HOLE (blank is the last resort only when
     *  nothing at all has loaded — a blank slot reintroduces the very hole the default exists to prevent):
     *    1. the skin's own slot texture, if resolved;
     *    2. else the pool DEFAULT for that slot, if resolved (covers a pending skin texture AND an omitted slot);
     *    3. else blank.
     *  Same rung as {@link skinSlot} (half-authored) and {@link poolResolved} (async-pending), unified here. */
    skinLayer(poolId: string, skin: GarpSkin, slot: string): number {
        const pool = this._pools.get(poolId);
        if (!pool) return GARP_BLANK_LAYER;
        const own = skin.slots[slot];
        if (own != null && this._layer.has(own)) return this._layer.get(own)!;
        const def = pool.defaults?.[slot];
        if (def != null && this._layer.has(def)) return this._layer.get(def)!;
        return GARP_BLANK_LAYER;
    }

    /** The GARP atlas layer for a skin identified BY NAME (the form world-gen carries on an instance — a name,
     *  never a layer index). Blank for an unknown pool/skin. The scene-instantiation resolver ShapeManager wires. */
    layerForSkinName(poolId: string, skinName: string | undefined, slot: string): number {
        if (!skinName) return GARP_BLANK_LAYER;
        const pool = this._pools.get(poolId);
        const skin = pool?.skins.find((s) => s.name === skinName);
        return skin ? this.skinLayer(poolId, skin, slot) : GARP_BLANK_LAYER;
    }

    /** Every (key, source) the atlas must resolve + upload, in LAYER-INDEX order (layer 1..N). The renderer
     *  half walks this to build the dedicated texture_2d_array. */
    textureBuildList(): { key: string; source: DecalSource; layer: number }[] {
        return [...this._textures.entries()]
            .map(([key, source]) => ({ key, source, layer: this._layer.get(key)! }))
            .sort((a, b) => a.layer - b.layer);
    }
    /** Highest assigned layer (so the atlas is sized to `layerCount + 1`, incl. the blank layer 0). */
    get layerCount(): number { return this._nextLayer; }
    get atlasDirty(): boolean { return this._atlasDirty; }
    markAtlasClean(): void { this._atlasDirty = false; }

    // ── Persistence (docs/ui/garp.md) ──────────────────────────────────────────────────────────────
    // GARP is user-authored content → it MUST survive save/reload. Because every texture is stored as a
    // DecalSource (ephemera params or an image dataUrl), the whole registry is already JSON-serializable —
    // no bitmap blob walk needed. ★ Layer indices are NEVER serialized (session-local): restore re-registers
    // textures in order and reassigns layers, so a saved city that referenced a skin BY NAME still resolves.

    /** A JSON-serializable snapshot of the registered pools + their texture sources (no atlas / no layers). */
    serialize(): { pools: GarpPool[]; textures: Record<string, DecalSource> } {
        return { pools: [...this._pools.values()], textures: Object.fromEntries(this._textures) };
    }

    /** Re-register pools + texture sources from a {@link serialize} snapshot (textures FIRST so pools resolve).
     *  Fresh session-local layers are assigned; the caller rebuilds the atlas afterwards. */
    restore(data: { pools?: GarpPool[]; textures?: Record<string, DecalSource> } | null | undefined): void {
        if (!data) return;
        for (const [key, source] of Object.entries(data.textures ?? {})) this.registerTexture(key, source);
        for (const pool of data.pools ?? []) this.registerPool(pool);
    }
}
