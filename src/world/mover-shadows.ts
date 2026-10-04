// ── World generation — MOVING CONTACT BLOBS (visual-polish #16) ─────────────────────────────────────────────────
// The static crowd, parked cars and street props stand on soft radial-fade blobs (contact-shadows.ts, persona-polish
// A3). The things that MOVE (routed walkers, traffic cars, the train consists, the Play player) had none, so at night,
// under cloud and wherever the sun shadow is small they looked pasted on. This is the pure half: a footprint per mover
// (from its rigid meshes' local geometry) and ONE quad buffer for all of them, rewritten in place as they move. The
// services half (services/managers/world-mover-shadows.ts) owns the mesh and re-sends only the quads that changed
// (Renderer3D.patchMeshVertices) — one transparent draw for every mover, no pool rebuild.
//
// Vertex layout = contactShadowLayer's (12 floats: position, up normal, the unit radial UV, a tangent), so the same
// `radialFade` material fades each quad to nothing at its rim. Two extra vertices that no triangle uses pin the mesh's
// bounds to the whole city (the renderer's cached AABB never needs refreshing); a hidden blob is collapsed to a point.

const FPV = 12;

/** A mover's ground footprint in its OWN frame (vehicles are built along +X): centre offset and half-extents. */
export interface MoverFootprint {
    /** Centre offset in the mover's local XZ (before its yaw). */
    cx: number; cz: number;
    /** Half-extent along local X (the heading) and local Z (across). */
    a: number; b: number;
    /** Height of the lowest vertex above the mover origin (the blob sits there). */
    y0: number;
}

/** Layer / mesh names of a mover that never ground it (the chat emote, the headlight pool, glows, weather). */
export const MOVER_BLOB_SKIP = /emote|headlight-pool|glow|rain|snow|petal|visor/;

/** The footprint of a set of vertex arrays that share the mover's local frame (each with its own uniform `scale`).
 *  Only the LOWER part counts (vertices below `lowFrac` of the height): an umbrella or a pantograph must not widen
 *  the blob. Null when there are no vertices. Pure. */
export function moverFootprint(parts: { vertices: ArrayLike<number>; stride?: number; scale?: number }[], lowFrac = 0.55): MoverFootprint | null {
    let minY = Infinity, maxY = -Infinity;
    for (const p of parts) {
        const st = p.stride ?? FPV, s = p.scale ?? 1, v = p.vertices;
        for (let i = 0; i + 2 < v.length; i += st) { const y = v[i + 1] * s; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (!(minY < Infinity)) return null;
    const cut = minY + Math.max(1e-6, (maxY - minY) * lowFrac);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of parts) {
        const st = p.stride ?? FPV, s = p.scale ?? 1, v = p.vertices;
        for (let i = 0; i + 2 < v.length; i += st) {
            if (v[i + 1] * s > cut) continue;
            const x = v[i] * s, z = v[i + 2] * s;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
    }
    if (!(x0 < Infinity)) return null;
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, a: (x1 - x0) / 2, b: (z1 - z0) / 2, y0: minY };
}

/** Blob sizing (world units), mirroring contact-shadows.ts cityContactShadowOptions so a parked car and a moving one
 *  get the same blob. */
export interface MoverBlobSize { spread: number; minBlob: number; maxHalf: number; lift: number }

/** The blob's half-extents for a footprint: a round-ish minimum (a thin walker still gets a soft disc, a car an
 *  elongated oval), spread a little past the object, clamped. Pure. */
export function blobHalfExtents(f: MoverFootprint, o: MoverBlobSize): [number, number] {
    const a = Math.max(o.minBlob, Math.min(o.maxHalf, Math.max(f.a, f.b * 0.6)) * o.spread);
    const b = Math.max(o.minBlob, Math.min(o.maxHalf, Math.max(f.b, f.a * 0.45)) * o.spread);
    return [a, b];
}

/**
 * ONE vertex / index buffer of `capacity` blob quads (+ 2 bounds anchors). `set` writes quad i at a pose; `hide`
 * collapses it. Both report whether anything changed, and the dirty vertex range accumulates until `takeDirty`.
 */
export class MoverBlobBuffer {
    readonly capacity: number;
    readonly vertices: Float32Array;
    readonly indices: Uint32Array;
    private _lo = Infinity;
    private _hi = -Infinity;
    /** Per quad: the last pose written (x, y, z, yaw, a, b; NaN = hidden). */
    private readonly _last: Float64Array;

    /** `bounds` = [minX, minY, minZ, maxX, maxY, maxZ] the anchors pin (the region every blob stays inside). */
    constructor(capacity: number, bounds: readonly number[]) {
        this.capacity = Math.max(0, capacity | 0);
        const nv = this.capacity * 4 + 2;
        this.vertices = new Float32Array(nv * FPV);
        this.indices = new Uint32Array(this.capacity * 6);
        this._last = new Float64Array(this.capacity * 6).fill(NaN);
        const v = this.vertices;
        for (let i = 0; i < nv; i++) {
            const o = i * FPV;
            v[o + 4] = 1;                                         // up normal
            v[o + 8] = 1; v[o + 11] = 1;                          // tangent (1, 0, 0, 1)
        }
        // corner UVs (0,0) (1,0) (1,1) (0,1) + every quad starts collapsed at the min anchor
        const UV = [0, 0, 1, 0, 1, 1, 0, 1];
        for (let q = 0; q < this.capacity; q++) {
            for (let k = 0; k < 4; k++) {
                const o = (q * 4 + k) * FPV;
                v[o] = bounds[0]; v[o + 1] = bounds[1]; v[o + 2] = bounds[2];
                v[o + 6] = UV[k * 2]; v[o + 7] = UV[k * 2 + 1];
            }
            const b0 = q * 4, ix = this.indices, j = q * 6;
            ix[j] = b0; ix[j + 1] = b0 + 2; ix[j + 2] = b0 + 1; ix[j + 3] = b0; ix[j + 4] = b0 + 3; ix[j + 5] = b0 + 2;
        }
        const a0 = this.capacity * 4 * FPV, a1 = a0 + FPV;
        v[a0] = bounds[0]; v[a0 + 1] = bounds[1]; v[a0 + 2] = bounds[2];
        v[a1] = bounds[3]; v[a1 + 1] = bounds[4]; v[a1 + 2] = bounds[5];
    }

    /** Write quad `i` centred at (x, y, z) with heading `yaw` (the Mesh3D yaw: local X maps to (cos, −sin)), local
     *  centre offset (cx, cz) and half-extents a (along the heading) × b. False when it was already there. */
    set(i: number, x: number, y: number, z: number, yaw: number, a: number, b: number, cx = 0, cz = 0): boolean {
        if (i < 0 || i >= this.capacity) return false;
        const L = this._last, l = i * 6;
        if (L[l] === x && L[l + 1] === y && L[l + 2] === z && L[l + 3] === yaw && L[l + 4] === a && L[l + 5] === b) return false;
        L[l] = x; L[l + 1] = y; L[l + 2] = z; L[l + 3] = yaw; L[l + 4] = a; L[l + 5] = b;
        const c = Math.cos(yaw), s = Math.sin(yaw);
        // Mesh3D rotation about Y by yaw: x' = x cos + z sin, z' = −x sin + z cos.
        const ox = x + cx * c + cz * s, oz = z - cx * s + cz * c;
        const ax = a * c, az = -a * s, bx = b * s, bz = b * c;   // the local X / Z half-axes in the world
        const v = this.vertices, o = i * 4 * FPV;
        v[o] = ox - ax - bx; v[o + 1] = y; v[o + 2] = oz - az - bz;
        v[o + FPV] = ox + ax - bx; v[o + FPV + 1] = y; v[o + FPV + 2] = oz + az - bz;
        v[o + 2 * FPV] = ox + ax + bx; v[o + 2 * FPV + 1] = y; v[o + 2 * FPV + 2] = oz + az + bz;
        v[o + 3 * FPV] = ox - ax + bx; v[o + 3 * FPV + 1] = y; v[o + 3 * FPV + 2] = oz - az + bz;
        this._mark(i);
        return true;
    }

    /** Collapse quad `i` to a point (draws nothing). False when it was hidden already. */
    hide(i: number): boolean {
        if (i < 0 || i >= this.capacity) return false;
        const L = this._last, l = i * 6;
        if (Number.isNaN(L[l])) return false;
        L.fill(NaN, l, l + 6);
        const v = this.vertices, o = i * 4 * FPV;
        for (let k = 1; k < 4; k++) { v[o + k * FPV] = v[o]; v[o + k * FPV + 1] = v[o + 1]; v[o + k * FPV + 2] = v[o + 2]; }
        this._mark(i);
        return true;
    }

    /** Is quad `i` currently shown? */
    shown(i: number): boolean { return i >= 0 && i < this.capacity && !Number.isNaN(this._last[i * 6]); }

    private _mark(i: number): void { if (i < this._lo) this._lo = i; if (i > this._hi) this._hi = i; }

    /** The changed VERTEX range since the last call ([start, count] in vertices), or null; resets it. */
    takeDirty(): [number, number] | null {
        if (this._hi < this._lo) return null;
        const r: [number, number] = [this._lo * 4, (this._hi - this._lo + 1) * 4];
        this._lo = Infinity; this._hi = -Infinity;
        return r;
    }
}
