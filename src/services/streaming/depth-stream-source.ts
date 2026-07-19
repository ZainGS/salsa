// A second StreamSource — on the DEPTH / SCALE axis instead of the positional (XZ) one the city uses. This is the
// spec's Phase 5: proof that the SAME content-agnostic StreamManager drives fundamentally different content with no
// engine change. Where CityStreamSource streams a window of tiles around a world POSITION, this streams a band of
// structural LEVELS around a zoom DEPTH (`focus.scale`): as you zoom "way in", finer levels stream in and coarser
// ones drop. That's the "material micro-structure / product internals / sim detail" use the streaming spec was
// written for — none of it city-specific.
//
// It is deliberately content-AGNOSTIC: it knows nothing about what a "level" contains. A caller supplies
// `levelForScale` (which structural level a given zoom depth maps to) and `buildLevel` / `disposeLevel` (make/free
// that level's geometry). A material viewer, a packaging-board fibre zoom, or a sim's detail hierarchy each plug in
// the same way the city plugs into CityStreamSource.
//
// See docs/specs/spatial-streaming.md.

import type { Focus, StreamBudget, StreamKey, StreamSource } from './stream-manager';

/** A depth chunk key is "L<level>" (e.g. "L0" coarse, "L3" fine). */
export function levelKey(level: number): StreamKey { return `L${level}`; }
export function parseLevel(key: StreamKey): number { return Number(key.slice(1)); }

export interface DepthStreamConfig<H = unknown> {
    /** Which structural level a zoom depth falls on. Higher `scale` = deeper / finer. Often an octave map
     *  (see `octaveLevel`), but any monotonic mapping works. */
    levelForScale(scale: number): number;
    /** Build one structural level's geometry (runs inside the time-sliced pump — keep a single call short). */
    buildLevel(level: number): H;
    /** Free one structural level. */
    disposeLevel(level: number, handle: H): void;
    /** How many levels each side of the current one stay resident (a cross-fade / prefetch band). Default 1. */
    band?: number;
    /** Level clamp — no structural detail exists outside [minLevel, maxLevel]. Default [0, ∞). */
    minLevel?: number;
    maxLevel?: number;
    onSlice?(): void;
    onSettled?(): void;
    sliceMs?: number;
}

/** A convenience `levelForScale`: geometric/octave zoom — every `factor`× of zoom depth past `base` is one level
 *  deeper. `octaveLevel(1, 2)` ⇒ scale 1→L0, 2→L1, 4→L2, 8→L3… (the natural mapping for a scale hierarchy). */
export function octaveLevel(base: number, factor: number): (scale: number) => number {
    const lf = Math.log(factor);
    return (scale: number) => (scale <= 0 || base <= 0 || lf === 0 ? 0 : Math.log(scale / base) / lf);
}

export class DepthStreamSource<H = unknown> implements StreamSource<H> {
    private readonly band: number;
    private readonly minLevel: number;
    private readonly maxLevel: number;
    readonly sliceMs: number;
    constructor(private readonly cfg: DepthStreamConfig<H>) {
        this.band = Math.max(0, cfg.band ?? 1);
        this.minLevel = cfg.minLevel ?? 0;
        this.maxLevel = cfg.maxLevel ?? Infinity;
        this.sliceMs = cfg.sliceMs ?? 10;
    }

    /** The band of structural levels around the focus depth, current level first (so it builds before the fade
     *  neighbours). `budget` is unused — the depth axis is gated by `focus.scale`, not by load radii. */
    targetChunks(focus: Focus, _budget: StreamBudget): StreamKey[] {
        const centre = Math.min(this.maxLevel, Math.max(this.minLevel, Math.round(this.cfg.levelForScale(focus.scale))));
        const levels: number[] = [];
        for (let d = -this.band; d <= this.band; d++) {
            const L = centre + d;
            if (L >= this.minLevel && L <= this.maxLevel) levels.push(L);
        }
        levels.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));   // current level first, then the fade band
        return levels.map(levelKey);
    }

    build(key: StreamKey): H { return this.cfg.buildLevel(parseLevel(key)); }
    dispose(key: StreamKey, handle: H): void { this.cfg.disposeLevel(parseLevel(key), handle); }
    onProgress(): void { this.cfg.onSlice?.(); }
    onDrained(): void { this.cfg.onSettled?.(); }
}
