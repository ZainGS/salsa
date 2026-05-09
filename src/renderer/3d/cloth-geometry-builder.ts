/**
 * ClothGeometryBuilder — CPU-side cloth mesh + constraint graph generator.
 *
 * Takes a ClothGridConfig and produces:
 *  - Interleaved vertex data (pos + normal + uv + tangent, 12 floats/vert)
 *  - Triangle index buffer
 *  - Constraint graph (structural + shear + bend edges, graph-colored for GPU)
 *  - Triangle-area-weighted inverse masses (Matt Fisher §4.1)
 *  - Flat XZ seed positions for the simulator
 *
 * All output is pure data — no GPU objects created here.
 */

import { FLOATS_PER_VERT } from './mesh-generators';
import type { MeshGeometry } from './mesh-generators';
import type { ClothGridConfig } from '../../scene-graph/shapes/cloth-mesh-3d';

// ── Output types ─────────────────────────────────────────────────────────────

export interface ConstraintEdge {
  /** Dense vertex index A. */
  a: number;
  /** Dense vertex index B. */
  b: number;
  /** Rest length (world units). */
  restLength: number;
  type: 'structural' | 'shear' | 'bend' | 'stitch';
  /** Graph-coloring color ID — no two same-color edges share a vertex. */
  color: number;
}

export interface ConstraintGraph {
  /** All edges: structural → shear → bend → stitch, each type sorted by color. */
  edges: ConstraintEdge[];
  /** Total number of distinct colors across all types. */
  colorCount: number;
  /** Index into edges[] where shear constraints start. */
  shearStart: number;
  /** Index into edges[] where bend constraints start. */
  bendStart: number;
  /** Index into edges[] where stitch constraints start. */
  stitchStart: number;
  /**
   * Contiguous ranges within edges[] for each color group, per constraint type.
   * Used by ClothSimulator to dispatch one parallel workgroup per color group.
   * Constraints in the same color group have no shared vertices — safe for
   * simultaneous GPU dispatch without write conflicts.
   */
  structColorRanges: { start: number; end: number }[];
  shearColorRanges:  { start: number; end: number }[];
  bendColorRanges:   { start: number; end: number }[];
  stitchColorRanges: { start: number; end: number }[];
}

export interface ClothGeometryResult {
  geometry: MeshGeometry;
  vertexCount: number;
  constraintGraph: ConstraintGraph;
  /**
   * Triangle-area-weighted inverse masses per vertex (Matt Fisher §4.1).
   * inverseMass[v] = 1 / sum(incident_triangle_area / 3).
   * Pinned vertices receive inverseMass = 0 (infinite mass).
   */
  inverseMass: Float32Array;
  /** Flat XZ positions [x,y,z] per vertex (y=0). Seeds the simulator. */
  flatPositions: Float32Array;
  /**
   * Fine dense vertex index → fine slot index (fc + fr * (cols*N+1)).
   * When subdivisions=1 this equals the coarse slot index.
   */
  slotFromVertex: Uint32Array;
  /**
   * Coarse slot index (col + row * (cols+1)) → fine dense vertex index,
   * -1 if that coarse vertex is inactive (corner cutout / custom hole).
   * Always indexed at the coarse resolution regardless of subdivisions.
   * Used by getClothVertexDenseIndex and getClothVertexSlot.
   */
  vertexFromSlot: Int32Array;
  /**
   * Per-vertex bend stiffness multipliers (0.0 = floppy, 1.0 = stiff).
   * Derived from ClothGridConfig.bendStiffnessMap; defaults to 1.0 for unset vertices.
   * Length = vertexCount. Uploaded to the GPU constrain shader.
   */
  bendStiffness: Float32Array;
  /**
   * Per-vertex grid neighbor dense indices: [left, right, up, down].
   * "up" = smaller fine-row index (smaller Z); "down" = larger fine-row index.
   * -1 means no neighbor in that direction (boundary or cutout).
   * Length = vertexCount × 4. Used by the GPU pose shader to recompute normals.
   */
  neighborBuf: Int32Array;
}

// ── Main builder ─────────────────────────────────────────────────────────────

export function buildClothGeometry(config: ClothGridConfig): ClothGeometryResult {
  const { cols, rows, cellSize, activeCells, pinnedVertices, cornerRadius,
          stitches = [], bendStiffnessMap } = config;

  // Subdivisions: each coarse cell becomes N×N fine cells.
  // The simulation runs on the fine mesh; all external APIs stay at coarse resolution.
  const N          = Math.max(1, Math.min(8, Math.round(config.subdivisions ?? 1)));
  const fineCols   = cols * N;
  const fineRows   = rows * N;
  const fineSize   = cellSize / N;   // world-unit edge length of a fine cell
  const fSC        = fineCols + 1;   // fine slot cols
  const fineTotalSlots = fSC * (fineRows + 1);

  const fineSlotIdx = (fc: number, fr: number) => fc + fr * fSC;
  const fineCellIdx = (fc: number, fr: number) => fc + fr * fineCols;
  const coarseSlotIdx = (c:  number, r:  number) => c  + r  * (cols + 1);
  const coarseCellIdx = (c:  number, r:  number) => c  + r  * cols;

  // ── Step 1: Apply corner radius to coarse cells ───────────────────────────
  // Operates on the coarse grid; fine cells inherit the result below.

  const effectiveCells = activeCells.slice();
  if (cornerRadius > 0) {
    const n = cornerRadius;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!effectiveCells[coarseCellIdx(c, r)]) continue;
        if (c < n && r < n) {
          const dc = c + 0.5 - n, dr = r + 0.5 - n;
          if (dc * dc + dr * dr > n * n) { effectiveCells[coarseCellIdx(c, r)] = false; continue; }
        }
        if (c >= cols - n && r < n) {
          const dc = c + 0.5 - (cols - n), dr = r + 0.5 - n;
          if (dc * dc + dr * dr > n * n) { effectiveCells[coarseCellIdx(c, r)] = false; continue; }
        }
        if (c < n && r >= rows - n) {
          const dc = c + 0.5 - n, dr = r + 0.5 - (rows - n);
          if (dc * dc + dr * dr > n * n) { effectiveCells[coarseCellIdx(c, r)] = false; continue; }
        }
        if (c >= cols - n && r >= rows - n) {
          const dc = c + 0.5 - (cols - n), dr = r + 0.5 - (rows - n);
          if (dc * dc + dr * dr > n * n) { effectiveCells[coarseCellIdx(c, r)] = false; continue; }
        }
      }
    }
  }

  // ── Step 1b: Expand coarse effectiveCells to fine grid ────────────────────

  const fineActiveCells = new Uint8Array(fineCols * fineRows);
  for (let fr = 0; fr < fineRows; fr++) {
    for (let fc = 0; fc < fineCols; fc++) {
      if (effectiveCells[coarseCellIdx(Math.floor(fc / N), Math.floor(fr / N))]) {
        fineActiveCells[fineCellIdx(fc, fr)] = 1;
      }
    }
  }

  // ── Step 2: Determine active fine slots ───────────────────────────────────

  const fineSlotActive = new Uint8Array(fineTotalSlots);
  for (let fr = 0; fr < fineRows; fr++) {
    for (let fc = 0; fc < fineCols; fc++) {
      if (!fineActiveCells[fineCellIdx(fc, fr)]) continue;
      fineSlotActive[fineSlotIdx(fc,     fr    )] = 1;
      fineSlotActive[fineSlotIdx(fc + 1, fr    )] = 1;
      fineSlotActive[fineSlotIdx(fc + 1, fr + 1)] = 1;
      fineSlotActive[fineSlotIdx(fc,     fr + 1)] = 1;
    }
  }

  // ── Step 3: Dense packing ─────────────────────────────────────────────────

  const fineVertexFromSlot = new Int32Array(fineTotalSlots).fill(-1);
  const slotFromVertexArr: number[] = [];  // fine slots
  let vertexCount = 0;
  for (let s = 0; s < fineTotalSlots; s++) {
    if (fineSlotActive[s]) {
      fineVertexFromSlot[s] = vertexCount++;
      slotFromVertexArr.push(s);
    }
  }

  // ── Step 3b: Coarse slot → fine dense (external API compat) ──────────────
  // pinnedVertices and getClothVertexDenseIndex use coarse slot indices.

  const coarseSlotCount = (cols + 1) * (rows + 1);
  const coarseVertexFromSlot = new Int32Array(coarseSlotCount).fill(-1);
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const fineSlot = fineSlotIdx(c * N, r * N);
      if (fineSlot < fineTotalSlots) {
        coarseVertexFromSlot[coarseSlotIdx(c, r)] = fineVertexFromSlot[fineSlot];
      }
    }
  }

  // ── Step 4: Build vertex data (flat cloth on XZ plane, centred at origin) ──

  const offsetX = cols * cellSize * 0.5;
  const offsetZ = rows * cellSize * 0.5;

  const vertices     = new Float32Array(vertexCount * FLOATS_PER_VERT);
  const flatPositions = new Float32Array(vertexCount * 3);

  for (let vi = 0; vi < vertexCount; vi++) {
    const s  = slotFromVertexArr[vi];  // fine slot
    const fc = s % fSC;
    const fr = Math.floor(s / fSC);

    const px = fc * fineSize - offsetX;
    const py = 0;
    const pz = fr * fineSize - offsetZ;
    const u  = fc / fineCols;   // normalised UV — same at coarse vertices as before
    const v  = fr / fineRows;

    const base = vi * FLOATS_PER_VERT;
    vertices[base    ] = px; vertices[base + 1] = py; vertices[base + 2] = pz;
    vertices[base + 3] = 0;  vertices[base + 4] = 1;  vertices[base + 5] = 0;   // normal up
    vertices[base + 6] = u;  vertices[base + 7] = v;
    vertices[base + 8] = 1;  vertices[base + 9] = 0;  vertices[base + 10] = 0;  // tangent X
    vertices[base + 11] = 1;

    flatPositions[vi * 3    ] = px;
    flatPositions[vi * 3 + 1] = py;
    flatPositions[vi * 3 + 2] = pz;
  }

  // ── Step 5: Build index buffer ────────────────────────────────────────────

  const indexArr: number[] = [];
  for (let fr = 0; fr < fineRows; fr++) {
    for (let fc = 0; fc < fineCols; fc++) {
      if (!fineActiveCells[fineCellIdx(fc, fr)]) continue;

      const i00 = fineVertexFromSlot[fineSlotIdx(fc,     fr    )];
      const i10 = fineVertexFromSlot[fineSlotIdx(fc + 1, fr    )];
      const i11 = fineVertexFromSlot[fineSlotIdx(fc + 1, fr + 1)];
      const i01 = fineVertexFromSlot[fineSlotIdx(fc,     fr + 1)];

      // Two CCW triangles (Y-up, XZ plane). Cloth is double-sided so both
      // faces render; this winding matches the UI grid on the front face.
      indexArr.push(i00, i10, i11);
      indexArr.push(i00, i11, i01);
    }
  }
  const indices = new Uint32Array(indexArr);

  // ── Step 6: Triangle-area-weighted inverse masses ─────────────────────────

  const vertexArea = new Float32Array(vertexCount);
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    const ax = flatPositions[i0 * 3], ay = flatPositions[i0 * 3 + 1], az = flatPositions[i0 * 3 + 2];
    const bx = flatPositions[i1 * 3], by = flatPositions[i1 * 3 + 1], bz = flatPositions[i1 * 3 + 2];
    const cx = flatPositions[i2 * 3], cy = flatPositions[i2 * 3 + 1], cz = flatPositions[i2 * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const crossX = e1y * e2z - e1z * e2y;
    const crossY = e1z * e2x - e1x * e2z;
    const crossZ = e1x * e2y - e1y * e2x;
    const area = 0.5 * Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
    vertexArea[i0] += area / 3;
    vertexArea[i1] += area / 3;
    vertexArea[i2] += area / 3;
  }

  // pinnedVertices stores coarse slot indices → resolve to fine dense indices.
  // With N>1, also pin intermediate fine vertices between adjacent pinned coarse
  // slots on the same row/column, so boundary edges don't sag between coarse pins.
  const pinnedSet = new Set<number>();
  const pinnedCoarseSet = new Set<number>(pinnedVertices);
  for (const coarseSlot of pinnedVertices) {
    if (coarseSlot < 0 || coarseSlot >= coarseSlotCount) continue;
    const vi = coarseVertexFromSlot[coarseSlot];
    if (vi >= 0) pinnedSet.add(vi);

    if (N > 1) {
      const cc = coarseSlot % (cols + 1);
      const cr = Math.floor(coarseSlot / (cols + 1));
      // Rightward: fill fine row gap between (cc, cr) and (cc+1, cr)
      if (cc < cols && pinnedCoarseSet.has(coarseSlotIdx(cc + 1, cr))) {
        for (let k = 1; k < N; k++) {
          const fvi = fineVertexFromSlot[fineSlotIdx(cc * N + k, cr * N)];
          if (fvi >= 0) pinnedSet.add(fvi);
        }
      }
      // Downward: fill fine col gap between (cc, cr) and (cc, cr+1)
      if (cr < rows && pinnedCoarseSet.has(coarseSlotIdx(cc, cr + 1))) {
        for (let k = 1; k < N; k++) {
          const fvi = fineVertexFromSlot[fineSlotIdx(cc * N, cr * N + k)];
          if (fvi >= 0) pinnedSet.add(fvi);
        }
      }
    }
  }
  const inverseMass = new Float32Array(vertexCount);
  for (let vi = 0; vi < vertexCount; vi++) {
    inverseMass[vi] = pinnedSet.has(vi) ? 0 : (vertexArea[vi] > 1e-12 ? 1.0 / vertexArea[vi] : 0);
  }

  // ── Step 7: Build constraint graph (on fine mesh) ─────────────────────────

  const addedEdges = new Set<string>();
  const structural: ConstraintEdge[] = [];
  const shear:      ConstraintEdge[] = [];
  const bend:       ConstraintEdge[] = [];

  const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

  const restLen = (a: number, b: number): number => {
    const dx = flatPositions[b * 3    ] - flatPositions[a * 3    ];
    const dy = flatPositions[b * 3 + 1] - flatPositions[a * 3 + 1];
    const dz = flatPositions[b * 3 + 2] - flatPositions[a * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  const tryAdd = (
    bucket: ConstraintEdge[],
    type: ConstraintEdge['type'],
    a: number, b: number,
    set: Set<string>,
  ) => {
    if (a < 0 || b < 0) return;
    const k = edgeKey(a, b);
    if (set.has(k)) return;
    set.add(k);
    bucket.push({ a, b, restLength: restLen(a, b), type, color: 0 });
  };

  for (let fr = 0; fr < fineRows; fr++) {
    for (let fc = 0; fc < fineCols; fc++) {
      if (!fineActiveCells[fineCellIdx(fc, fr)]) continue;

      const i00 = fineVertexFromSlot[fineSlotIdx(fc,     fr    )];
      const i10 = fineVertexFromSlot[fineSlotIdx(fc + 1, fr    )];
      const i11 = fineVertexFromSlot[fineSlotIdx(fc + 1, fr + 1)];
      const i01 = fineVertexFromSlot[fineSlotIdx(fc,     fr + 1)];

      tryAdd(structural, 'structural', i00, i10, addedEdges);
      tryAdd(structural, 'structural', i10, i11, addedEdges);
      tryAdd(structural, 'structural', i11, i01, addedEdges);
      tryAdd(structural, 'structural', i01, i00, addedEdges);

      tryAdd(shear, 'shear', i00, i11, addedEdges);
      tryAdd(shear, 'shear', i10, i01, addedEdges);
    }
  }

  // Bend: two-step edges across the fine slot grid
  const bendAdded = new Set<string>();
  for (let fr = 0; fr <= fineRows; fr++) {
    for (let fc = 0; fc <= fineCols; fc++) {
      const va = fineVertexFromSlot[fineSlotIdx(fc, fr)];
      if (va < 0) continue;
      if (fc + 2 <= fineCols) {
        tryAdd(bend, 'bend', va, fineVertexFromSlot[fineSlotIdx(fc + 2, fr)], bendAdded);
      }
      if (fr + 2 <= fineRows) {
        tryAdd(bend, 'bend', va, fineVertexFromSlot[fineSlotIdx(fc, fr + 2)], bendAdded);
      }
    }
  }

  // ── Step 8: Graph coloring per type ───────────────────────────────────────

  colorConstraints(structural, vertexCount);
  colorConstraints(shear,      vertexCount);
  colorConstraints(bend,       vertexCount);

  structural.sort((a, b) => a.color - b.color);
  shear.sort((a, b) => a.color - b.color);
  bend.sort((a, b) => a.color - b.color);

  // ── Step 9: Stitch constraints ────────────────────────────────────────────
  // Stitch a/b are fine dense indices (returned by getClothVertexDenseIndex).

  const stitchEdges: ConstraintEdge[] = [];
  const stitchAdded = new Set<string>();
  for (const s of stitches) {
    if (s.a < 0 || s.b < 0 || s.a >= vertexCount || s.b >= vertexCount) continue;
    const k = edgeKey(s.a, s.b);
    if (stitchAdded.has(k)) continue;
    stitchAdded.add(k);
    stitchEdges.push({ a: s.a, b: s.b, restLength: Math.max(0, s.restLength), type: 'stitch', color: 0 });
  }
  colorConstraints(stitchEdges, vertexCount);
  stitchEdges.sort((a, b) => a.color - b.color);

  const maxColor = (arr: ConstraintEdge[]) => arr.reduce((m, e) => Math.max(m, e.color), -1) + 1;
  const colorCount = Math.max(maxColor(structural), maxColor(shear), maxColor(bend), maxColor(stitchEdges));

  const stitchStart = structural.length + shear.length + bend.length;
  const edges = [...structural, ...shear, ...bend, ...stitchEdges];

  const structColorRanges = buildColorRanges(structural, 0);
  const shearColorRanges  = buildColorRanges(shear,      structural.length);
  const bendColorRanges   = buildColorRanges(bend,        structural.length + shear.length);
  const stitchColorRanges = buildColorRanges(stitchEdges, stitchStart);

  const constraintGraph: ConstraintGraph = {
    edges, colorCount,
    shearStart:  structural.length,
    bendStart:   structural.length + shear.length,
    stitchStart,
    structColorRanges,
    shearColorRanges,
    bendColorRanges,
    stitchColorRanges,
  };

  // ── Step 10: Bend-stiffness map ───────────────────────────────────────────
  // bendStiffnessMap is fine-dense-indexed (same length as vertexCount).
  // When subdivisions changes, Frogmarks should clear this map.

  const bendStiffness = new Float32Array(vertexCount).fill(1.0);
  if (bendStiffnessMap) {
    const limit = Math.min(bendStiffnessMap.length, vertexCount);
    for (let vi = 0; vi < limit; vi++) {
      bendStiffness[vi] = Math.max(0, Math.min(1, bendStiffnessMap[vi]));
    }
  }

  // ── Step 11: Neighbor connectivity for GPU normal recomputation ──────────────
  // For each vertex: [left(fc-1), right(fc+1), up(fr-1), down(fr+1)] as fine dense indices.
  // Fallback -1 means boundary/cutout — pose shader uses the vertex's own position.

  const fineSlotToVertex = new Map<number, number>();
  for (let vi = 0; vi < vertexCount; vi++) fineSlotToVertex.set(slotFromVertexArr[vi], vi);

  const neighborBuf = new Int32Array(vertexCount * 4).fill(-1);
  for (let vi = 0; vi < vertexCount; vi++) {
    const s  = slotFromVertexArr[vi];
    const fc = s % fSC;
    const fr = Math.floor(s / fSC);
    neighborBuf[vi * 4    ] = fineSlotToVertex.get(fineSlotIdx(fc - 1, fr)) ?? -1; // left
    neighborBuf[vi * 4 + 1] = fineSlotToVertex.get(fineSlotIdx(fc + 1, fr)) ?? -1; // right
    neighborBuf[vi * 4 + 2] = fineSlotToVertex.get(fineSlotIdx(fc, fr - 1)) ?? -1; // up
    neighborBuf[vi * 4 + 3] = fineSlotToVertex.get(fineSlotIdx(fc, fr + 1)) ?? -1; // down
  }

  return {
    geometry: { vertices, indices, format: '12float' },
    vertexCount,
    constraintGraph,
    inverseMass,
    flatPositions,
    slotFromVertex:   new Uint32Array(slotFromVertexArr),
    vertexFromSlot:   coarseVertexFromSlot,
    bendStiffness,
    neighborBuf,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build per-color start/end ranges for a sorted-by-color edge array.
 * `offset` is the base index into the global edges[] where this type's section starts.
 * Returns one entry per color group (contiguous run of same-color edges).
 */
function buildColorRanges(
  edges: ConstraintEdge[],
  offset: number,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < edges.length) {
    const start = i;
    const c = edges[i].color;
    while (i < edges.length && edges[i].color === c) i++;
    ranges.push({ start: start + offset, end: i + offset });
  }
  return ranges;
}

/**
 * Greedy graph coloring: assigns each edge the lowest color not used by either
 * of its vertices. Guarantees no two same-color edges share a vertex — safe for
 * parallel GPU dispatch.
 */
function colorConstraints(edges: ConstraintEdge[], vertexCount: number): void {
  const usedColors: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());
  for (const edge of edges) {
    const { a, b } = edge;
    let c = 0;
    while (usedColors[a].has(c) || usedColors[b].has(c)) c++;
    edge.color = c;
    usedColors[a].add(c);
    usedColors[b].add(c);
  }
}

/**
 * Builds a full rectangular grid of active cells (all cols × rows cells active).
 * Used as the default starting configuration for the Cloth Builder modal.
 */
export function buildDefaultActiveCells(cols: number, rows: number): boolean[] {
  return new Array(cols * rows).fill(true);
}
