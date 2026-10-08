/**
 * ONE memory budget for ALL raster undo history (perf audit C3, 2026-10-09).
 *
 * Every RasterSnapshotManager (a layer's history, each animation cel's, the paint engine's) registers here. The bytes
 * that count are the ones a history really holds: FULL entries' pixels (incl. a blank seed's zeros once materialised
 * by a fold, and a BORROWED load seed — the history keeps that buffer alive) and both halves of every stroke patch. A
 * blank seed holds nothing. Each history still keeps at most its own entry count (10).
 *
 * After every push the total is checked. Over budget → the OLDEST undo steps across all histories are dropped (each
 * entry carries a global stamp; the history whose oldest step is the oldest loses it, folded into its seed exactly as
 * the per-history trim does — RasterSnapshotManager.trimOldestStep). Never the current state, never a redo entry, and
 * only in a history where trimming down to its floor frees memory (a BLANK seed followed by small stroke patches would
 * GROW: the fold materialises a whole frame):
 *  1. trim only histories that keep at least ONE undo step afterwards (every layer / cel keeps its newest step);
 *  2. still over: trim the other histories down to their current state, the history being pushed to excepted (it
 *     keeps its newest step).
 * Whatever is left (current states alone over the budget) stays — the budget never drops the current pixels.
 *
 * Defaults: 256 MB until the renderer applies its tier's caps (GpuCaps.undoMemoryBytes: 768 MB desktop, 256 MB mobile
 * and safe). `setRasterUndoBudget(bytes)` (sm.setUndoMemoryBudget) overrides the tier default; null goes back to it.
 * WeakRefs: a history dropped without destroy() (a deleted cel's) stops counting once it is collected.
 */

/** What the budget needs from a history (RasterSnapshotManager implements it). */
export interface BudgetedHistory {
  /** Bytes the history holds now. */
  heldBytes(): number;
  /** Undo steps below the current state (0 = only the current state). */
  undoSteps(): number;
  /** The global stamp of the oldest undo step (Infinity when there is none). */
  oldestStepStamp(): number;
  /** Bytes trimming down to `keepSteps` undo steps would free (≤ 0 = not worth trimming). */
  trimGain(keepSteps: number): number;
  /** Drop the oldest undo step (fold it into the seed). False when there is none. */
  trimOldestStep(): boolean;
}

export const DEFAULT_RASTER_UNDO_BUDGET = 256 * 1024 * 1024;

let tierBudget = DEFAULT_RASTER_UNDO_BUDGET;
let overrideBudget: number | null = null;
let stampSeq = 0;
let enforcing = false;
const live = new Set<WeakRef<BudgetedHistory>>();
const refOf = new WeakMap<BudgetedHistory, WeakRef<BudgetedHistory>>();

/** Diagnostics / tests: steps the budget dropped (in total). */
export const rasterUndoBudgetStats = { trims: 0 };

/** A new global stamp (entries pushed later have larger stamps). */
export function nextUndoStamp(): number { return ++stampSeq; }

export function registerUndoHistory(h: BudgetedHistory): void {
  if (refOf.has(h)) return;
  const r = new WeakRef(h);
  refOf.set(h, r);
  live.add(r);
}

export function unregisterUndoHistory(h: BudgetedHistory): void {
  const r = refOf.get(h);
  if (!r) return;
  live.delete(r);
  refOf.delete(h);
}

/** The budget in force, in bytes. */
export function getRasterUndoBudget(): number { return overrideBudget ?? tierBudget; }

/** The device tier's default (the renderer, from GpuCaps.undoMemoryBytes). */
export function setRasterUndoTierBudget(bytes: number): void {
  if (Number.isFinite(bytes) && bytes > 0) tierBudget = Math.floor(bytes);
}

/** Host / user override (sm.setUndoMemoryBudget); null / non-positive = back to the tier default. Enforced now. */
export function setRasterUndoBudget(bytes: number | null): void {
  overrideBudget = bytes != null && Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : null;
  enforceRasterUndoBudget(null);
}

function histories(): BudgetedHistory[] {
  const out: BudgetedHistory[] = [];
  for (const r of live) {
    const h = r.deref();
    if (h) out.push(h); else live.delete(r);
  }
  return out;
}

/** Bytes held by every live history, the budget, and the history count. */
export function getRasterUndoMemoryStats(): { bytes: number; budget: number; histories: number; trims: number } {
  const hs = histories();
  let bytes = 0;
  for (const h of hs) bytes += h.heldBytes();
  return { bytes, budget: getRasterUndoBudget(), histories: hs.length, trims: rasterUndoBudgetStats.trims };
}

/**
 * Trim oldest-first until the total fits (see the header for the two passes). `active` = the history just pushed to:
 * it keeps its newest undo step in pass 2. Returns the number of steps dropped.
 */
export function enforceRasterUndoBudget(active: BudgetedHistory | null): number {
  if (enforcing) return 0;
  enforcing = true;
  try {
    const budget = getRasterUndoBudget();
    const hs = histories();
    let total = 0;
    for (const h of hs) total += h.heldBytes();
    if (total <= budget) return 0;
    let dropped = 0;
    for (const minKeep of [1, 0]) {
      while (total > budget) {
        let pick: BudgetedHistory | null = null, best = Infinity;
        for (const h of hs) {
          const keep = minKeep === 0 && h === active ? 1 : minKeep;
          if (h.undoSteps() <= keep || h.trimGain(keep) <= 0) continue;
          const s = h.oldestStepStamp();
          if (s < best) { best = s; pick = h; }
        }
        if (!pick) break;
        const before = pick.heldBytes();
        if (!pick.trimOldestStep()) break;
        total += pick.heldBytes() - before;
        dropped++;
        rasterUndoBudgetStats.trims++;
      }
    }
    return dropped;
  } finally {
    enforcing = false;
  }
}
