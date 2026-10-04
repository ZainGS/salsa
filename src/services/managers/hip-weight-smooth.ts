/**
 * hip-weight-smooth.ts — smooth the PELVIS → THIGH skin weights of a procedural body (clothing fit round 2, 2026-10-04).
 *
 * The body generator weights the pelvis rings and the shared crotch verts 100 % to `hips`, and the first thigh ring
 * jumps straight to 55 % thigh. Raise a thigh (run, sit, squat, kick) and that one ring of triangles takes the whole
 * rotation: measured on a new body, 37 / 49 / 51 of the ~500 hip-region triangles stretch past 2× (run / sit / squat)
 * and 14–32 fold inside out, while the knees and elbows have none. seamBlendWeights doesn't reach it (those verts
 * share the hips bone, so they aren't a "seam"). Every garment copies the body's weights, so the trouser / shorts
 * front hip crease tore with it.
 *
 * Fix: a few Jacobi (Laplacian) passes over the weight field inside a hip ZONE — verts whose weights mix hips with a
 * thigh, plus the lowest pelvis rings and the crotch bridge — with everything outside the zone held fixed. The
 * rotation then spreads over several rings instead of one. Joints, positions and the rest pose are untouched.
 */

export interface HipZoneInput {
    vcount: number;
    indices: ArrayLike<number>;
    /** Packed 4-influence weights (as seamBlendWeights returns). */
    jointIndices: Uint8Array;
    jointWeights: Float32Array;
    positions: ArrayLike<number>;   // stride `stride`, position at 0..2
    stride: number;
    jointCount: number;
    hips: number; thighL: number; thighR: number;
    /** World Y of the hip sockets (upperleg joints) and of the knees. */
    sockY: number; kneeY: number;
    /** World Y of the hips joint. */
    hipsY: number;
    /** Verts held fixed (a boundary for the smoothing, e.g. a garment's per-leg crotch fabric). */
    fixed?: { has(i: number): boolean };
    /** Per vertex, a joint it may never take (a garment's per-leg crotch fabric must not pick up the OTHER thigh, or the
     *  two legs' sheets fuse into the webbing). */
    forbid?: Map<number, number>;
}

export function smoothHipWeights(inp: HipZoneInput, iters = 6, lambda = 0.5): { jointIndices: Uint8Array; jointWeights: Float32Array } {
    const { vcount: n, jointCount: J, positions: P, stride: st } = inp;
    const W = new Float32Array(n * J);
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) W[i * J + inp.jointIndices[i * 4 + k]] += inp.jointWeights[i * 4 + k];
    // Zone: between a little above the hips joint and 35 % down the thigh, and bound only to hips / thighs.
    const yTop = inp.hipsY + 0.25 * (inp.hipsY - inp.sockY), yBot = inp.sockY - 0.35 * (inp.sockY - inp.kneeY);
    const allowed = new Set([inp.hips, inp.thighL, inp.thighR]);
    const zone = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const y = P[i * st + 1];
        if (y > yTop || y < yBot) continue;
        let ok = true, sum = 0;
        for (let j = 0; j < J; j++) { const w = W[i * J + j]; if (w > 1e-4 && !allowed.has(j)) { ok = false; break; } sum += w; }
        if (ok && sum > 0 && !inp.fixed?.has(i)) zone[i] = 1;
    }
    const nb: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    for (let t = 0; t + 2 < inp.indices.length; t += 3) {
        const a = inp.indices[t], b = inp.indices[t + 1], c = inp.indices[t + 2];
        if (zone[a] || zone[b] || zone[c]) { nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b); }
    }
    const cur = W, nxt = new Float32Array(W);
    for (let it = 0; it < iters; it++) {
        for (let i = 0; i < n; i++) {
            if (!zone[i] || !nb[i].size) continue;
            const m = nb[i].size;
            for (const j of allowed) {
                let s = 0; for (const q of nb[i]) s += cur[q * J + j];
                nxt[i * J + j] = (1 - lambda) * cur[i * J + j] + lambda * (s / m);
            }
            const fb = inp.forbid?.get(i);
            if (fb !== undefined) nxt[i * J + fb] = 0;
        }
        cur.set(nxt);
    }
    const jointIndices = new Uint8Array(inp.jointIndices), jointWeights = new Float32Array(inp.jointWeights);
    const order: number[] = [];
    for (let i = 0; i < n; i++) {
        if (!zone[i]) continue;
        order.length = 0;
        for (let j = 0; j < J; j++) if (cur[i * J + j] > 1e-5) order.push(j);
        order.sort((x, y) => (cur[i * J + y] - cur[i * J + x]) || (x - y));
        const top = order.slice(0, 4);
        let sum = 0; for (const j of top) sum += cur[i * J + j];
        if (sum <= 0) continue;
        for (let k = 0; k < 4; k++) { jointIndices[i * 4 + k] = top[k] ?? 0; jointWeights[i * 4 + k] = top[k] !== undefined ? cur[i * J + top[k]] / sum : 0; }
    }
    return { jointIndices, jointWeights };
}
