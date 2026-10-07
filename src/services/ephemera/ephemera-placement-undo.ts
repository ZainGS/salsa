/**
 * Ephemera placements on the 2D object undo stack (UI review 2026-10-07 §2b).
 *
 * Placing, deleting, editing (panel Apply, canvas move / resize / rotate) and rasterizing an ephemera placement used to
 * record nothing, so Ctrl+Z undid whatever the stack held before — an unrelated shape move or a brush stroke. Each is
 * now ONE command on the stack the engine's Ctrl+Z consumes first (VectorObjectUndo.pushCommand), the same pattern as
 * vector-layer-removal.ts.
 *
 * Commands retain the placement OBJECTS (never ids alone), so an undone delete re-inserts the very same record at its
 * old index and later commands that point at it keep applying. An edit snapshots the editable fields — svg included,
 * so undo never re-generates.
 *
 * Rasterize burns the visible placements into a paint layer AND removes them from the vector layer (a conversion — the
 * old burn-in kept them, so the overlay hid the burned copy and a later move revealed a double). The pixels are ONE
 * entry on that layer's own raster history; the command undoes / redoes that entry only while it is still the
 * layer's current / next entry (`historyMark`). If the layer was painted or undone on its own since, the pixels are
 * left as they are and only the placements come back — never a lost stroke.
 *
 * Pure over the small interfaces below (no renderer / DOM), so it is unit-tested with the real EphemeraService.
 */
import type { EphemeraPlacement } from './ephemera-types';

/** The placement registry calls (EphemeraService satisfies it). */
export interface PlacementStore {
    getPlacementsForLayer(layerId: string): EphemeraPlacement[];
    takePlacement(layerId: string, placementId: string): { index: number; placement: EphemeraPlacement } | null;
    reinsertPlacement(layerId: string, placement: EphemeraPlacement, index: number): void;
}

export interface UndoCommandSink {
    pushCommand(cmd: { description: string; undo(): void; redo(): void }): void;
}

export interface EphemeraUndoDeps {
    store: PlacementStore;
    /** The stack commands go onto (null = not undoable, e.g. a headless caller). */
    undo: UndoCommandSink | null;
    /** Placements of `layerId` changed (overlay redraw, package composite, panel refresh, autosave). */
    changed(layerId: string): void;
}

/** The paint-layer calls rasterize needs (RasterLayerManager satisfies them through the facade). */
export interface RasterizeTarget {
    /** Burn `placements` into `layerId` as ONE raster history entry. */
    composite(layerId: string, placements: EphemeraPlacement[]): Promise<boolean>;
    /** Identity tokens of the layer's current (`top`) and redo (`next`) raster history entries; null = no history. */
    historyMark(layerId: string): { top: unknown; next: unknown } | null;
    undo(layerId: string): Promise<boolean>;
    redo(layerId: string): Promise<boolean>;
}

const EDIT_KEYS = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'params', 'blendMode', 'glow', 'feather', 'svg'] as const;
type EditKey = typeof EDIT_KEYS[number];
type PlacementSnap = Partial<Pick<EphemeraPlacement, EditKey>>;

export type PlacementGeometry = Pick<EphemeraPlacement, 'x' | 'y' | 'width' | 'height' | 'rotation'>;

/** Params / glow / feather are plain JSON (they are persisted as such); copy them so later edits can't alias. */
function clone<T>(v: T): T {
    return v === undefined || v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)) as T;
}

function snap(p: EphemeraPlacement): PlacementSnap {
    const out: PlacementSnap = {};
    for (const k of EDIT_KEYS) (out as Record<string, unknown>)[k] = clone(p[k]);
    return out;
}

function sameSnap(a: PlacementSnap, b: PlacementSnap): boolean {
    return EDIT_KEYS.every(k => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
}

function applySnap(p: EphemeraPlacement, s: PlacementSnap): void {
    for (const k of EDIT_KEYS) (p as unknown as Record<string, unknown>)[k] = clone(s[k]);
}

function find(store: PlacementStore, layerId: string, placementId: string): EphemeraPlacement | undefined {
    return store.getPlacementsForLayer(layerId).find(p => p.id === placementId);
}

/** Put `placement` back at `index` unless it is already in its layer's list (a redo after a re-insert, say). */
function reinsert(store: PlacementStore, layerId: string, placement: EphemeraPlacement, index: number): void {
    if (store.getPlacementsForLayer(layerId).includes(placement)) return;
    store.reinsertPlacement(layerId, placement, index);
}

function remove(store: PlacementStore, layerId: string, placement: EphemeraPlacement): number {
    const index = store.getPlacementsForLayer(layerId).indexOf(placement);
    if (index < 0) return -1;
    store.takePlacement(layerId, placement.id);
    return index;
}

/** Record a placement that was just ADDED (already in its layer's list) as one step. */
export function recordPlacementAdded(deps: EphemeraUndoDeps, layerId: string, placement: EphemeraPlacement, description = 'Place ephemera'): void {
    let index = deps.store.getPlacementsForLayer(layerId).indexOf(placement);
    deps.changed(layerId);
    deps.undo?.pushCommand({
        description,
        undo: () => { const i = remove(deps.store, layerId, placement); if (i >= 0) index = i; deps.changed(layerId); },
        redo: () => { reinsert(deps.store, layerId, placement, index); deps.changed(layerId); },
    });
}

/** Delete one placement as one step. False (nothing recorded) when it doesn't exist. */
export function deletePlacementUndoable(deps: EphemeraUndoDeps, layerId: string, placementId: string, description = 'Delete ephemera'): boolean {
    const taken = deps.store.takePlacement(layerId, placementId);
    if (!taken) return false;
    const { placement } = taken;
    let index = taken.index;
    deps.changed(layerId);
    deps.undo?.pushCommand({
        description,
        undo: () => { reinsert(deps.store, layerId, placement, index); deps.changed(layerId); },
        redo: () => { const i = remove(deps.store, layerId, placement); if (i >= 0) index = i; deps.changed(layerId); },
    });
    return true;
}

/**
 * Run `apply` (which edits placement `placementId` in place — e.g. EphemeraService.updatePlacement) and record the
 * before / after of its editable fields as one step. Nothing is recorded when nothing changed. Returns apply's result.
 */
export function editPlacementUndoable(
    deps: EphemeraUndoDeps, layerId: string, placementId: string, apply: () => boolean, description = 'Edit ephemera',
): boolean {
    const p = find(deps.store, layerId, placementId);
    if (!p) return apply();
    const before = snap(p);
    const ok = apply();
    if (!ok) return ok;
    const after = snap(p);
    deps.changed(layerId);
    if (sameSnap(before, after)) return ok;
    deps.undo?.pushCommand({
        description,
        undo: () => { applySnap(p, before); deps.changed(layerId); },
        redo: () => { applySnap(p, after); deps.changed(layerId); },
    });
    return ok;
}

/** The geometry a canvas move / resize / rotate gesture starts from. */
export function placementGeometry(p: PlacementGeometry): PlacementGeometry {
    return { x: p.x, y: p.y, width: p.width, height: p.height, rotation: p.rotation };
}

/** Record a finished canvas gesture (the placement already holds its new geometry) as one step. */
export function recordPlacementGeometry(
    deps: EphemeraUndoDeps, layerId: string, placementId: string, before: PlacementGeometry, description = 'Move ephemera',
): boolean {
    const p = find(deps.store, layerId, placementId);
    if (!p) return false;
    const after = placementGeometry(p);
    deps.changed(layerId);
    if ((Object.keys(after) as (keyof PlacementGeometry)[]).every(k => after[k] === before[k])) return false;
    const b = { ...before };
    deps.undo?.pushCommand({
        description,
        undo: () => { Object.assign(p, b); deps.changed(layerId); },
        redo: () => { Object.assign(p, after); deps.changed(layerId); },
    });
    return true;
}

/**
 * Rasterize: burn the VISIBLE placements of `layerId` (or just `placementIds`) into paint layer `targetLayerId` and
 * remove them from the vector layer, as one step. Resolves false (nothing changed) when the composite fails; true with
 * nothing recorded when there is nothing visible to burn.
 */
export async function rasterizePlacementsUndoable(
    deps: EphemeraUndoDeps & { raster: RasterizeTarget },
    layerId: string, targetLayerId: string, placementIds?: readonly string[], description = 'Rasterize ephemera',
): Promise<boolean> {
    const { store, raster } = deps;
    const burn = store.getPlacementsForLayer(layerId)
        .filter(p => p.visible && (!placementIds || placementIds.includes(p.id)));
    if (burn.length === 0) return true;

    const topBefore = raster.historyMark(targetLayerId)?.top;
    if (!(await raster.composite(targetLayerId, burn))) return false;
    // The entry the composite pushed (none when it deduped / the layer keeps no history): only that one is undone.
    let entry: unknown = raster.historyMark(targetLayerId)?.top;
    if (entry === topBefore) entry = undefined;

    // Remove highest index first so the recorded indices stay valid; re-insert lowest first.
    const removed: { placement: EphemeraPlacement; index: number }[] = [];
    const takeAll = (): void => {
        removed.length = 0;
        for (const placement of burn) {
            const index = store.getPlacementsForLayer(layerId).indexOf(placement);
            if (index >= 0) removed.push({ placement, index });
        }
        removed.sort((a, b) => b.index - a.index);
        for (const r of removed) store.takePlacement(layerId, r.placement.id);
        removed.reverse();
    };
    takeAll();
    deps.changed(layerId);

    // 'applied': the burned pixels are on the layer as `entry`; 'undone': `entry` was undone by this command;
    // 'detached': the layer's history moved on independently — its pixels are no longer this command's to touch.
    let pixels: 'applied' | 'undone' | 'detached' = entry === undefined ? 'detached' : 'applied';
    deps.undo?.pushCommand({
        description,
        undo: () => {
            for (const r of removed) reinsert(store, layerId, r.placement, r.index);
            deps.changed(layerId);
            if (pixels === 'applied' && raster.historyMark(targetLayerId)?.top === entry) {
                pixels = 'undone';
                void raster.undo(targetLayerId);
            } else {
                pixels = 'detached';
            }
        },
        redo: () => {
            takeAll();
            deps.changed(layerId);
            if (pixels === 'undone' && raster.historyMark(targetLayerId)?.next === entry) {
                pixels = 'applied';
                void raster.redo(targetLayerId);
            } else if (pixels === 'undone') {
                // The layer was edited after the undo (its redo entry is gone): burn again as a new entry.
                pixels = 'detached';
                void raster.composite(targetLayerId, burn).then((ok) => {
                    const top = raster.historyMark(targetLayerId)?.top;
                    if (ok && top !== undefined) { entry = top; pixels = 'applied'; }
                });
            }
        },
    });
    return true;
}

/**
 * Placements live in WORLD units (y up, artboard-centred — see EphemeraOverlay.rasterizePlacements); a paint layer's
 * composite draws in texels (y down, origin top-left). Map `list` from a `world`-sized artboard onto a `tex`-sized
 * layer. The old rasterize passed world values straight through, so a 0.68-unit-wide placement became a sub-pixel
 * bitmap in the texture's corner.
 */
export function placementsToTexels(
    list: readonly EphemeraPlacement[], world: { width: number; height: number }, tex: { w: number; h: number },
): EphemeraPlacement[] {
    const sx = tex.w / world.width, sy = tex.h / world.height;
    return list.map((p) => {
        const w = Math.max(1, Math.round(p.width * sx)), h = Math.max(1, Math.round(p.height * sy));
        const cx = (p.x + p.width * 0.5) * sx + tex.w * 0.5;
        const cy = tex.h * 0.5 - (p.y + p.height * 0.5) * sy;
        // World rotation turns counter-clockwise (y up); in y-down texels the same turn is the negated angle.
        return { ...p, x: cx - w * 0.5, y: cy - h * 0.5, width: w, height: h, rotation: p.rotation === 0 ? 0 : -p.rotation };
    });
}
