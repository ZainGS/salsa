/**
 * Packed instance lists (engine-roadmap step 3b; performance-plan.md §P13 "Step 3b").
 *
 * A streamed tile comes back from the world worker as ~1,000 layers with ~8,000 instance OBJECTS ({ x, y, z, ry, s,
 * tint, sv, cs, pi }). Structured clone rebuilds every one of them on the main thread when the message is received —
 * the 10-20 ms "worker message" task of a tile landing, which no time slicing can split. The worker instead packs each
 * layer's list into one Float64Array (+ a presence mask), transferred like the geometry; the main thread unpacks a
 * layer's list when its reassembly slice reaches it (WorldManager._reassembleSlice), a few hundred objects at a time.
 *
 * Exact: Float64 holds every JS number (NaN, -0, integers) as is; a key absent on an instance stays absent; a numeric
 * array field keeps its length. A list with any other kind of value (a string GARP skin, a boolean) is not packed.
 */

/** One layer's packed list: `n` instances, field `keys[k]` of width `widths[k]` (1 = a number, w = a number[w]). */
export interface PackedInstances {
    n: number;
    keys: string[];
    widths: number[];
    /** n × (Σ widths) numbers, instance-major. */
    data: Float64Array;
    /** n × keys.length: 1 = the instance has the field. */
    has: Uint8Array;
}

type Inst = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WithInstances = { instances?: any[]; instPacked?: PackedInstances };

/** Pack `instances` (null when a value is not a number / an array of numbers of one length per key). */
export function packInstances(list: readonly object[]): PackedInstances | null {
    const keys: string[] = [], widths: number[] = [], idx = new Map<string, number>();
    for (const t of list) {
        for (const k in t) {
            const v = (t as Inst)[k];
            if (v === undefined) continue;
            const w = typeof v === 'number' ? 1 : Array.isArray(v) && v.every(e => typeof e === 'number') ? v.length : -1;
            if (w < 0 || (Array.isArray(v) && w === 0)) return null;
            const i = idx.get(k);
            if (i === undefined) { idx.set(k, keys.length); keys.push(k); widths.push(typeof v === 'number' ? 1 : -w); }
            else if (widths[i] !== (typeof v === 'number' ? 1 : -w)) return null;   // a number here, an array there / another length
        }
    }
    // widths: 1 = number, -w = array of w (kept distinct from a 1-long array)
    const stride = widths.reduce((s, w) => s + Math.abs(w), 0), n = list.length, nk = keys.length;
    const data = new Float64Array(n * stride), has = new Uint8Array(n * nk);
    for (let j = 0; j < n; j++) {
        const t = list[j];
        let o = j * stride;
        for (let k = 0; k < nk; k++) {
            const w = widths[k], v = (t as Inst)[keys[k]];
            if (v !== undefined) {
                has[j * nk + k] = 1;
                if (w === 1) data[o] = v as number;
                else { const a = v as number[]; for (let e = 0; e < -w; e++) data[o + e] = a[e]; }
            }
            o += Math.abs(w);
        }
    }
    return { n, keys, widths, data, has };
}

/** The instance objects back (same keys present, same values; key order = first-seen order). */
export function unpackInstances(p: PackedInstances, from = 0, to = p.n): Inst[] {
    const { keys, widths, data, has } = p, nk = keys.length;
    const stride = widths.reduce((s, w) => s + Math.abs(w), 0);
    const out: Inst[] = new Array(Math.max(0, to - from));
    for (let j = from; j < to; j++) {
        const t: Inst = {};
        let o = j * stride;
        for (let k = 0; k < nk; k++) {
            const w = widths[k];
            if (has[j * nk + k]) t[keys[k]] = w === 1 ? data[o] : Array.from(data.subarray(o, o - w));
            o += Math.abs(w);
        }
        out[j - from] = t;
    }
    return out;
}

/** A packed sub-range [from, to) (copies: each slice owns its buffers). */
export function slicePacked(p: PackedInstances, from: number, to: number): PackedInstances {
    const nk = p.keys.length, stride = p.widths.reduce((s, w) => s + Math.abs(w), 0);
    const a = Math.max(0, from), b = Math.min(p.n, to);
    return { n: Math.max(0, b - a), keys: p.keys, widths: p.widths, data: p.data.slice(a * stride, b * stride), has: p.has.slice(a * nk, b * nk) };
}

/** Pack a layer's `instances` in place (instances → instPacked). The list array itself is not touched (it may be
 *  shared). Returns the buffers to transfer, or null when the list was not packable / empty. */
export function packLayerInstances(L: WithInstances): ArrayBuffer[] | null {
    const list = L.instances;
    if (!list || !list.length) return null;
    const p = packInstances(list);
    if (!p) return null;
    L.instPacked = p;
    delete L.instances;
    return [p.data.buffer as ArrayBuffer, p.has.buffer as ArrayBuffer];
}

/** Unpack a layer packed by packLayerInstances (no-op otherwise). */
export function unpackLayerInstances(L: WithInstances): void {
    const p = L.instPacked;
    if (!p) return;
    L.instances = unpackInstances(p);
    delete L.instPacked;
}

/** Instances of a layer, packed or not. */
export function layerInstanceCount(L: WithInstances): number {
    return L.instances ? L.instances.length : L.instPacked ? L.instPacked.n : 0;
}
