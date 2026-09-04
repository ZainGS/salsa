// Span-based (scanline) flood fill over a binary mask — the shared kernel behind the paint-bucket tool
// (flood-fill-engine) and the magic-wand selection (raster-selection-mask). Both had byte-identical copies of
// this loop (audit B4); it lives here once now. Pure (no GPU / DOM) → unit-testable and worker-safe.

/**
 * Flood-fill from (seedX, seedY) across all 4-connected non-zero cells of `mask`.
 * Returns a new w×h Uint8Array with 1 for every reached cell, 0 elsewhere. If the seed cell is 0 (outside the
 * region), the result is all-zero.
 */
export function scanlineFill(
    mask: Uint8Array,
    w: number,
    h: number,
    seedX: number,
    seedY: number,
): Uint8Array {
    const output = new Uint8Array(w * h);
    if (mask[seedY * w + seedX] === 0) return output;

    const stack: Array<[number, number]> = [[seedX, seedY]];
    const visited = new Uint8Array(w * h);

    while (stack.length > 0) {
        const [sx, sy] = stack.pop()!;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;

        const idx = sy * w + sx;
        if (visited[idx] || mask[idx] === 0) continue;

        // Scan left to the start of the contiguous span.
        let left = sx;
        while (left > 0 && mask[sy * w + (left - 1)] !== 0 && !visited[sy * w + (left - 1)]) left--;

        // Scan right, filling the span.
        let right = left;
        while (right < w && mask[sy * w + right] !== 0 && !visited[sy * w + right]) {
            output[sy * w + right] = 1;
            visited[sy * w + right] = 1;
            right++;
        }

        // Seed the rows above and below across the span just filled.
        for (let px = left; px < right; px++) {
            if (sy > 0) {
                const above = (sy - 1) * w + px;
                if (mask[above] !== 0 && !visited[above]) stack.push([px, sy - 1]);
            }
            if (sy < h - 1) {
                const below = (sy + 1) * w + px;
                if (mask[below] !== 0 && !visited[below]) stack.push([px, sy + 1]);
            }
        }
    }

    return output;
}
