// Shared colour coercion for procedural-object managers (building / foliage). A host picker may emit a hex string,
// 0..255, {r,g,b}, or 0..1 — the generators/shaders expect 0..1 linear-ish RGB, so coerce at the API boundary.
// (This is the fix for the "#990000 renders cyan" bug: the raw hex string was reaching the material unparsed.)

/** Coerce any colour format → a [0..1] RGB triple, or null if unparseable. */
export function toRGB(v: unknown): [number, number, number] | null {
    if (typeof v === 'string') {
        const h = v.trim().replace(/^#/, '');
        if (/^[0-9a-fA-F]{6}$/.test(h)) return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
        if (/^[0-9a-fA-F]{3}$/.test(h)) return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255];
        return null;
    }
    let r: number, g: number, b: number;
    if (Array.isArray(v) && v.length >= 3) { r = v[0]; g = v[1]; b = v[2]; }
    else if (v && typeof v === 'object' && 'r' in (v as Record<string, unknown>)) { const o = v as { r: number; g: number; b: number }; r = o.r; g = o.g; b = o.b; }
    else return null;
    if (![r, g, b].every(n => typeof n === 'number' && isFinite(n))) return null;
    if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }
    const c = (n: number): number => Math.max(0, Math.min(1, n));
    return [c(r), c(g), c(b)];
}

/** Return a copy of `partial` with the named colour keys coerced to [0..1] triples (unparseable ones dropped). */
export function coerceColorKeys<T extends object>(partial: T, keys: readonly string[]): T {
    const out = { ...partial } as Record<string, unknown>;
    for (const k of keys) {
        if (k in out && out[k] != null) { const rgb = toRGB(out[k]); if (rgb) out[k] = rgb; else delete out[k]; }
    }
    return out as T;
}
