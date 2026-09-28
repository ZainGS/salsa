/**
 * Smoothed normals for the inverted-hull OUTLINE shell.
 *
 * The per-object outline expands each vertex along its normal to form a slightly larger shell. On HARD-EDGED
 * geometry (a cube, a building) the vertices are SPLIT — each face's copy of a shared corner carries only that
 * face's normal — so the two faces push the shared position in different directions and the shell TEARS at the
 * edges (visible gaps in the outline). Averaging the normals of every vertex that sits at the SAME position gives
 * a single continuous "smooth" normal there, so the shell stays welded and the outline is gap-free. Smooth meshes
 * (characters) already share averaged normals, so this is a near-no-op for them.
 *
 * Pure + allocation-returning so it's unit-testable without a GPU. Layout defaults to the mesh3d vertex
 * (12 floats/vertex: position @0..2, normal @3..5, uv @6..7, tangent @8..11); only the normal is rewritten.
 */

/** Quantize a coordinate so positions that are equal up to floating-point noise share a bucket. */
function q(v: number): number { return Math.round(v * 1e4) / 1e4; }

/**
 * Return a COPY of `vertices` with normals replaced by position-averaged (smoothed) normals. Positions, UVs and
 * tangents are untouched. `floatsPerVert`/`posOffset`/`normOffset` describe the vertex layout.
 */
export function smoothNormalsForOutline(
  vertices: Float32Array,
  floatsPerVert = 12,
  posOffset = 0,
  normOffset = 3,
): Float32Array {
  const out = new Float32Array(vertices);           // copy — positions/uv/tangent preserved
  const count = Math.floor(vertices.length / floatsPerVert);
  if (count === 0) return out;

  const key = (i: number): string => {
    const p = i * floatsPerVert + posOffset;
    return `${q(vertices[p])},${q(vertices[p + 1])},${q(vertices[p + 2])}`;
  };

  // Pass 1: accumulate each shared position's summed normal.
  const acc = new Map<string, [number, number, number]>();
  for (let i = 0; i < count; i++) {
    const n = i * floatsPerVert + normOffset;
    const k = key(i);
    let a = acc.get(k);
    if (!a) { a = [0, 0, 0]; acc.set(k, a); }
    a[0] += vertices[n]; a[1] += vertices[n + 1]; a[2] += vertices[n + 2];
  }

  // Pass 2: write back the normalized average (keep the original if it sums to ~0, e.g. opposing normals).
  for (let i = 0; i < count; i++) {
    const a = acc.get(key(i))!;
    const len = Math.hypot(a[0], a[1], a[2]);
    if (len > 1e-8) {
      const n = i * floatsPerVert + normOffset;
      out[n] = a[0] / len; out[n + 1] = a[1] / len; out[n + 2] = a[2] / len;
    }
  }
  return out;
}
