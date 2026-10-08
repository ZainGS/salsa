/**
 * JSON PARTS — the heavy typed-array sections of a document save, serialized once and reused (perf audit C4).
 *
 * A document gather turns every mesh into JSON twice (scene3d.json, rounded to 6 decimals, and scene.json, unrounded),
 * and almost all of that cost is the geometry: `Array.from(vertices)` and a replacer call per number, for every mesh,
 * on every autosave — although usually one mesh (or none) changed. Everything else a mesh writes (transform, material,
 * name, keyframes, edit topology …) is small, and none of it has a version the save could trust (they are plain
 * mutable fields), so it is simply re-serialized each time.
 *
 * How the heavy parts are reused WITHOUT changing a byte of the output:
 *   1. The gather runs the normal toJSON code inside `collector.collect(...)`. There, `jsonNumberArray(arr)` /
 *      `jsonBase64(...)` return a unique PLACEHOLDER string instead of the array / base64 text (outside a collection
 *      they return exactly what they always did, so every other toJSON caller is untouched).
 *   2. The caller stringifies the result as before; each placeholder lands in the text as `"<placeholder>"`.
 *   3. `collector.resolve(text)` replaces every `"<placeholder>"` with the part's JSON — `JSON.stringify(Array.from(arr),
 *      replacer)` exactly as the nested stringify would have written it (no indentation, same replacer, same numbers) —
 *      taken from the cache when the array's CONTENT is unchanged.
 *
 * The cache key is the array's identity plus a 64-bit CONTENT hash of its bytes, not a version counter: geometry is
 * also written in place (blend shapes, layering, edit-mesh patches) and a counter that one writer forgets to bump
 * would save stale geometry. Hashing is ~100x cheaper than the serialization it replaces. Parts that were placed but
 * then dropped (the stripped skinned geometry in scene.json, the GLB-referenced geometry of perf audit C5) are never
 * hashed or built at all — resolution is lazy.
 */

/** The document save's number rounding: 6 decimals; |v| ≥ 1e9 (timestamps …) untouched so `v * 1e6` can't pass 2^53.
 *  The ONE definition: the scene3d gather and the cached array parts must round identically. */
export const round6Replacer = (_k: string, v: unknown): unknown =>
    (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9) ? Math.round(v * 1e6) / 1e6 : v;

/** Which replacer a collection's parts are written with: 'r6' = round6Replacer (scene3d.json), 'raw' = none. */
export type JsonPartMode = 'r6' | 'raw';

type Bytes = ArrayBufferView | ArrayBuffer;

/**
 * A content hash of the bytes of a typed array / buffer: four independent 32-bit multiplicative lanes over the 32-bit
 * words (word i feeds lane i mod 4 — independent chains, so it runs near memory speed) plus the byte length. Each step
 * `h = xorshift((h ^ word) * oddPrime)` is a bijection of both h and the word, so ANY single changed word always changes
 * the hash, and the xorshift carries high-bit changes (sign flips) down into the low bits so that edits don't cancel
 * out the way they can in a plain multiplicative hash. Not a cryptographic hash: it only has to notice edits.
 */
export function contentHash(src: Bytes): string {
    const buf = src instanceof ArrayBuffer ? src : src.buffer;
    const off = src instanceof ArrayBuffer ? 0 : src.byteOffset;
    const len = src.byteLength;
    let a = 0x811c9dc5 ^ len, b = 0x2545f491, c = 0x9e3779b9, d = 0x85ebca6b;
    const n4 = (off & 3) === 0 ? len >>> 2 : 0;
    let i = 0;
    if (n4 > 0) {
        const u = new Uint32Array(buf, off, n4);
        for (; i + 4 <= n4; i += 4) {
            a = Math.imul(a ^ u[i], 0x01000193); a ^= a >>> 15;
            b = Math.imul(b ^ u[i + 1], 0x5bd1e995); b ^= b >>> 13;
            c = Math.imul(c ^ u[i + 2], 0x27d4eb2f); c ^= c >>> 16;
            d = Math.imul(d ^ u[i + 3], 0x165667b1); d ^= d >>> 14;
        }
        for (; i < n4; i++) { a = Math.imul(a ^ u[i], 0x01000193); a ^= a >>> 15; }
    }
    const tail = new Uint8Array(buf, off + n4 * 4, len - n4 * 4);
    for (let k = 0; k < tail.length; k++) { b = Math.imul(b ^ tail[k], 0x5bd1e995); b ^= b >>> 13; }
    const h = (x: number): string => (x >>> 0).toString(36);
    return `${h(a)}.${h(b)}.${h(c)}.${h(d)}.${len}`;
}

/** Counters (tests / `sm.getAutoSaveStats()`-style diagnostics). */
export interface JsonPartStats {
    /** Parts serialized now (new or changed content, or a collection that may not reuse). */
    built: number;
    /** Parts served from the cache (content unchanged since they were last serialized). */
    reused: number;
}

/** The serialized parts, by source array (WeakMap: a replaced geometry's strings go with it). */
export class JsonPartCache {
    private readonly _arrays = new WeakMap<object, { h: string; r6?: string; raw?: string }>();
    private readonly _strings = new WeakMap<object, { h: string; json: string }>();
    readonly stats: JsonPartStats = { built: 0, reused: 0 };

    /** `JSON.stringify(Array.from(arr), replacer)` — cached while `arr` holds the same bytes. */
    arrayJSON(arr: ArrayBufferView & ArrayLike<number>, mode: JsonPartMode, hash: string, reuse: boolean): string {
        let e = this._arrays.get(arr);
        if (e && e.h !== hash) e = undefined;
        const hit = reuse ? e?.[mode] : undefined;
        if (hit !== undefined) { this.stats.reused++; return hit; }
        const s = JSON.stringify(Array.from(arr), mode === 'r6' ? round6Replacer : undefined);
        this.stats.built++;
        if (!e) { e = { h: hash }; this._arrays.set(arr, e); }
        e[mode] = s;
        return s;
    }

    /** `JSON.stringify(encode())` (a base64 string: no replacer touches it) — cached while `key` holds the same bytes. */
    stringJSON(key: Bytes, encode: () => string, hash: string, reuse: boolean): string {
        const e = this._strings.get(key);
        if (reuse && e && e.h === hash) { this.stats.reused++; return e.json; }
        const json = JSON.stringify(encode());
        this.stats.built++;
        this._strings.set(key, { h: hash, json });
        return json;
    }
}

/** A placeholder ended up inside a nested STRING (some toJSON stringified a mesh's JSON itself): it cannot be
 *  substituted safely. The caller re-serializes without parts. */
export class JsonPartPlaceholderError extends Error {}

let _active: JsonPartCollector | null = null;
let _seq = 0;

/**
 * One serialization pass (one output document). Collect → stringify → resolve, then discard. The cache outlives it.
 * `reuse` false (exports, explicit saves) builds every part fresh — and refreshes the cache with it.
 */
export class JsonPartCollector {
    private readonly _tag: string;
    private readonly _makers: Array<() => string> = [];
    private readonly _values: Array<string | undefined> = [];
    private readonly _hashes = new WeakMap<object, string>();

    constructor(private readonly _cache: JsonPartCache, readonly mode: JsonPartMode, private readonly _reuse = true) {
        this._tag = `@@salsa-json-part:${(++_seq).toString(36)}${Math.random().toString(36).slice(2, 10)}:`;
    }

    /** Run `fn` with this collector active: the parts helpers below emit placeholders while it runs. */
    collect<T>(fn: () => T): T {
        const prev = _active;
        _active = this;
        try { return fn(); } finally { _active = prev; }
    }

    /** The content hash of `src`, computed once per collection. */
    hash(src: Bytes): string {
        let h = this._hashes.get(src);
        if (h === undefined) { h = contentHash(src); this._hashes.set(src, h); }
        return h;
    }

    /** @internal */
    arrayPart(arr: ArrayBufferView & ArrayLike<number>): string {
        return this._add(() => this._cache.arrayJSON(arr, this.mode, this.hash(arr), this._reuse));
    }

    /** @internal */
    stringPart(key: Bytes, encode: () => string): string {
        return this._add(() => this._cache.stringJSON(key, encode, this.hash(key), this._reuse));
    }

    private _add(make: () => string): string {
        this._makers.push(make);
        return `${this._tag}${this._makers.length - 1}@@`;
    }

    private _value(i: number): string {
        let v = this._values[i];
        if (v === undefined) { v = this._makers[i](); this._values[i] = v; }
        return v;
    }

    /** Replace every `"<placeholder>"` in `text` with its part's JSON. Throws JsonPartPlaceholderError when a
     *  placeholder is not a whole JSON string value. */
    resolve(text: string): string {
        if (this._makers.length === 0) return text;
        const open = `"${this._tag}`;
        const chunks: string[] = [];
        let pos = 0;
        for (;;) {
            const i = text.indexOf(open, pos);
            if (i < 0) break;
            // A JSON value (no indentation) starts after ':', ',' or '[' — anything else (a backslash) is a nested string.
            const before = i > 0 ? text[i - 1] : '';
            if (before !== ':' && before !== ',' && before !== '[' && before !== '') throw new JsonPartPlaceholderError('json part inside a string');
            let k = i + open.length;
            const d0 = k;
            while (k < text.length && text.charCodeAt(k) >= 48 && text.charCodeAt(k) <= 57) k++;
            if (k === d0 || !text.startsWith('@@"', k)) throw new JsonPartPlaceholderError('malformed json part');
            const idx = Number(text.slice(d0, k));
            if (!(idx < this._makers.length)) throw new JsonPartPlaceholderError('unknown json part');
            chunks.push(text.slice(pos, i), this._value(idx));
            pos = k + 3;
        }
        if (pos === 0) return text;
        chunks.push(text.slice(pos));
        return chunks.join('');
    }
}

/** `Array.from(arr)` — or, inside a collection, a placeholder for its JSON (typed as the array it stands for; only
 *  JSON.stringify ever sees it). Plain arrays are never deferred. */
export function jsonNumberArray(arr: ArrayLike<number>): number[] {
    const c = _active;
    if (!c || !ArrayBuffer.isView(arr) || arr instanceof DataView) return Array.from(arr);
    return c.arrayPart(arr as ArrayBufferView & ArrayLike<number>) as unknown as number[];
}

/** `encode()` (the base64 text of `key`'s bytes) — or, inside a collection, a placeholder for its JSON. */
export function jsonBase64(key: Bytes, encode: () => string): string {
    const c = _active;
    return c ? c.stringPart(key, encode) : encode();
}

/** contentHash, memoised for the active collection (a save that hashes an array for a decision and then writes it
 *  hashes it once). */
export function saveContentHash(src: Bytes): string {
    return _active ? _active.hash(src) : contentHash(src);
}

/**
 * Serialize with parts: `build` runs inside the collection, `stringify` turns its result into text, and the
 * placeholders are resolved. A null collector — or a placeholder that cannot be substituted — serializes the plain way
 * (`build` again, outside any collection): the result is the same text either way.
 */
export function serializeWithParts<T>(collector: JsonPartCollector | null | undefined, build: () => T, stringify: (v: T) => string): string {
    if (!collector) return stringify(build());
    const v = collector.collect(build);
    try {
        return collector.resolve(stringify(v));
    } catch (e) {
        if (!(e instanceof JsonPartPlaceholderError)) throw e;
        console.warn('[Salsa][save] cached JSON parts could not be substituted — serializing this file the plain way', e.message);
        return stringify(build());
    }
}
