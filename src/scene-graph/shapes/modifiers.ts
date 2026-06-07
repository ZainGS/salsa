/**
 * Mesh modifiers — CPU geometry transformations applied between source geometry and GPU upload.
 *
 * Modifiers are stored on Mesh3D.modifiers[] and evaluated lazily via Mesh3D.geometry getter.
 * The result is cached in Mesh3D._modifiedGeom; call mesh.invalidateModifierCache() to force
 * recomputation (e.g. after editing params).
 */

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';

// Vertex layout (FLOATS_PER_VERT = 12):
// [px, py, pz, nx, ny, nz, u, v, tx, ty, tz, tw]
//   0   1   2   3   4   5  6  7   8   9  10  11

export interface MirrorModifier {
  type: 'mirror';
  /** Axis to mirror across. */
  axis: 'x' | 'y' | 'z';
  /** Vertices within this distance of the mirror plane are welded to their counterpart. */
  mergeThreshold: number;
}

export interface SolidifyModifier {
  type: 'solidify';
  /** Shell thickness in world units. */
  thickness: number;
  /** When true, include the original surface faces as caps. */
  fillCaps: boolean;
}

export type Modifier = MirrorModifier | SolidifyModifier;

// ── Mirror ────────────────────────────────────────────────────────────────────

function axisComponentOffsets(axis: 'x' | 'y' | 'z'): [number, number, number] {
  // Returns [posOffset, normalOffset, tangentXYZOffset] within a single vertex
  if (axis === 'x') return [0, 3, 8];
  if (axis === 'y') return [1, 4, 9];
  return [2, 5, 10];
}

export function applyMirrorModifier(geom: MeshGeometry, mod: MirrorModifier): MeshGeometry {
  const F = FLOATS_PER_VERT;
  const origVerts = geom.vertices;
  const origInds  = geom.indices;
  const N = origVerts.length / F;
  const [posOff, normOff, tangOff] = axisComponentOffsets(mod.axis);
  const threshold = mod.mergeThreshold;

  // Seam vertices: original verts close to the mirror plane merge with their mirrored copy.
  const atSeam = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (Math.abs(origVerts[i * F + posOff]) < threshold) atSeam[i] = 1;
  }

  // Assign mirrored vertex indices.
  // Seam vertex i maps to itself; non-seam vertex i gets a new slot at nextMirrorIdx.
  const mirrorOf = new Int32Array(N);
  let nextIdx = N;
  for (let i = 0; i < N; i++) {
    mirrorOf[i] = atSeam[i] ? i : nextIdx++;
  }
  const totalVerts = nextIdx; // N + (non-seam count)

  // Build output vertex buffer
  const outVerts = new Float32Array(totalVerts * F);
  outVerts.set(origVerts); // copy original verts (indices 0..N-1)

  for (let i = 0; i < N; i++) {
    if (atSeam[i]) continue; // no new vertex for seam
    const src = i * F;
    const dst = mirrorOf[i] * F;
    for (let k = 0; k < F; k++) outVerts[dst + k] = origVerts[src + k];
    outVerts[dst + posOff]  = -origVerts[src + posOff];  // flip position component
    outVerts[dst + normOff] = -origVerts[src + normOff]; // flip normal component
    outVerts[dst + tangOff] = -origVerts[src + tangOff]; // flip tangent xyz component
    outVerts[dst + 11]      = -origVerts[src + 11];      // flip tangent.w (handedness)
  }

  // Build output index buffer: original triangles + mirrored with reversed winding
  const triCount = origInds.length / 3;
  const outInds = new Uint32Array(origInds.length * 2);
  outInds.set(origInds);
  for (let t = 0; t < triCount; t++) {
    const a = origInds[t * 3];
    const b = origInds[t * 3 + 1];
    const c = origInds[t * 3 + 2];
    // Reversed winding: swap b and c to flip face
    outInds[origInds.length + t * 3]     = mirrorOf[a];
    outInds[origInds.length + t * 3 + 1] = mirrorOf[c];
    outInds[origInds.length + t * 3 + 2] = mirrorOf[b];
  }

  return { vertices: outVerts, indices: outInds, format: '12float' };
}

// ── Solidify ──────────────────────────────────────────────────────────────────

export function applySolidifyModifier(geom: MeshGeometry, mod: SolidifyModifier): MeshGeometry {
  const F = FLOATS_PER_VERT;
  const origVerts = geom.vertices;
  const origInds  = geom.indices;
  const N = origVerts.length / F;
  const half = mod.thickness / 2;

  // Build 2N vertices: outer (0..N-1) offset along +normal, inner (N..2N-1) along -normal.
  const outVerts = new Float32Array(N * 2 * F);
  for (let i = 0; i < N; i++) {
    const s  = i * F;
    const o1 = i * F;        // outer slot
    const o2 = (N + i) * F;  // inner slot
    for (let k = 0; k < F; k++) {
      outVerts[o1 + k] = origVerts[s + k];
      outVerts[o2 + k] = origVerts[s + k];
    }
    const nx = origVerts[s + 3], ny = origVerts[s + 4], nz = origVerts[s + 5];
    outVerts[o1 + 0] += nx * half;  outVerts[o1 + 1] += ny * half;  outVerts[o1 + 2] += nz * half;
    outVerts[o2 + 0] -= nx * half;  outVerts[o2 + 1] -= ny * half;  outVerts[o2 + 2] -= nz * half;
    // Flip inner normal and tangent direction
    outVerts[o2 + 3] = -nx;  outVerts[o2 + 4] = -ny;  outVerts[o2 + 5] = -nz;
    outVerts[o2 + 8] = -origVerts[s + 8]; // flip tangent x
    outVerts[o2 + 11] = -origVerts[s + 11]; // flip tangent.w
  }

  // Find boundary edges (edges shared by exactly one triangle)
  const edgeCount = new Map<number, { a: number; b: number; count: number }>();
  const triCount = origInds.length / 3;
  for (let t = 0; t < triCount; t++) {
    for (let j = 0; j < 3; j++) {
      const ea = origInds[t * 3 + j];
      const eb = origInds[t * 3 + ((j + 1) % 3)];
      const lo = ea < eb ? ea : eb;
      const hi = ea < eb ? eb : ea;
      const key = lo * 0x100000 + hi; // safe for N < 1M
      const entry = edgeCount.get(key);
      if (!entry) edgeCount.set(key, { a: ea, b: eb, count: 1 });
      else entry.count++;
    }
  }
  const boundaryEdges: [number, number][] = [];
  for (const { a, b, count } of edgeCount.values()) {
    if (count === 1) boundaryEdges.push([a, b]);
  }

  const capTris  = mod.fillCaps ? triCount * 2 : 0;
  const sideTris = boundaryEdges.length * 2;
  const outInds  = new Uint32Array((capTris + sideTris) * 3);
  let ii = 0;

  if (mod.fillCaps) {
    // Outer cap: original winding
    for (let i = 0; i < origInds.length; i++) outInds[ii++] = origInds[i];
    // Inner cap: reversed winding, vertex indices offset by N
    for (let t = 0; t < triCount; t++) {
      outInds[ii++] = N + origInds[t * 3];
      outInds[ii++] = N + origInds[t * 3 + 2]; // reversed
      outInds[ii++] = N + origInds[t * 3 + 1];
    }
  }

  // Side walls: one quad (two tris) per boundary edge, connecting outer to inner ring
  for (const [a, b] of boundaryEdges) {
    outInds[ii++] = a;     outInds[ii++] = b;     outInds[ii++] = N + b;
    outInds[ii++] = a;     outInds[ii++] = N + b;  outInds[ii++] = N + a;
  }

  return { vertices: outVerts, indices: outInds, format: '12float' };
}

// ── Chain ─────────────────────────────────────────────────────────────────────

export function applyModifiers(geom: MeshGeometry, modifiers: Modifier[]): MeshGeometry {
  let result = geom;
  for (const mod of modifiers) {
    if (mod.type === 'mirror')   result = applyMirrorModifier(result, mod);
    if (mod.type === 'solidify') result = applySolidifyModifier(result, mod);
  }
  return result;
}
