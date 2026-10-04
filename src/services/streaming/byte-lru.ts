// A small LRU bounded by BYTES and by COUNT (performance-plan P10.D3). The streamed-tile caches (retired full / lite
// tiles, retired flat / massing tiles) use it so infinite exploration keeps the CPU side flat: every retire is the
// most-recent entry, and the oldest entries are evicted once either cap is exceeded. A `take` removes the entry (the
// value goes back to the scene; it re-enters as the newest when it is retired again).

export class ByteLru<V> {
    private readonly _m = new Map<string, { v: V; bytes: number }>();
    private _bytes = 0;
    /** Evictions so far (diagnostics). */
    evicted = 0;

    constructor(public maxBytes: number, public maxCount = Infinity, private readonly onEvict?: (key: string, v: V) => void) {}

    get size(): number { return this._m.size; }
    get bytes(): number { return this._bytes; }
    has(key: string): boolean { return this._m.has(key); }

    /** Insert (or replace) `key` as the most-recent entry, then evict the oldest past the caps. An entry bigger than
     *  `maxBytes` on its own is not kept. */
    put(key: string, v: V, bytes: number): void {
        const prev = this._m.get(key);
        if (prev) { this._bytes -= prev.bytes; this._m.delete(key); }
        this._m.set(key, { v, bytes });
        this._bytes += bytes;
        this._trim();
    }

    /** Remove and return `key` (a cache hit), or null. */
    take(key: string): V | null {
        const e = this._m.get(key);
        if (!e) return null;
        this._m.delete(key);
        this._bytes -= e.bytes;
        return e.v;
    }

    clear(): void { this._m.clear(); this._bytes = 0; }

    /** Change the caps (evicts at once when they shrink). */
    setCaps(maxBytes: number, maxCount = this.maxCount): void { this.maxBytes = maxBytes; this.maxCount = maxCount; this._trim(); }

    keys(): string[] { return [...this._m.keys()]; }

    private _trim(): void {
        for (const [k, e] of this._m) {   // Map iteration = insertion order = oldest first
            if (this._bytes <= this.maxBytes && this._m.size <= this.maxCount) break;
            this._m.delete(k);
            this._bytes -= e.bytes;
            this.evicted++;
            this.onEvict?.(k, e.v);
        }
    }
}
