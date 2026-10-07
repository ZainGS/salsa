/**
 * EditMesh — CPU-side authoring structure for interactive 3D modeling.
 *
 * Stores a half-edge mesh (vertices + faces + directed half-edge adjacency)
 * and a non-destructive modifier stack. `compile()` evaluates the stack and
 * returns a GPU-ready MeshGeometry.
 *
 * Phase 2: primitive constructors, vertex drag, extrude, inset, delete, weld,
 * vertex colors, MirrorModifier, SubdivisionModifier.
 *
 * Phase 3: loop cut, edge dissolve, bevel, knife, auto-UV, bridge — all shipped.
 *
 * Topology model (docs/specs/edit-mesh-topology.md): the vertices are the SHARED topology vertices (a cube has 8)
 * and the faces are polygons (a cube has 6 quads). Attributes that differ per face corner live on the corner — the
 * half-edge whose destination is the corner's vertex (`EditHalfEdge.uv`); `EditVertex.uv` is the per-vertex
 * fallback (legacy meshes, and corners without their own UV). Shading comes from `EditFace.smooth` (flat = the face
 * normal) + `EditHalfEdge.isSharp`. `compile()` derives the GPU mesh (edit-mesh-render.ts): split where corner
 * attributes differ, triangulate the n-gons. Meshes enter Edit Mesh through `EditMesh.fromGeometry` (welded,
 * tris → quads — edit-mesh-weld.ts).
 */

import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import { buildRenderMesh, patchRenderMesh, type RenderGeometry, type RenderState } from './edit-mesh-render';
import { weldGeometry, type WeldOptions } from './edit-mesh-weld';

// ── Data types ────────────────────────────────────────────────────────────────

/**
 * A connected group of faces in UV space — faces reachable from each other
 * without crossing a seam edge. Computed by `EditMesh.computeUVIslands()`.
 */
export interface UVIsland {
  /** Stable zero-based index within the result array from `computeUVIslands()`. */
  id: number;
  /** Indices into `EditMesh.faces`. */
  faceIndices: number[];
  /** Unique vertex indices used by this island's faces. */
  vertexIndices: number[];
  /** The island's face corners (half-edge indices — see EditMesh.cornerUV). UV ops edit these. */
  cornerIndices: number[];
  /**
   * Axis-aligned bounding box in UV space [uMin, vMin, uMax, vMax].
   * All zeros if no vertex in the island has a UV assigned.
   */
  uvBounds: [number, number, number, number];
  /** Approximate surface area in 3D world units (sum of triangle areas). Used for proportional UV scaling. */
  worldArea: number;
}

export interface EditVertex {
  x: number; y: number; z: number;
  color: [number, number, number, number];
  halfEdge: number;  // index of one outgoing half-edge from this vertex (-1 if isolated)
  /** Per-VERTEX UV: the fallback for corners without their own (`EditHalfEdge.uv`). Absent on a primitive until
   *  it is unwrapped (the UV editor auto-unwraps a mesh whose vertices have none). */
  uv?: [number, number];
}

export interface EditFace {
  halfEdge: number;     // the half-edge whose destination is the face's FIRST corner (walk `next` for the rest)
  vertexCount: number;  // 3 = triangle, 4 = quad, n = n-gon
  /** Smooth shading (corner normals averaged over the fan); absent / false = flat (the face normal). */
  smooth?: boolean;
}

export interface EditHalfEdge {
  vertex: number;  // destination vertex index
  twin: number;    // opposite half-edge (-1 = boundary)
  next: number;    // next half-edge around same face
  prev: number;    // previous half-edge around same face
  face: number;    // face index (-1 = boundary)
  isSeam: boolean; // UV cut line — both sides of the edge are marked together
  /** Hard edge: smooth fans never cross it (both sides marked together). */
  isSharp?: boolean;
  /** UV of the FACE CORNER at `vertex` in `face` (undefined = the vertex's own `uv`). */
  uv?: [number, number];
}

/**
 * One face's vertex loop as topology ops build it, plus its per-corner UVs and shading flag. The attributes ride on
 * the array object, so an op that keeps a face (filter / splice / in-place index rewrite) keeps them; an op that
 * builds a new face states them (or leaves them off → vertex UVs, flat).
 */
export type FaceList = number[] & { uvs?: Array<[number, number] | undefined>; smooth?: boolean };

/** Flat data format passed between modifiers — no half-edge adjacency. */
export interface EditMeshData {
  vertices: Array<{ x: number; y: number; z: number; color: [number, number, number, number] }>;
  /** `uvs[k]` = corner k's own UV (absent = the vertex's); `smooth` = smooth shading. */
  faces: Array<{ verts: number[]; uvs?: Array<[number, number] | undefined>; smooth?: boolean }>;
  /** Per-vertex UVs (the corner fallback). */
  uvs: Array<[number, number]>;
  /** Undirected vertex pairs of sharp edges. */
  sharpEdges?: Array<[number, number]>;
}

type UV = [number, number];

/** A FaceList over `verts` (the same array object) with the given corner UVs / shading. */
export function faceList(verts: number[], uvs?: Array<UV | undefined> | null, smooth?: boolean): FaceList {
  const f = verts as FaceList;
  if (uvs && uvs.some((u) => u !== undefined)) f.uvs = uvs.map((u) => (u ? [u[0], u[1]] as UV : undefined));
  if (smooth) f.smooth = true;
  return f;
}

/** `f` with its vertex indices mapped (attributes kept, corner for corner). */
function remapFace(f: FaceList, fn: (vi: number) => number): FaceList {
  return faceList(f.map(fn), f.uvs, f.smooth);
}

function lerpUV(a: UV | undefined, b: UV | undefined, t: number): UV | undefined {
  if (!a || !b) return a && !b ? [a[0], a[1]] : b && !a ? [b[0], b[1]] : undefined;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function avgUV(list: Array<UV | undefined>): UV | undefined {
  let u = 0, v = 0, n = 0;
  for (const p of list) if (p) { u += p[0]; v += p[1]; n++; }
  return n ? [u / n, v / n] : undefined;
}

// ── Modifier interface ─────────────────────────────────────────────────────────

export interface Modifier {
  type: string;
  enabled: boolean;
  apply(mesh: EditMeshData): EditMeshData;
  toJSON(): object;
}

// ── MirrorModifier ────────────────────────────────────────────────────────────

export class MirrorModifier implements Modifier {
  type = 'mirror' as const;
  enabled = true;
  axis: 'x' | 'y' | 'z' = 'x';
  mergeThreshold = 0.001;
  clipping = true;

  constructor(axis: 'x' | 'y' | 'z' = 'x', clipping = true) {
    this.axis = axis;
    this.clipping = clipping;
  }

  apply(mesh: EditMeshData): EditMeshData {
    const offset = mesh.vertices.length;

    const mirroredVerts = mesh.vertices.map(v => ({
      x: this.axis === 'x' ? -v.x : v.x,
      y: this.axis === 'y' ? -v.y : v.y,
      z: this.axis === 'z' ? -v.z : v.z,
      color: v.color as [number, number, number, number],
    }));

    // Reverse winding on mirrored faces (flip normals to face outward); corner UVs reverse with their corners.
    const mirroredFaces = mesh.faces.map(f => ({
      verts: [...f.verts].reverse().map(i => i + offset),
      uvs: f.uvs ? [...f.uvs].reverse() : undefined,
      smooth: f.smooth,
    }));
    const sharp = mesh.sharpEdges ?? [];

    const combined: EditMeshData = {
      vertices: [...mesh.vertices, ...mirroredVerts],
      faces: [...mesh.faces, ...mirroredFaces],
      uvs: [...mesh.uvs, ...mesh.uvs],
      sharpEdges: [...sharp, ...sharp.map(([a, b]) => [a + offset, b + offset] as [number, number])],
    };

    if (this.mergeThreshold > 0) {
      return _weldOnAxis(combined, this.mergeThreshold, this.axis);
    }
    return combined;
  }

  toJSON(): object {
    return { type: this.type, enabled: this.enabled, axis: this.axis, mergeThreshold: this.mergeThreshold, clipping: this.clipping };
  }
}

// ── SubdivisionModifier ────────────────────────────────────────────────────────

export class SubdivisionModifier implements Modifier {
  type = 'subdivision' as const;
  enabled = true;
  iterations = 1;

  constructor(iterations = 1) { this.iterations = iterations; }

  apply(mesh: EditMeshData): EditMeshData {
    let result = mesh;
    for (let i = 0; i < this.iterations; i++) {
      result = _catmullClark(result);
    }
    return result;
  }

  toJSON(): object {
    return { type: this.type, enabled: this.enabled, iterations: this.iterations };
  }
}

// ── DisplaceModifier ───────────────────────────────────────────────────────────

/** Hash-based 3D value noise in [-1, 1], smoothly interpolated over the integer lattice. Self-contained (no
 *  dependency on the world-gen noise, which lives in a different layer) and deterministic per `seed`. */
function _valueNoise3(x: number, y: number, z: number, seed: number): number {
  const hash = (ix: number, iy: number, iz: number): number => {
    const s = Math.sin(ix * 127.1 + iy * 311.7 + iz * 74.7 + seed * 13.37) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;   // → [-1, 1]
  };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const fade = (t: number): number => t * t * (3 - 2 * t);           // smoothstep
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const c000 = hash(xi, yi, zi),     c100 = hash(xi + 1, yi, zi);
  const c010 = hash(xi, yi + 1, zi), c110 = hash(xi + 1, yi + 1, zi);
  const c001 = hash(xi, yi, zi + 1), c101 = hash(xi + 1, yi, zi + 1);
  const c011 = hash(xi, yi + 1, zi + 1), c111 = hash(xi + 1, yi + 1, zi + 1);
  return lerp(
    lerp(lerp(c000, c100, u), lerp(c010, c110, u), v),
    lerp(lerp(c001, c101, u), lerp(c011, c111, u), v),
    w,
  );
}

/**
 * Push every vertex along its normal (or a fixed axis) by a noise field — surface roughness / relief: rocks,
 * asteroids, gnarled trunks, terrain. Non-destructive (stack modifier); works best AFTER a Subdivision modifier so
 * there are enough vertices to displace. Per-vertex normals are computed from the flat face data (no half-edge).
 */
export class DisplaceModifier implements Modifier {
  type = 'displace' as const;
  enabled = true;
  strength = 0.1;
  frequency = 1.0;
  seed = 0;
  octaves = 1;
  direction: 'normal' | 'x' | 'y' | 'z' = 'normal';

  constructor(params?: Partial<Pick<DisplaceModifier, 'strength' | 'frequency' | 'seed' | 'octaves' | 'direction'>>) {
    if (params) Object.assign(this, params);
  }

  apply(mesh: EditMeshData): EditMeshData {
    const V = mesh.vertices;
    // Per-vertex normals: accumulate incident face normals (Newell's method over each face) then normalize.
    const nx = new Float64Array(V.length), ny = new Float64Array(V.length), nz = new Float64Array(V.length);
    for (const f of mesh.faces) {
      const vs = f.verts;
      let fx = 0, fy = 0, fz = 0;
      for (let i = 0; i < vs.length; i++) {
        const a = V[vs[i]], b = V[vs[(i + 1) % vs.length]];
        fx += (a.y - b.y) * (a.z + b.z);
        fy += (a.z - b.z) * (a.x + b.x);
        fz += (a.x - b.x) * (a.y + b.y);
      }
      for (const vi of vs) { nx[vi] += fx; ny[vi] += fy; nz[vi] += fz; }
    }

    const octaves = Math.max(1, this.octaves | 0);
    const fbm = (x: number, y: number, z: number): number => {
      let sum = 0, amp = 1, freq = this.frequency, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * _valueNoise3(x * freq, y * freq, z * freq, this.seed + o * 101);
        norm += amp; amp *= 0.5; freq *= 2;
      }
      return sum / (norm || 1);
    };

    const out = V.map((v, i) => {
      const d = fbm(v.x, v.y, v.z) * this.strength;
      let dx: number, dy: number, dz: number;
      if (this.direction === 'normal') {
        const len = Math.hypot(nx[i], ny[i], nz[i]) || 1;
        dx = (nx[i] / len) * d; dy = (ny[i] / len) * d; dz = (nz[i] / len) * d;
      } else {
        dx = this.direction === 'x' ? d : 0;
        dy = this.direction === 'y' ? d : 0;
        dz = this.direction === 'z' ? d : 0;
      }
      return { x: v.x + dx, y: v.y + dy, z: v.z + dz, color: v.color as [number, number, number, number] };
    });
    return { vertices: out, faces: mesh.faces, uvs: mesh.uvs, sharpEdges: mesh.sharpEdges };
  }

  toJSON(): object {
    return { type: this.type, enabled: this.enabled, strength: this.strength, frequency: this.frequency, seed: this.seed, octaves: this.octaves, direction: this.direction };
  }
}

// ── EditMesh ──────────────────────────────────────────────────────────────────

export class EditMesh {
  vertices: EditVertex[] = [];
  faces: EditFace[] = [];
  halfEdges: EditHalfEdge[] = [];
  modifiers: Modifier[] = [];

  proportionalEditEnabled = false;
  proportionalEditRadius = 1.0;
  proportionalEditFalloff: 'smooth' | 'linear' | 'sharp' = 'smooth';

  /**
   * Output-vertex → source-vertex map from the most recent `compile()`. Each entry is the
   * post-modifier EditMeshData vertex index that produced that GPU vertex. SkinnedMesh3D uses
   * it to re-map per-vertex joint weights onto the recompiled (un-indexed) geometry.
   */
  lastCompileSourceVerts: Uint32Array | null = null;

  // ── Compile ──────────────────────────────────────────────────────────────

  /**
   * Evaluates base mesh + modifier stack → GPU-ready MeshGeometry (the RENDER mesh: indexed; vertices split where
   * corner attributes differ, n-gons triangulated — see edit-mesh-render.ts). Carries `vertexColors` (per render
   * vertex) and `sourceVerts` (render vertex → post-modifier vertex).
   */
  compile(): MeshGeometry {
    let data = this._toEditMeshData();
    let modded = false;
    for (const mod of this.modifiers) {
      if (mod.enabled) { data = mod.apply(data); modded = true; }
    }
    const { geom, state } = buildRenderMesh(data);
    this.lastCompileSourceVerts = geom.sourceVerts;
    // mobile-parity 7.3d: remember what this compile was made from, so a vertex drag can patch it in place
    // (patchCompiledPositions). A modifier stack maps vertices to outputs non-trivially → no incremental path.
    this._ic = modded ? null : {
      geom, verts: this.vertices, faces: this.faces, halfEdges: this.halfEdges,
      nv: this.vertices.length, nf: this.faces.length, nh: this.halfEdges.length, state,
    };
    return geom;
  }

  /** Incremental-compile state of the last compile() (null = none / a modifier stack was applied). */
  private _ic: IncrementalCompile | null = null;

  /**
   * mobile-parity 7.3d (Mesh Edit vertex drag): bring `geom` — the MeshGeometry the LAST compile() returned, edited
   * IN PLACE — in line with the current vertex POSITIONS without a recompile. Only the faces touching a vertex that
   * moved since the last compile / patch are re-framed, and only their render vertices (plus every render vertex of
   * a smooth fan they feed) are rewritten, through the same arithmetic as compile() — the bytes equal a fresh compile
   * exactly. Valid only while the topology, UVs and colours are as at that compile: the vertex / face / half-edge
   * ARRAYS must be the same objects with the same lengths (every topology operation rebuilds them) and no modifier
   * may be enabled.
   *
   * Returns the rewritten OUTPUT-vertex spans flattened as [start, count, start, count, ...] in ascending order
   * ([] = nothing moved), or null when the incremental path does not apply (the caller recompiles).
   */
  patchCompiledPositions(geom: MeshGeometry): number[] | null {
    const ic = this._ic;
    if (!ic || ic.geom !== geom || ic.verts !== this.vertices || ic.faces !== this.faces || ic.halfEdges !== this.halfEdges
        || this.vertices.length !== ic.nv || this.faces.length !== ic.nf || this.halfEdges.length !== ic.nh) return null;
    for (const mod of this.modifiers) if (mod.enabled) return null;
    const out = geom.vertices as Float32Array;
    if (!(out instanceof Float32Array) || out.length !== (ic.state.rvStart.length - 1) * FLOATS_PER_VERT) return null;
    return patchRenderMesh(ic.state, this.vertices, out);
  }

  /**
   * Bake modifiers up to and including `index`: evaluate that prefix of the stack,
   * write the result back into the base mesh, and remove ALL baked modifiers from the
   * stack. (Every modifier at or before `index` is folded into the base geometry, so
   * leaving the earlier ones in place would re-apply them on the next compile — the mesh
   * would duplicate/explode with 2+ modifiers.)
   * DESTRUCTIVE — caller should push an undo snapshot first.
   */
  applyModifier(index: number): void {
    let data = this._toEditMeshData();
    for (let i = 0; i <= index; i++) {
      if (this.modifiers[i].enabled) data = this.modifiers[i].apply(data);
    }
    this._fromEditMeshData(data);
    this.modifiers.splice(0, index + 1);
  }

  // ── Primitive constructors ────────────────────────────────────────────────

  static fromBox(w = 1, h = 1, d = 1): EditMesh {
    const hw = w / 2, hh = h / 2, hd = d / 2;
    const mesh = new EditMesh();
    const c: [number, number, number, number] = [0.8, 0.8, 0.8, 1];

    // Vertices indexed: bit0=X, bit1=Y, bit2=Z  (0=min, 1=max)
    mesh.vertices = [
      { x: -hw, y: -hh, z: -hd, color: [...c] as [number,number,number,number], halfEdge: -1 }, // 0 LBB
      { x: +hw, y: -hh, z: -hd, color: [...c] as [number,number,number,number], halfEdge: -1 }, // 1 RBB
      { x: +hw, y: +hh, z: -hd, color: [...c] as [number,number,number,number], halfEdge: -1 }, // 2 RTB
      { x: -hw, y: +hh, z: -hd, color: [...c] as [number,number,number,number], halfEdge: -1 }, // 3 LTB
      { x: -hw, y: -hh, z: +hd, color: [...c] as [number,number,number,number], halfEdge: -1 }, // 4 LBF
      { x: +hw, y: -hh, z: +hd, color: [...c] as [number,number,number,number], halfEdge: -1 }, // 5 RBF
      { x: +hw, y: +hh, z: +hd, color: [...c] as [number,number,number,number], halfEdge: -1 }, // 6 RTF
      { x: -hw, y: +hh, z: +hd, color: [...c] as [number,number,number,number], halfEdge: -1 }, // 7 LTF
    ];

    // CCW quad faces — face order, corner order and corner UVs match generateBox in mesh-generators.ts, so the
    // compiled render mesh is byte-identical to the primitive's geometry. (Vertex UVs stay unset: the UV editor
    // still auto-unwraps a fresh box on first open.)
    const quadUV: UV[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    mesh._buildTopology([
      [4, 5, 6, 7],  // front  +Z
      [1, 0, 3, 2],  // back   -Z
      [7, 6, 2, 3],  // top    +Y
      [0, 1, 5, 4],  // bottom -Y
      [5, 1, 2, 6],  // right  +X
      [0, 4, 7, 3],  // left   -X
    ].map(f => faceList(f, quadUV)));

    return mesh;
  }

  /**
   * Build the editable topology of a GPU geometry (12-float, indexed or not): coincident vertices WELDED into one,
   * coplanar triangle pairs merged into quads (conservative), per-corner UVs kept, smooth / sharp shading derived from
   * the source normals — see edit-mesh-weld.ts. This is how every mesh enters Edit Mesh (primitives, imports, reloaded
   * triangle-soup saves). `{ weld: false }` keeps the geometry's vertices 1:1 (skinned bodies).
   */
  static fromGeometry(geom: MeshGeometry, opts?: WeldOptions): EditMesh {
    const r = weldGeometry(geom, opts);
    const mesh = new EditMesh();
    mesh.vertices = r.vertices.map(v => ({ x: v.x, y: v.y, z: v.z, color: v.color, halfEdge: -1, uv: v.uv }));
    mesh._buildTopology(r.faces.map(f => faceList(f.verts, f.uvs, f.smooth)), { keepFlags: false });
    mesh._markPairs(r.sharpEdges, 'isSharp');
    return mesh;
  }

  static fromSphere(radius = 0.5, segments = 8): EditMesh {
    const mesh = new EditMesh();
    const latDiv = Math.max(2, Math.floor(segments / 2));
    const lonDiv = Math.max(3, segments);
    const c: [number, number, number, number] = [0.8, 0.8, 0.8, 1];
    const faceLists: number[][] = [];

    // Top pole
    mesh.vertices.push({ x: 0, y: radius, z: 0, color: [...c] as [number,number,number,number], halfEdge: -1 });

    // Latitude rings (excluding poles)
    for (let lat = 1; lat < latDiv; lat++) {
      const phi = Math.PI * lat / latDiv;
      const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
      for (let lon = 0; lon < lonDiv; lon++) {
        const theta = 2 * Math.PI * lon / lonDiv;
        mesh.vertices.push({
          x: radius * sinPhi * Math.cos(theta),
          y: radius * cosPhi,
          z: radius * sinPhi * Math.sin(theta),
          color: [...c] as [number,number,number,number],
          halfEdge: -1,
        });
      }
    }

    // Bottom pole
    const bottomPole = mesh.vertices.length;
    mesh.vertices.push({ x: 0, y: -radius, z: 0, color: [...c] as [number,number,number,number], halfEdge: -1 });

    const ringIdx = (lat: number, lon: number): number =>
      1 + (lat - 1) * lonDiv + ((lon + lonDiv) % lonDiv);

    // Top cap triangles (pole → first ring, CCW = outward normal)
    for (let lon = 0; lon < lonDiv; lon++) {
      const b = ringIdx(1, lon);
      const c2 = ringIdx(1, (lon + 1) % lonDiv);
      faceLists.push([0, c2, b]);
    }

    // Middle quads
    for (let lat = 1; lat < latDiv - 1; lat++) {
      for (let lon = 0; lon < lonDiv; lon++) {
        const a = ringIdx(lat, lon);
        const b = ringIdx(lat, (lon + 1) % lonDiv);
        const c2 = ringIdx(lat + 1, (lon + 1) % lonDiv);
        const d = ringIdx(lat + 1, lon);
        faceLists.push([a, b, c2, d]);
      }
    }

    // Bottom cap triangles (last ring → bottom pole, CCW = outward normal)
    for (let lon = 0; lon < lonDiv; lon++) {
      const a = ringIdx(latDiv - 1, lon);
      const b = ringIdx(latDiv - 1, (lon + 1) % lonDiv);
      faceLists.push([a, bottomPole, b]);
    }

    mesh._buildTopology(faceLists);
    return mesh;
  }

  static fromCylinder(radius = 0.5, height = 1, segments = 8): EditMesh {
    const mesh = new EditMesh();
    const rs = Math.max(3, segments);
    const hh = height / 2;
    const c: [number, number, number, number] = [0.8, 0.8, 0.8, 1];
    const faceLists: number[][] = [];

    // Top rim ring
    for (let i = 0; i < rs; i++) {
      const theta = 2 * Math.PI * i / rs;
      mesh.vertices.push({ x: Math.cos(theta) * radius, y: hh, z: Math.sin(theta) * radius, color: [...c] as [number,number,number,number], halfEdge: -1 });
    }

    // Bottom rim ring
    for (let i = 0; i < rs; i++) {
      const theta = 2 * Math.PI * i / rs;
      mesh.vertices.push({ x: Math.cos(theta) * radius, y: -hh, z: Math.sin(theta) * radius, color: [...c] as [number,number,number,number], halfEdge: -1 });
    }

    // Top cap center
    const topCenter = mesh.vertices.length;
    mesh.vertices.push({ x: 0, y: hh, z: 0, color: [...c] as [number,number,number,number], halfEdge: -1 });

    // Bottom cap center
    const botCenter = mesh.vertices.length;
    mesh.vertices.push({ x: 0, y: -hh, z: 0, color: [...c] as [number,number,number,number], halfEdge: -1 });

    const topRim = (i: number): number => (i + rs) % rs;
    const botRim = (i: number): number => rs + (i + rs) % rs;

    // Side quads
    for (let i = 0; i < rs; i++) {
      const a = topRim(i), b = topRim(i + 1);
      const c2 = botRim(i + 1), d = botRim(i);
      faceLists.push([a, d, c2, b]);
    }

    // Top cap triangles (CCW from above = outward +Y normal)
    for (let i = 0; i < rs; i++) {
      faceLists.push([topCenter, topRim(i + 1), topRim(i)]);
    }

    // Bottom cap triangles (CCW from below = outward -Y normal)
    for (let i = 0; i < rs; i++) {
      faceLists.push([botCenter, botRim(i), botRim(i + 1)]);
    }

    mesh._buildTopology(faceLists);
    return mesh;
  }

  /**
   * Build a polygon mesh from a 2D silhouette in the XZ plane.
   *
   * `points` — array of [x, z] pairs (minimum 3). Y is up.
   * `height` — extrusion distance along +Y. 0 = flat n-gon with no sides.
   *
   * The mesh starts with an EditMesh attached (immediately editable).
   * Winding is normalized to CCW (outward normals) regardless of input order.
   */
  static fromPolygon(points: [number, number][], height = 1): EditMesh {
    const n = points.length;
    if (n < 3) throw new Error('fromPolygon requires at least 3 points');

    // Normalize to CCW winding (positive signed area from above in XZ plane).
    let signedArea = 0;
    for (let i = 0; i < n; i++) {
      const [x0, z0] = points[i];
      const [x1, z1] = points[(i + 1) % n];
      signedArea += x0 * z1 - x1 * z0;
    }
    if (signedArea < 0) points = [...points].reverse();

    const mesh = new EditMesh();
    const c: [number, number, number, number] = [0.8, 0.8, 0.8, 1];
    const faceLists: number[][] = [];

    if (height === 0) {
      // Flat cap only
      for (const [x, z] of points) {
        mesh.vertices.push({ x, y: 0, z, color: [...c] as [number, number, number, number], halfEdge: -1 });
      }
      faceLists.push(Array.from({ length: n }, (_, i) => i));
    } else {
      // Bottom ring (y=0) then top ring (y=height)
      for (const [x, z] of points) {
        mesh.vertices.push({ x, y: 0, z, color: [...c] as [number, number, number, number], halfEdge: -1 });
      }
      for (const [x, z] of points) {
        mesh.vertices.push({ x, y: height, z, color: [...c] as [number, number, number, number], halfEdge: -1 });
      }

      // Bottom cap — reversed winding for outward -Y normal
      faceLists.push(Array.from({ length: n }, (_, i) => n - 1 - i));
      // Top cap — CCW from above for outward +Y normal
      faceLists.push(Array.from({ length: n }, (_, i) => n + i));
      // Side quads
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        faceLists.push([i, next, n + next, n + i]);
      }
    }

    mesh._buildTopology(faceLists);
    return mesh;
  }

  /**
   * Build a regular n-gon mesh (circle approximation) extruded along Y.
   * Convenience wrapper around `fromPolygon`.
   */
  static fromCircle(radius = 0.5, segments = 8, height = 1): EditMesh {
    const rs = Math.max(3, segments);
    const points: [number, number][] = Array.from({ length: rs }, (_, i) => {
      const theta = 2 * Math.PI * i / rs;
      return [Math.cos(theta) * radius, Math.sin(theta) * radius];
    });
    return EditMesh.fromPolygon(points, height);
  }

  // ── Destructive operations ────────────────────────────────────────────────

  /** Move a vertex by (dx, dy, dz). Applies proportional falloff when enabled. */
  moveVertex(vIdx: number, dx: number, dy: number, dz: number): void {
    const v = this.vertices[vIdx];
    if (!v) return;
    if (!this.proportionalEditEnabled) {
      v.x += dx; v.y += dy; v.z += dz;
      return;
    }
    const ox = v.x, oy = v.y, oz = v.z;
    const r = this.proportionalEditRadius;
    for (let i = 0; i < this.vertices.length; i++) {
      const vi = this.vertices[i];
      const dist = Math.sqrt((vi.x - ox) ** 2 + (vi.y - oy) ** 2 + (vi.z - oz) ** 2);
      if (dist >= r) continue;
      const t = dist / r;
      let weight: number;
      switch (this.proportionalEditFalloff) {
        case 'linear': weight = 1 - t; break;
        case 'sharp':  weight = t < 0.1 ? 1 : 0; break;
        default:       weight = (1 - t) * (1 - t); break;
      }
      vi.x += dx * weight; vi.y += dy * weight; vi.z += dz * weight;
    }
  }

  /**
   * Extrude face `fIdx` by `distance` along its face normal.
   * Returns array of new face indices (top face + side faces).
   */
  extrudeFace(fIdx: number, distance: number): number[] {
    if (fIdx < 0 || fIdx >= this.faces.length) return [];
    const faceLists = this._getAllFaceLists();
    const src = faceLists[fIdx];
    const faceVerts = [...src];
    const normal = this._computeFaceNormal(fIdx);
    const U = (k: number): UV | undefined => this._fuv(src, k % faceVerts.length);

    const newVertBase = this.vertices.length;
    for (const vi of faceVerts) {
      const v = this.vertices[vi];
      this.vertices.push({
        x: v.x + normal[0] * distance,
        y: v.y + normal[1] * distance,
        z: v.z + normal[2] * distance,
        color: [...v.color] as [number, number, number, number],
        halfEdge: -1,
        uv: v.uv ? [v.uv[0], v.uv[1]] : undefined,
      });
    }

    const n = faceVerts.length;
    const newVerts = faceVerts.map((_, k) => newVertBase + k);

    // Replace original face with the extruded top (same corner UVs)
    faceLists[fIdx] = faceList(newVerts, src.uvs, src.smooth);

    // Add side quads for each edge of the original face (UVs of the edge's two corners, stretched up the wall)
    const newFaceStart = faceLists.length;
    for (let k = 0; k < n; k++) {
      const a = faceVerts[k];
      const b = faceVerts[(k + 1) % n];
      const bNew = newVerts[(k + 1) % n];
      const aNew = newVerts[k];
      faceLists.push(faceList([a, b, bNew, aNew], src.uvs ? [U(k), U(k + 1), U(k + 1), U(k)] : null, src.smooth));
    }

    this._buildTopology(faceLists);

    const newFaces: number[] = [fIdx];
    for (let i = newFaceStart; i < faceLists.length; i++) newFaces.push(i);
    return newFaces;
  }

  /**
   * Inset face `fIdx` by `amount` (0=no inset, 1=collapse to center).
   * Returns the index of the inner (inset) face.
   */
  insetFace(fIdx: number, amount: number): number {
    if (fIdx < 0 || fIdx >= this.faces.length) return -1;
    const faceLists = this._getAllFaceLists();
    this._insetInto(faceLists, fIdx, amount);
    this._buildTopology(faceLists);
    return fIdx;
  }

  /** Inset face `fi` of `faceLists` in place: inner face (UVs pulled toward the UV centroid) + border quads. */
  private _insetInto(faceLists: FaceList[], fi: number, amount: number): void {
    const src = faceLists[fi];
    const faceVerts = [...src];
    const n = faceVerts.length;
    let cx = 0, cy = 0, cz = 0;
    for (const vi of faceVerts) { cx += this.vertices[vi].x / n; cy += this.vertices[vi].y / n; cz += this.vertices[vi].z / n; }
    const vuvC = avgUV(faceVerts.map(vi => this.vertices[vi].uv));
    const allVUV = faceVerts.every(vi => !!this.vertices[vi].uv);

    const innerBase = this.vertices.length;
    for (const vi of faceVerts) {
      const v = this.vertices[vi];
      this.vertices.push({
        x: v.x + (cx - v.x) * amount,
        y: v.y + (cy - v.y) * amount,
        z: v.z + (cz - v.z) * amount,
        color: [...v.color] as [number, number, number, number],
        halfEdge: -1,
        uv: allVUV ? lerpUV(v.uv, vuvC, amount) : undefined,
      });
    }
    const innerVerts = faceVerts.map((_, k) => innerBase + k);
    const outerUV = faceVerts.map((_, k) => this._fuv(src, k));
    const uvC = avgUV(outerUV);
    const innerUV = outerUV.map(u => lerpUV(u, uvC, amount));
    const has = !!src.uvs;

    // Replace original face with inner face
    faceLists[fi] = faceList(innerVerts, has ? innerUV : null, src.smooth);

    // Add border quads
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      faceLists.push(faceList([faceVerts[k], faceVerts[k1], innerVerts[k1], innerVerts[k]],
        has ? [outerUV[k], outerUV[k1], innerUV[k1], innerUV[k]] : null, src.smooth));
    }
  }

  /** Delete face at `fIdx`. The face disappears; bordering edges become boundary. */
  deleteFace(fIdx: number): void {
    if (fIdx < 0 || fIdx >= this.faces.length) return;
    const faceLists = this._getAllFaceLists();
    faceLists.splice(fIdx, 1);
    this._buildTopology(faceLists);
  }

  /**
   * Weld `v2` into `v1` (move v1 to midpoint, redirect all v2 edges to v1).
   * Degenerate faces (faces with repeated vertex indices) are removed.
   */
  weldVertices(v1: number, v2: number): void {
    if (v1 === v2 || v1 < 0 || v2 < 0) return;
    if (v1 >= this.vertices.length || v2 >= this.vertices.length) return;

    const a = this.vertices[v1], b = this.vertices[v2];
    a.x = (a.x + b.x) / 2;
    a.y = (a.y + b.y) / 2;
    a.z = (a.z + b.z) / 2;

    const faceLists = this._getAllFaceLists();
    // old vertex index → new (seam / sharp flags follow their vertices across the rebuild)
    const remap = new Int32Array(this.vertices.length);
    for (let i = 0; i < remap.length; i++) { const r = i === v2 ? v1 : i; remap[i] = r > v2 ? r - 1 : r; }

    // Replace all v2 references with v1 (in place — each face keeps its corner UVs, corner for corner)
    for (const f of faceLists) {
      for (let k = 0; k < f.length; k++) {
        if (f[k] === v2) f[k] = v1;
      }
    }

    // Remove vertex v2 and remap indices above v2
    this.vertices.splice(v2, 1);
    if (v2 < v1) v1--;  // v1 index shifts down if v2 < v1
    for (const f of faceLists) {
      for (let k = 0; k < f.length; k++) {
        if (f[k] > v2) f[k]--;
      }
    }

    // Remove degenerate faces
    const valid = faceLists.filter(f => new Set(f).size === f.length && f.length >= 3);
    this._buildTopology(valid, { remap });
  }

  /**
   * Insert a new edge loop through a chain of quad faces.
   * `halfEdgeIdx` identifies the edge to start from; `t` (0–1) controls the
   * lerp position of the new midpoint vertices along each cut edge.
   */
  loopCut(halfEdgeIdx: number, t = 0.5): void {
    const { halfEdges, vertices } = this;
    if (halfEdgeIdx < 0 || halfEdgeIdx >= halfEdges.length) return;

    // Helper: get canonical edge key and vertex pair for a half-edge
    const getEdgeVerts = (heIdx: number): { vA: number; vB: number; key: string } => {
      const vB = halfEdges[heIdx].vertex;
      const vA = halfEdges[halfEdges[heIdx].prev].vertex;
      const key = vA < vB ? `${vA},${vB}` : `${vB},${vA}`;
      return { vA, vB, key };
    };

    // Collect cut edges by traversing in both directions through quad faces
    const cutEdges = new Map<string, { vA: number; vB: number }>();
    const visitedFaces = new Set<number>();

    const traverse = (startHe: number): void => {
      let heIdx = startHe;
      // Guard against infinite loops
      let guard = 0;
      while (guard++ < 10000) {
        const he = halfEdges[heIdx];
        const fIdx = he.face;
        if (fIdx < 0 || fIdx >= this.faces.length) break;
        if (visitedFaces.has(fIdx)) break;
        const face = this.faces[fIdx];
        if (face.vertexCount !== 4) break;

        visitedFaces.add(fIdx);
        const { vA, vB, key } = getEdgeVerts(heIdx);
        cutEdges.set(key, { vA, vB });

        // In a quad, the opposite edge is two nexts away
        const oppositeHe = halfEdges[halfEdges[heIdx].next].next;
        const { vA: oA, vB: oB, key: oKey } = getEdgeVerts(oppositeHe);
        cutEdges.set(oKey, { vA: oA, vB: oB });

        // Cross to adjacent face via the opposite edge's twin
        const twinIdx = halfEdges[oppositeHe].twin;
        if (twinIdx < 0) break;
        heIdx = twinIdx;
      }
    };

    traverse(halfEdgeIdx);
    // Also traverse in the opposite direction
    const twinStart = halfEdges[halfEdgeIdx].twin;
    if (twinStart >= 0) traverse(twinStart);

    if (cutEdges.size === 0) return;

    // Create new midpoint vertices for each cut edge
    const edgeNewVert = new Map<string, number>();
    for (const [key, { vA, vB }] of cutEdges) {
      const va = vertices[vA], vb = vertices[vB];
      const midIdx = vertices.length;
      vertices.push({
        x: va.x + (vb.x - va.x) * t,
        y: va.y + (vb.y - va.y) * t,
        z: va.z + (vb.z - va.z) * t,
        color: [
          va.color[0] + (vb.color[0] - va.color[0]) * t,
          va.color[1] + (vb.color[1] - va.color[1]) * t,
          va.color[2] + (vb.color[2] - va.color[2]) * t,
          va.color[3] + (vb.color[3] - va.color[3]) * t,
        ] as [number, number, number, number],
        halfEdge: -1,
        uv: va.uv && vb.uv ? lerpUV(va.uv, vb.uv, t) : undefined,
      });
      edgeNewVert.set(key, midIdx);
    }

    const getNewVert = (va: number, vb: number): number | undefined =>
      edgeNewVert.get(va < vb ? `${va},${vb}` : `${vb},${va}`);

    // Rebuild face lists, splitting quads that have exactly 2 cut edges at opposite positions
    const faceLists = this._getAllFaceLists();
    const newFaceLists: FaceList[] = [];

    for (let fi = 0; fi < faceLists.length; fi++) {
      const f = faceLists[fi];
      if (f.length !== 4) {
        newFaceLists.push(f);
        continue;
      }
      const [a, b, c, d] = f;

      // Check which edges have new midpoints
      const M0 = getNewVert(a, b);  // edge 0: a→b
      const M1 = getNewVert(b, c);  // edge 1: b→c
      const M2 = getNewVert(c, d);  // edge 2: c→d
      const M3 = getNewVert(d, a);  // edge 3: d→a

      const hasCut02 = M0 !== undefined && M2 !== undefined;
      const hasCut13 = M1 !== undefined && M3 !== undefined;

      // Corner UV of a cut point on this face's edge i → j (the cut sits at t from the edge key's vA).
      const has = !!f.uvs;
      const U = (k: number): UV | undefined => this._fuv(f, k);
      const cutUV = (i: number, j: number): UV | undefined => {
        if (!has) return undefined;
        const e = cutEdges.get(f[i] < f[j] ? `${f[i]},${f[j]}` : `${f[j]},${f[i]}`)!;
        return lerpUV(U(i), U(j), e.vA === f[i] ? t : 1 - t);
      };

      if (hasCut02 && !hasCut13) {
        // Cut through edges 0 and 2: split into [a,M0,M2,d] and [M0,b,c,M2]
        const m0 = cutUV(0, 1), m2 = cutUV(2, 3);
        newFaceLists.push(faceList([a, M0!, M2!, d], has ? [U(0), m0, m2, U(3)] : null, f.smooth));
        newFaceLists.push(faceList([M0!, b, c, M2!], has ? [m0, U(1), U(2), m2] : null, f.smooth));
      } else if (hasCut13 && !hasCut02) {
        // Cut through edges 1 and 3: split into [a,b,M1,M3] and [M3,M1,c,d]
        const m1 = cutUV(1, 2), m3 = cutUV(3, 0);
        newFaceLists.push(faceList([a, b, M1!, M3!], has ? [U(0), U(1), m1, m3] : null, f.smooth));
        newFaceLists.push(faceList([M3!, M1!, c, d], has ? [m3, m1, U(2), U(3)] : null, f.smooth));
      } else {
        // Non-matching or boundary face: keep as-is
        newFaceLists.push(f);
      }
    }

    // A face the loop stops at (a triangle / n-gon on a cut edge) gains the edge's new vertex — no T-junction crack.
    const points = new Map<string, { idx: number; vA: number; t: number }>();
    for (const [key, { vA }] of cutEdges) points.set(key, { idx: edgeNewVert.get(key)!, vA, t });
    this._buildTopology(newFaceLists.map(f => this._insertEdgePoints(f, points)));
  }

  /**
   * `f` with the new vertex of every split edge it still has WHOLE inserted between the edge's ends (its corner UV
   * interpolated along the edge), so the faces beside a cut share the new vertex — every interior edge keeps its
   * twin. `points` maps the undirected edge key "lo,hi" → the new vertex at `t` from `vA`.
   */
  private _insertEdgePoints(f: FaceList, points: Map<string, { idx: number; vA: number; t: number }>): FaceList {
    const n = f.length;
    let changed = false;
    const verts: number[] = [];
    const uvs: Array<UV | undefined> = [];
    for (let k = 0; k < n; k++) {
      const a = f[k], b = f[(k + 1) % n];
      verts.push(a); uvs.push(this._fuv(f, k));
      const p = points.get(a < b ? `${a},${b}` : `${b},${a}`);
      if (p && p.idx !== a && p.idx !== b) {
        verts.push(p.idx);
        uvs.push(lerpUV(this._fuv(f, k), this._fuv(f, (k + 1) % n), p.vA === a ? p.t : 1 - p.t));
        changed = true;
      }
    }
    return changed ? faceList(verts, f.uvs ? uvs : null, f.smooth) : f;
  }

  /**
   * Dissolve the shared edge between two adjacent faces, merging them into one polygon.
   * `halfEdgeIdx` must be an interior half-edge (twin >= 0).
   */
  dissolveEdge(halfEdgeIdx: number): void {
    const { halfEdges } = this;
    if (halfEdgeIdx < 0 || halfEdgeIdx >= halfEdges.length) return;

    const he = halfEdges[halfEdgeIdx];
    if (he.twin < 0) return;
    const twin = halfEdges[he.twin];
    if (he.face === twin.face) return;  // same face (degenerate)

    const fIdx1 = he.face;
    const fIdx2 = twin.face;
    if (fIdx1 < 0 || fIdx2 < 0) return;

    const F1 = this._getFaceVerts(fIdx1);
    const F2 = this._getFaceVerts(fIdx2);
    const n1 = F1.length;
    const n2 = F2.length;

    const v_from = halfEdges[he.prev].vertex;
    const v_to = he.vertex;

    const k1 = F1.indexOf(v_from);
    const k2 = F2.indexOf(v_to);
    if (k1 < 0 || k2 < 0) return;

    const faceLists = this._getAllFaceLists();
    const L1 = faceLists[fIdx1], L2 = faceLists[fIdx2];

    // Build merged face:
    //   F1 part: starting at (k1+1)%n1, run n1 iterations → [v_to, ..., v_from]
    //   F2 part: starting at (k2+2)%n2, run n2-2 iterations → F2 excluding v_to and v_from
    const mergedVerts: number[] = [];
    const mergedUVs: Array<UV | undefined> = [];
    for (let i = 0; i < n1; i++) {
      const k = (k1 + 1 + i) % n1;
      mergedVerts.push(F1[k]); mergedUVs.push(this._fuv(L1, k));
    }
    for (let i = 0; i < n2 - 2; i++) {
      const k = (k2 + 2 + i) % n2;
      mergedVerts.push(F2[k]); mergedUVs.push(this._fuv(L2, k));
    }
    const merged = faceList(mergedVerts, L1.uvs || L2.uvs ? mergedUVs : null, L1.smooth);

    // Remove F1 and F2 (higher index first to preserve indices)
    const loIdx = Math.min(fIdx1, fIdx2);
    const hiIdx = Math.max(fIdx1, fIdx2);
    faceLists.splice(hiIdx, 1);
    faceLists.splice(loIdx, 1);

    faceLists.push(merged);
    this._buildTopology(faceLists);
  }

  /**
   * Bevel the edge identified by `halfEdgeIdx`, replacing it with a quad face strip.
   * `amount` is a [0–1] lerp fraction along each adjacent edge: 0 = no-op, 0.5 = midpoint.
   * Only works on interior edges (twin ≥ 0). Both neighbouring faces are updated in place.
   */
  bevelEdge(halfEdgeIdx: number, amount: number): void {
    const { halfEdges, vertices } = this;
    if (halfEdgeIdx < 0 || halfEdgeIdx >= halfEdges.length) return;

    const he = halfEdges[halfEdgeIdx];
    if (he.twin < 0) return;

    const fIdx1 = he.face;
    const fIdx2 = halfEdges[he.twin].face;
    if (fIdx1 < 0 || fIdx2 < 0) return;

    const v_from = halfEdges[he.prev].vertex;
    const v_to = he.vertex;

    const F1 = this._getFaceVerts(fIdx1);
    const F2 = this._getFaceVerts(fIdx2);
    const n1 = F1.length, n2 = F2.length;
    if (n1 < 3 || n2 < 3) return;

    // v_from is at k in F1, v_to is at (k+1)%n1
    // v_to   is at j in F2, v_from is at (j+1)%n2
    const k = F1.indexOf(v_from);
    const j = F2.indexOf(v_to);
    if (k < 0 || j < 0) return;

    const t = Math.max(0, Math.min(0.999, amount));

    const lerpV = (vIdxA: number, vIdxB: number): EditVertex => {
      const a = vertices[vIdxA], b = vertices[vIdxB];
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        color: [
          a.color[0] + (b.color[0] - a.color[0]) * t,
          a.color[1] + (b.color[1] - a.color[1]) * t,
          a.color[2] + (b.color[2] - a.color[2]) * t,
          a.color[3] + (b.color[3] - a.color[3]) * t,
        ] as [number, number, number, number],
        halfEdge: -1,
        uv: a.uv && b.uv ? lerpUV(a.uv, b.uv, t) : undefined,
      };
    };

    // Four new bevel vertices — two near each endpoint, one per adjacent face
    const A_prev_F1 = F1[(k + n1 - 1) % n1];  // neighbour of v_from in F1 (not v_to)
    const B_next_F1 = F1[(k + 2) % n1];         // neighbour of v_to  in F1 (not v_from)
    const B_prev_F2 = F2[(j + n2 - 1) % n2];    // neighbour of v_to  in F2 (not v_from)
    const A_next_F2 = F2[(j + 2) % n2];          // neighbour of v_from in F2 (not v_to)

    const A1_idx = vertices.length; vertices.push(lerpV(v_from, A_prev_F1));
    const B1_idx = vertices.length; vertices.push(lerpV(v_to,   B_next_F1));
    const B2_idx = vertices.length; vertices.push(lerpV(v_to,   B_prev_F2));
    const A2_idx = vertices.length; vertices.push(lerpV(v_from, A_next_F2));

    const faceLists = this._getAllFaceLists();
    const f1 = faceLists[fIdx1], f2 = faceLists[fIdx2];
    // Each face's corner UV slides with its corner (computed before the rewrite).
    const at = (f: FaceList, v: number): UV | undefined => this._fuv(f, f.indexOf(v));
    const uvA1 = lerpUV(at(f1, v_from), at(f1, A_prev_F1), t), uvB1 = lerpUV(at(f1, v_to), at(f1, B_next_F1), t);
    const uvB2 = lerpUV(at(f2, v_to), at(f2, B_prev_F2), t),   uvA2 = lerpUV(at(f2, v_from), at(f2, A_next_F2), t);

    // Rewrite F1: v_from → A1, v_to → B1
    for (let i = 0; i < f1.length; i++) {
      if (f1[i] === v_from) { f1[i] = A1_idx; if (f1.uvs) f1.uvs[i] = uvA1; }
      else if (f1[i] === v_to) { f1[i] = B1_idx; if (f1.uvs) f1.uvs[i] = uvB1; }
    }

    // Rewrite F2: v_to → B2, v_from → A2
    for (let i = 0; i < f2.length; i++) {
      if (f2[i] === v_to) { f2[i] = B2_idx; if (f2.uvs) f2.uvs[i] = uvB2; }
      else if (f2[i] === v_from) { f2[i] = A2_idx; if (f2.uvs) f2.uvs[i] = uvA2; }
    }

    // Bevel strip quad — winding produces outward normal along the chamfer
    faceLists.push(faceList([A1_idx, A2_idx, B2_idx, B1_idx], f1.uvs || f2.uvs ? [uvA1, uvA2, uvB2, uvB1] : null, f1.smooth));

    this._buildTopology(faceLists);
  }

  /**
   * Bevel (chamfer) the vertex `vIdx` — cut the corner off, replacing the single vertex with a small cap face.
   * One new vertex is created per incident edge (at `amount` [0–1] along the edge toward each neighbour); each
   * face using the vertex swaps it for its two cut-points, and a cap face closes the exposed corner. Works on a
   * closed corner (≥3 incident faces).
   */
  bevelVertex(vIdx: number, amount: number): void {
    const { vertices } = this;
    if (vIdx < 0 || vIdx >= vertices.length) return;
    const t = Math.max(0.001, Math.min(0.999, amount));
    const faceLists = this._getAllFaceLists();

    // Incident faces + the two neighbours flanking the vertex in each (prev before it, next after it).
    const incident: { fi: number; prev: number; next: number }[] = [];
    for (let fi = 0; fi < faceLists.length; fi++) {
      const f = faceLists[fi];
      const at = f.indexOf(vIdx);
      if (at < 0) continue;
      const n = f.length;
      incident.push({ fi, prev: f[(at + n - 1) % n], next: f[(at + 1) % n] });
    }
    if (incident.length < 3) return;   // not a proper closed corner

    // One new cut-vertex per neighbour edge (shared between the two faces on that edge).
    const V = vertices[vIdx];
    const cutForNeighbour = new Map<number, number>();
    const cutOf = (nIdx: number): number => {
      const existing = cutForNeighbour.get(nIdx);
      if (existing !== undefined) return existing;
      const b = vertices[nIdx];
      const idx = vertices.length;
      vertices.push({ x: V.x + (b.x - V.x) * t, y: V.y + (b.y - V.y) * t, z: V.z + (b.z - V.z) * t, color: [...V.color] as [number, number, number, number], halfEdge: -1,
        uv: V.uv && b.uv ? lerpUV(V.uv, b.uv, t) : undefined });
      cutForNeighbour.set(nIdx, idx);
      return idx;
    };
    for (const inc of incident) { cutOf(inc.prev); cutOf(inc.next); }

    // Replace the vertex in each face with its two cut-points (prev-side then next-side); the face's corner UV
    // splits the same way (slid toward each neighbour's corner UV).
    const cutUV = new Map<number, UV | undefined>();   // cut vertex → a corner UV for the cap
    let anyUV = false;
    for (const inc of incident) {
      const f = faceLists[inc.fi];
      const at = f.indexOf(vIdx);
      if (at < 0) continue;
      const n = f.length;
      const uP = lerpUV(this._fuv(f, at), this._fuv(f, (at + n - 1) % n), t);
      const uN = lerpUV(this._fuv(f, at), this._fuv(f, (at + 1) % n), t);
      f.splice(at, 1, cutOf(inc.prev), cutOf(inc.next));
      if (f.uvs) { f.uvs.splice(at, 1, uP, uN); anyUV = true; }
      if (!cutUV.has(cutOf(inc.prev))) cutUV.set(cutOf(inc.prev), uP);
      if (!cutUV.has(cutOf(inc.next))) cutUV.set(cutOf(inc.next), uN);
    }

    // Cap: chain prev→next around the neighbour fan into one ring, then reverse so it winds opposite to the
    // faces on the shared cut edges (front-facing outward).
    const nextOf = new Map<number, number>();
    for (const inc of incident) nextOf.set(inc.prev, inc.next);
    const ring: number[] = [];
    const seen = new Set<number>();
    let cur: number | undefined = incident[0].prev;
    while (cur !== undefined && !seen.has(cur)) { seen.add(cur); ring.push(cutOf(cur)); cur = nextOf.get(cur); }
    if (ring.length >= 3) {
      ring.reverse();
      faceLists.push(faceList(ring, anyUV ? ring.map(c => cutUV.get(c)) : null, faceLists[incident[0].fi].smooth));
    }

    this._buildTopology(faceLists);
  }

  // ── Knife cut ─────────────────────────────────────────────────────────────

  /**
   * Split faces along a knife cut.
   *
   * `faceCuts` is produced by the ShapeManager's screen-space projection step.
   * Each entry describes one face to split and the two edges that the knife crosses.
   *
   * - Edges are deduplicated by canonical key so adjacent faces share new midpoint vertices.
   * - Faces with fewer than 2 cuts are skipped (knife didn't fully cross them).
   * - The two resulting sub-faces are guaranteed to have ≥ 3 vertices each.
   */
  knifeCut(faceCuts: Array<{
    faceIdx: number;
    cuts: Array<{ vA: number; vB: number; t: number; edgeIdx: number }>;
  }>): void {
    if (faceCuts.length === 0) return;

    // Create new midpoint vertices — deduplicated by canonical edge key
    const edgeNewVert = new Map<string, number>();
    const points = new Map<string, { idx: number; vA: number; t: number }>();

    for (const { cuts } of faceCuts) {
      for (const { vA, vB, t } of cuts) {
        const key = vA < vB ? `${vA},${vB}` : `${vB},${vA}`;
        if (edgeNewVert.has(key)) continue;
        const va = this.vertices[vA], vb = this.vertices[vB];
        edgeNewVert.set(key, this.vertices.length);
        points.set(key, { idx: this.vertices.length, vA, t });
        this.vertices.push({
          x: va.x + (vb.x - va.x) * t,
          y: va.y + (vb.y - va.y) * t,
          z: va.z + (vb.z - va.z) * t,
          color: [
            va.color[0] + (vb.color[0] - va.color[0]) * t,
            va.color[1] + (vb.color[1] - va.color[1]) * t,
            va.color[2] + (vb.color[2] - va.color[2]) * t,
            va.color[3] + (vb.color[3] - va.color[3]) * t,
          ] as [number, number, number, number],
          uv: va.uv && vb.uv ? [
            va.uv[0] + (vb.uv[0] - va.uv[0]) * t,
            va.uv[1] + (vb.uv[1] - va.uv[1]) * t,
          ] as [number, number] : undefined,
          halfEdge: -1,
        });
      }
    }

    const getM = (vA: number, vB: number): number => {
      const key = vA < vB ? `${vA},${vB}` : `${vB},${vA}`;
      return edgeNewVert.get(key)!;
    };

    // Rebuild face lists, splitting faces that have exactly 2 cut edges
    const faceLists = this._getAllFaceLists();
    const cutMap = new Map<number, typeof faceCuts[0]['cuts']>();
    for (const { faceIdx, cuts } of faceCuts) {
      if (cuts.length >= 2) cutMap.set(faceIdx, cuts);
    }

    const newFaceLists: FaceList[] = [];
    for (let fi = 0; fi < faceLists.length; fi++) {
      const cuts = cutMap.get(fi);
      if (!cuts) { newFaceLists.push(faceLists[fi]); continue; }

      const fv = faceLists[fi];
      // Sort by edge index so i < j, take the first two
      const sorted = [...cuts].sort((a, b) => a.edgeIdx - b.edgeIdx).slice(0, 2);
      const i = sorted[0].edgeIdx, j = sorted[1].edgeIdx;
      const M1 = getM(sorted[0].vA, sorted[0].vB);
      const M2 = getM(sorted[1].vA, sorted[1].vB);

      // This face's corner UVs at the two cut points (lerped between ITS corners at the cut edge's ends).
      const cu = [...fv].map((_, k) => this._fuv(fv, k));
      const uvAt = (c: { vA: number; vB: number; t: number }): UV | undefined =>
        lerpUV(cu[fv.indexOf(c.vA)], cu[fv.indexOf(c.vB)], c.t);
      const u1 = uvAt(sorted[0]), u2 = uvAt(sorted[1]);
      const has = !!fv.uvs;

      // Face A: [v0..vi, M1, M2, v(j+1)..vN-1]
      const faceA = faceList([...fv.slice(0, i + 1), M1, M2, ...fv.slice(j + 1)],
        has ? [...cu.slice(0, i + 1), u1, u2, ...cu.slice(j + 1)] : null, fv.smooth);
      // Face B: [M1, v(i+1)..vj, M2]
      const faceB = faceList([M1, ...fv.slice(i + 1, j + 1), M2], has ? [u1, ...cu.slice(i + 1, j + 1), u2] : null, fv.smooth);

      if (faceA.length >= 3) newFaceLists.push(faceA);
      if (faceB.length >= 3) newFaceLists.push(faceB);
    }

    // The faces across each cut edge (uncut, or cut elsewhere) take the new vertex too — the mesh stays closed.
    this._buildTopology(newFaceLists.map(f => this._insertEdgePoints(f, points)));
  }

  // ── UV unwrap ──────────────────────────────────────────────────────────────

  /**
   * Smart-project UV unwrap (box / triplanar mapping).
   * Each vertex receives a UV by projecting its position onto the 2D plane
   * perpendicular to the dominant axis of its averaged face normals.
   * All UVs are normalised into [0, 1] with a uniform scale (no stretching).
   * Undoable via the undo stack — call from MeshEditManager.autoUnwrap().
   */
  autoUnwrap(): void {
    const { vertices, faces } = this;
    if (vertices.length === 0) return;

    // Accumulate face normals into each vertex
    const accNx = new Float64Array(vertices.length);
    const accNy = new Float64Array(vertices.length);
    const accNz = new Float64Array(vertices.length);

    for (let fi = 0; fi < faces.length; fi++) {
      const [nx, ny, nz] = this._computeFaceNormal(fi);
      for (const vi of this._getFaceVerts(fi)) {
        accNx[vi] += nx; accNy[vi] += ny; accNz[vi] += nz;
      }
    }

    // Project each vertex using its dominant normal axis
    const rawUvs: Array<[number, number]> = vertices.map((v, vi) => {
      const ax = Math.abs(accNx[vi]);
      const ay = Math.abs(accNy[vi]);
      const az = Math.abs(accNz[vi]);
      if (ay >= ax && ay >= az) return [v.x, v.z];   // top / bottom → XZ
      if (ax >= ay && ax >= az) return [v.z, v.y];   // left / right → ZY
      return [v.x, v.y];                              // front / back  → XY
    });

    // Normalise to [0, 1] with uniform scale (preserves aspect ratio)
    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;
    for (const [u, v] of rawUvs) {
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const scale = Math.max(maxU - minU, maxV - minV) || 1;

    for (let i = 0; i < vertices.length; i++) {
      vertices[i].uv = [
        (rawUvs[i][0] - minU) / scale,
        (rawUvs[i][1] - minV) / scale,
      ];
    }
    this._clearCornerUVs();   // one UV per vertex again (continuous)
  }

  /**
   * Give every face corner its OWN UV (copied from what it shows now), so each UV island can be laid out on its own
   * by unwrapIslands() / packUVIslands() even where islands share a vertex (a cube corner is shared by 3 islands).
   * UVs live per corner, so this changes NO topology: the mesh stays welded (dragging the corner still moves all
   * three faces) and the seam flags stay. No-op when there is a single island.
   */
  splitSeams(): void {
    const islands = this.computeUVIslands();
    if (islands.length <= 1) return;
    for (const island of islands) {
      for (const hi of island.cornerIndices) {
        const uv = this.cornerUV(hi);
        this.halfEdges[hi].uv = uv ? [uv[0], uv[1]] : undefined;
      }
    }
  }

  /**
   * Island-aware smart project: each UV island is projected independently onto
   * the plane perpendicular to its average face normal.  Islands will overlap
   * in UV space after this call — run `packUVIslands()` afterwards to separate them.
   */
  unwrapIslands(): void {
    const islands = this.computeUVIslands();
    for (const island of islands) {
      // Average face normal for this island
      let nx = 0, ny = 0, nz = 0;
      for (const fi of island.faceIndices) {
        const [fnx, fny, fnz] = this._computeFaceNormal(fi);
        nx += fnx; ny += fny; nz += fnz;
      }
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len; ny /= len; nz /= len;

      // Build a signed tangent frame from the (already-normalized) island
      // normal so faces are neither mirrored nor randomly rotated:
      //   • V (the UV "up" axis) = world-up projected onto the face plane, so
      //     a wall's texture reads upright. For near-horizontal faces (top /
      //     bottom) world-up is perpendicular and gives no usable direction —
      //     fall back to world -Z so those faces at least come out CONSISTENT
      //     run-to-run (their "up" is inherently ambiguous; paint them in 3D).
      //   • U (the UV "right" axis) = n × V. Using the *signed* normal here is
      //     what kills the old mirroring: +Z and -Z faces now get opposite U,
      //     so the back face is no longer a mirror image of the front.
      let upX = 0, upY = 1, upZ = 0;
      if (Math.abs(ny) > 0.999) { upX = 0; upY = 0; upZ = -1; }
      const dn = upX * nx + upY * ny + upZ * nz;
      let vX = upX - nx * dn, vY = upY - ny * dn, vZ = upZ - nz * dn;
      const vl = Math.sqrt(vX * vX + vY * vY + vZ * vZ) || 1;
      vX /= vl; vY /= vl; vZ /= vl;
      const uX = vY * nz - vZ * ny;
      const uY = vZ * nx - vX * nz;
      const uZ = vX * ny - vY * nx;

      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      const raw = new Map<number, [number, number]>();
      for (const vi of island.vertexIndices) {
        const v = this.vertices[vi];
        const u  = v.x * uX + v.y * uY + v.z * uZ;
        const vc = v.x * vX + v.y * vY + v.z * vZ;
        raw.set(vi, [u, vc]);
        if (u  < uMin) uMin = u;  if (u  > uMax) uMax = u;
        if (vc < vMin) vMin = vc; if (vc > vMax) vMax = vc;
      }
      const scale = Math.max(uMax - uMin, vMax - vMin) || 1;
      // Written per CORNER: a vertex shared with another island keeps that island's UV on its other corners.
      for (const hi of island.cornerIndices) {
        const [u, vc] = raw.get(this.halfEdges[hi].vertex)!;
        this.setCornerUV(hi, [(u - uMin) / scale, (vc - vMin) / scale]);
      }
    }
  }

  /**
   * Project every vertex onto the plane perpendicular to the normal of face
   * `faceIndex`. Useful as "Follow Active Face" — lets the user orient the
   * projection by selecting a well-aligned face first.
   */
  unwrapFollowActive(faceIndex: number): void {
    const [nx, ny, nz] = this._computeFaceNormal(faceIndex);
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    const raw: [number, number][] = this.vertices.map(v => {
      let u: number, vc: number;
      if (ay >= ax && ay >= az)      { u = v.x; vc = v.z; }
      else if (ax >= ay && ax >= az) { u = v.z; vc = v.y; }
      else                           { u = v.x; vc = v.y; }
      if (u  < uMin) uMin = u;  if (u  > uMax) uMax = u;
      if (vc < vMin) vMin = vc; if (vc > vMax) vMax = vc;
      return [u, vc];
    });
    const scale = Math.max(uMax - uMin, vMax - vMin) || 1;
    for (let i = 0; i < this.vertices.length; i++) {
      this.vertices[i].uv = [(raw[i][0] - uMin) / scale, (raw[i][1] - vMin) / scale];
    }
    this._clearCornerUVs();   // one projection for the whole mesh: per-vertex UVs
  }

  /**
   * Shelf-pack all UV islands into [0, 1] UV space with a uniform margin between
   * them.  Reads each island's current UV bounding box, re-positions it using
   * a left-to-right shelf algorithm, then scales the entire layout to [0, 1].
   *
   * Call after `unwrapIslands()` or any other unwrap that leaves islands
   * in overlapping positions.
   */
  packUVIslands(margin = 0.002): void {
    const islands = this.computeUVIslands();
    if (islands.length === 0) return;
    // Every corner holds its own UV first: moving one island must not drag another's through a shared vertex UV.
    for (const he of this.halfEdges) {
      if (he.face < 0 || he.uv) continue;
      const vu = this.vertices[he.vertex]?.uv;
      if (vu) he.uv = [vu[0], vu[1]];
    }

    // Build per-island UV bbox
    type Rect = { island: UVIsland; uMin: number; vMin: number; w: number; h: number };
    const rects: Rect[] = [];
    for (const island of islands) {
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (const hi of island.cornerIndices) {
        const uv = this.cornerUV(hi);
        if (!uv) continue;
        if (uv[0] < uMin) uMin = uv[0]; if (uv[0] > uMax) uMax = uv[0];
        if (uv[1] < vMin) vMin = uv[1]; if (uv[1] > vMax) vMax = uv[1];
      }
      if (uMin === Infinity) continue;
      rects.push({ island, uMin, vMin, w: uMax - uMin, h: vMax - vMin });
    }
    if (rects.length === 0) return;

    // Sort by height descending — tallest island starts each shelf
    rects.sort((a, b) => b.h - a.h);

    // Shelf width heuristic: sqrt(total area) × 1.05
    const totalArea = rects.reduce((s, r) => s + (r.w || margin) * (r.h || margin), 0);
    const shelfW = Math.sqrt(totalArea) * 1.05;

    // Shelf-pack
    type Placement = { rect: Rect; x: number; y: number };
    const placements: Placement[] = [];
    let curX = 0, curY = 0, shelfH = 0;
    let packW = 0;

    for (const rect of rects) {
      const rw = rect.w || margin;
      if (curX > 0 && curX + rw > shelfW) {
        curY += shelfH + margin;
        curX = 0;
        shelfH = 0;
      }
      placements.push({ rect, x: curX, y: curY });
      curX += rw + margin;
      if (rect.h > shelfH) shelfH = rect.h;
      if (curX > packW) packW = curX;
    }
    const packH = curY + shelfH;

    // Scale entire layout to [0, 1] uniformly
    const scale = Math.max(packW, packH) || 1;
    // Move every corner of the island (read all first: a vertex's corners may share the vertex-UV fallback).
    for (const { rect, x, y } of placements) {
      const du = x - rect.uMin;
      const dv = y - rect.vMin;
      const cur = rect.island.cornerIndices.map(hi => this.cornerUV(hi));
      rect.island.cornerIndices.forEach((hi, i) => {
        const uv = cur[i];
        if (uv) this.setCornerUV(hi, [(uv[0] + du) / scale, (uv[1] + dv) / scale]);
      });
    }
  }

  // ── Corner UVs ────────────────────────────────────────────────────────────

  /** The UV a face corner shows: half-edge `hi` = the corner at its destination vertex in its face. Its own UV, else
   *  the vertex's (undefined = none). */
  cornerUV(hi: number): [number, number] | undefined {
    const he = this.halfEdges[hi];
    if (!he) return undefined;
    return he.uv ?? this.vertices[he.vertex]?.uv;
  }

  /** Set a face corner's own UV. Also writes the vertex fallback (`vertex.uv`, last write wins) so per-vertex
   *  readers — the UV editor's "never unwrapped?" check — see the mesh as unwrapped. */
  setCornerUV(hi: number, uv: [number, number]): void {
    const he = this.halfEdges[hi];
    if (!he) return;
    he.uv = [uv[0], uv[1]];
    const v = this.vertices[he.vertex];
    if (v) v.uv = [uv[0], uv[1]];
  }

  /** True when some corner has its own UV (a welded mesh with seams; false = per-vertex UVs only). */
  hasCornerUVs(): boolean {
    for (const he of this.halfEdges) if (he.uv) return true;
    return false;
  }

  /** Map every UV (vertex fallbacks and corner UVs) through `fn` — e.g. a V flip. */
  mapUVs(fn: (u: number, v: number) => [number, number]): void {
    for (const v of this.vertices) if (v.uv) v.uv = fn(v.uv[0], v.uv[1]);
    for (const he of this.halfEdges) if (he.uv) he.uv = fn(he.uv[0], he.uv[1]);
  }

  private _clearCornerUVs(): void {
    for (const he of this.halfEdges) he.uv = undefined;
  }

  // ── Shading ───────────────────────────────────────────────────────────────

  /** Shade the given faces smooth (corner normals averaged across non-sharp edges) or flat. */
  setFacesSmooth(fIdxSet: Iterable<number>, smooth: boolean): void {
    for (const fi of fIdxSet) { const f = this.faces[fi]; if (f) f.smooth = smooth || undefined; }
  }

  /** Mark / clear half-edges (and their twins) as sharp (hard) edges. */
  setSharpEdges(halfEdgeIndices: number[], sharp: boolean): void {
    for (const hi of halfEdgeIndices) {
      const he = this.halfEdges[hi];
      if (!he) continue;
      he.isSharp = sharp || undefined;
      if (he.twin >= 0) this.halfEdges[he.twin].isSharp = sharp || undefined;
    }
  }

  // ── Vertex colors ─────────────────────────────────────────────────────────

  paintVertexColor(vIdx: number, r: number, g: number, b: number, a: number): void {
    const v = this.vertices[vIdx];
    if (v) v.color = [r, g, b, a];
  }

  paintFaceColor(fIdx: number, r: number, g: number, b: number, a: number): void {
    for (const vi of this._getFaceVerts(fIdx)) {
      this.vertices[vi].color = [r, g, b, a];
    }
  }

  /**
   * Bridge two open edge loops by filling the gap with a ring of quads.
   *
   * `loopA` and `loopB` are ordered vertex-index arrays of equal length (n ≥ 2).
   * Each successive pair (loopA[i], loopA[i+1], loopB[i+1], loopB[i]) becomes one
   * quad face. The loops are treated as open (the last pair wraps i+1 back to 0),
   * so both loops must be closed rings for a watertight bridge.
   *
   * Returns false if lengths differ, are < 2, or any index is out of range.
   */
  bridgeEdgeLoops(loopA: number[], loopB: number[]): boolean {
    const n = loopA.length;
    if (n !== loopB.length || n < 2) return false;
    const vCount = this.vertices.length;
    for (const vi of [...loopA, ...loopB]) {
      if (vi < 0 || vi >= vCount) return false;
    }
    const faceLists = this._getAllFaceLists();
    for (let i = 0; i < n; i++) {
      faceLists.push([loopA[i], loopA[(i + 1) % n], loopB[(i + 1) % n], loopB[i]]);
    }
    this._buildTopology(faceLists);
    return true;
  }

  // ── Multi-select operations ───────────────────────────────────────────────

  /** Extrude multiple faces along their individual normals. Interior shared edges produce no side quad. */
  extrudeFaces(fIdxSet: Set<number>, distance: number): void {
    const faceLists = this._getAllFaceLists();
    const origFaceVerts = new Map<number, number[]>();
    const origFace = new Map<number, FaceList>();
    for (const fi of fIdxSet) {
      if (fi >= 0 && fi < faceLists.length) { origFaceVerts.set(fi, [...faceLists[fi]]); origFace.set(fi, faceLists[fi]); }
    }

    // Identify interior edges (shared by two selected faces)
    const edgeFaceCount = new Map<string, number>();
    for (const fv of origFaceVerts.values()) {
      const n = fv.length;
      for (let k = 0; k < n; k++) {
        const a = fv[k], b = fv[(k + 1) % n];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        edgeFaceCount.set(key, (edgeFaceCount.get(key) ?? 0) + 1);
      }
    }
    const interiorEdges = new Set<string>(
      [...edgeFaceCount.entries()].filter(([, c]) => c >= 2).map(([k]) => k),
    );

    const faceNewVerts = new Map<number, number[]>();
    for (const [fi, fv] of origFaceVerts) {
      const normal = this._computeFaceNormal(fi);
      const newBase = this.vertices.length;
      for (const vi of fv) {
        const v = this.vertices[vi];
        this.vertices.push({
          x: v.x + normal[0] * distance,
          y: v.y + normal[1] * distance,
          z: v.z + normal[2] * distance,
          color: [...v.color] as [number, number, number, number],
          halfEdge: -1,
          uv: v.uv ? [v.uv[0], v.uv[1]] : undefined,
        });
      }
      const newVerts = fv.map((_, k) => newBase + k);
      faceNewVerts.set(fi, newVerts);
      const src = origFace.get(fi)!;
      faceLists[fi] = faceList(newVerts, src.uvs, src.smooth);
    }

    for (const [fi, fv] of origFaceVerts) {
      const newVerts = faceNewVerts.get(fi)!;
      const src = origFace.get(fi)!;
      const n = fv.length;
      for (let k = 0; k < n; k++) {
        const a = fv[k], b = fv[(k + 1) % n];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (interiorEdges.has(key)) continue;
        const ua = this._fuv(src, k), ub = this._fuv(src, (k + 1) % n);
        faceLists.push(faceList([a, b, newVerts[(k + 1) % n], newVerts[k]], src.uvs ? [ua, ub, ub, ua] : null, src.smooth));
      }
    }
    this._buildTopology(faceLists);
  }

  /** Inset multiple faces toward their centroids. Each face is inset independently. */
  insetFaces(fIdxSet: Set<number>, amount: number): void {
    const faceLists = this._getAllFaceLists();
    for (const fi of fIdxSet) {
      if (fi < 0 || fi >= faceLists.length) continue;
      this._insetInto(faceLists, fi, amount);
    }
    this._buildTopology(faceLists);
  }

  /** Delete all faces in the set. */
  deleteFaces(fIdxSet: Set<number>): void {
    const faceLists = this._getAllFaceLists().filter((_, fi) => !fIdxSet.has(fi));
    this._buildTopology(faceLists);
  }

  /** Reverse the vertex winding of each face in the set, flipping its normal (corner UVs reverse with it). */
  flipFaces(fIdxSet: Set<number>): void {
    const faceLists = this._getAllFaceLists();
    for (const fi of fIdxSet) {
      if (fi < 0 || fi >= faceLists.length) continue;
      const f = faceLists[fi];
      faceLists[fi] = faceList([...f].reverse(), f.uvs ? [...f.uvs].reverse() : null, f.smooth);
    }
    this._buildTopology(faceLists);
  }

  /**
   * Weld all vertices within `threshold` distance of each other.
   * Returns the number of vertices removed.
   */
  mergeByDistance(threshold: number): number {
    const { vertices } = this;
    if (threshold <= 0 || vertices.length === 0) return 0;

    // Spatial hash bucketing
    const buckets = new Map<string, number[]>();
    const cellKey = (v: { x: number; y: number; z: number }) =>
      `${Math.floor(v.x / threshold)},${Math.floor(v.y / threshold)},${Math.floor(v.z / threshold)}`;
    for (let i = 0; i < vertices.length; i++) {
      const k = cellKey(vertices[i]);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(i);
    }

    // Build remap: each vertex maps to its canonical representative
    const remap = Array.from({ length: vertices.length }, (_, i) => i);
    for (let i = 0; i < vertices.length; i++) {
      if (remap[i] !== i) continue; // already remapped
      const vi = vertices[i];
      const cx = Math.floor(vi.x / threshold), cy = Math.floor(vi.y / threshold), cz = Math.floor(vi.z / threshold);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const bucket = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const vj = vertices[j];
          const d = Math.sqrt((vi.x - vj.x) ** 2 + (vi.y - vj.y) ** 2 + (vi.z - vj.z) ** 2);
          if (d <= threshold) remap[j] = i;
        }
      }
    }

    // Move representatives to cluster centroids
    const clusterSums = new Map<number, { x: number; y: number; z: number; n: number }>();
    for (let i = 0; i < vertices.length; i++) {
      const rep = remap[i];
      const s = clusterSums.get(rep) ?? { x: 0, y: 0, z: 0, n: 0 };
      s.x += vertices[i].x; s.y += vertices[i].y; s.z += vertices[i].z; s.n++;
      clusterSums.set(rep, s);
    }
    for (const [rep, s] of clusterSums) {
      if (s.n > 1) { vertices[rep].x = s.x / s.n; vertices[rep].y = s.y / s.n; vertices[rep].z = s.z / s.n; }
    }

    // Remap + filter degenerate faces (corner UVs ride along: merging positions never merges UVs)
    const faceLists = this._getAllFaceLists()
      .map(f => remapFace(f, vi => remap[vi]))
      .filter(f => new Set(f).size >= 3 && new Set(f).size === f.length);

    // Compact vertex array (remove unmapped vertices)
    const usedSet = new Set<number>();
    for (const f of faceLists) for (const vi of f) usedSet.add(vi);
    const oldToNew: number[] = new Array(vertices.length).fill(-1);
    const newVerts: EditVertex[] = [];
    for (let i = 0; i < vertices.length; i++) {
      if (usedSet.has(i)) { oldToNew[i] = newVerts.length; newVerts.push(vertices[i]); }
    }
    const removed = vertices.length - newVerts.length;
    this.vertices = newVerts;
    this._buildTopology(faceLists.map(f => remapFace(f, vi => oldToNew[vi])), { remap: remap.map(r => oldToNew[r]) });
    return removed;
  }

  /**
   * Subdivide face `fIdx` into n quads by inserting a center vertex and per-edge midpoints.
   * The midpoint of each edge is deduplicated by edge key so adjacent faces can share them
   * in future subdivide calls.
   */
  subdivideFace(fIdx: number): void {
    const faceLists = this._getAllFaceLists();
    if (fIdx < 0 || fIdx >= faceLists.length) return;
    const fv = faceLists[fIdx];
    const n = fv.length;
    if (n < 3) return;

    // Center vertex
    let cx = 0, cy = 0, cz = 0;
    let cr = 0, cg = 0, cb = 0, ca = 0;
    for (const vi of fv) {
      const v = this.vertices[vi];
      cx += v.x / n; cy += v.y / n; cz += v.z / n;
      cr += v.color[0] / n; cg += v.color[1] / n; cb += v.color[2] / n; ca += v.color[3] / n;
    }
    const centerIdx = this.vertices.length;
    this.vertices.push({ x: cx, y: cy, z: cz, color: [cr, cg, cb, ca], halfEdge: -1 });

    // Edge midpoints
    const edgeMidMap = new Map<string, number>();
    const edgeMids: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = fv[k], b = fv[(k + 1) % n];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeMidMap.has(key)) {
        const va = this.vertices[a], vb = this.vertices[b];
        const midIdx = this.vertices.length;
        this.vertices.push({
          x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2, z: (va.z + vb.z) / 2,
          color: [
            (va.color[0] + vb.color[0]) / 2, (va.color[1] + vb.color[1]) / 2,
            (va.color[2] + vb.color[2]) / 2, (va.color[3] + vb.color[3]) / 2,
          ],
          halfEdge: -1,
        });
        edgeMidMap.set(key, midIdx);
      }
      edgeMids.push(edgeMidMap.get(key)!);
    }

    // Replace face with n new quads: [v[k], edgeMid[k], center, edgeMid[(k-1+n)%n]] (corner UVs interpolated)
    const cu = fv.map((_, k) => this._fuv(fv, k));
    const cC = avgUV(cu);
    const has = !!fv.uvs;
    faceLists.splice(fIdx, 1);
    // The neighbours across each split edge take its midpoint (they become n-gons) — no T-junction crack.
    const points = new Map<string, { idx: number; vA: number; t: number }>();
    for (const [key, idx] of edgeMidMap) points.set(key, { idx, vA: +key.slice(0, key.indexOf(',')), t: 0.5 });
    for (let i = 0; i < faceLists.length; i++) faceLists[i] = this._insertEdgePoints(faceLists[i], points);
    for (let k = 0; k < n; k++) {
      const kp = (k - 1 + n) % n;
      faceLists.push(faceList([fv[k], edgeMids[k], centerIdx, edgeMids[kp]],
        has ? [cu[k], lerpUV(cu[k], cu[(k + 1) % n], 0.5), cC, lerpUV(cu[kp], cu[k], 0.5)] : null, fv.smooth));
    }
    this._buildTopology(faceLists);
  }

  /**
   * Cap an open boundary loop starting at `boundaryHalfEdgeIdx`.
   * `boundaryHalfEdgeIdx` must have twin === -1.
   * Returns the new face index, or -1 on failure.
   */
  fillHole(boundaryHalfEdgeIdx: number): number {
    const { halfEdges, vertices } = this;
    if (boundaryHalfEdgeIdx < 0 || boundaryHalfEdgeIdx >= halfEdges.length) return -1;
    if (halfEdges[boundaryHalfEdgeIdx].twin !== -1) return -1;

    const loopVerts: number[] = [];
    let heIdx = boundaryHalfEdgeIdx;
    let guard = 0;

    while (guard++ < 10000) {
      loopVerts.push(halfEdges[heIdx].vertex);
      const v = halfEdges[heIdx].vertex;
      const vertHe = vertices[v]?.halfEdge ?? -1;
      if (vertHe < 0) return -1;

      // Find outgoing boundary half-edge from v (rotate around v)
      let nextHe = -1;
      let cur = vertHe;
      let g2 = 0;
      do {
        if (halfEdges[cur].twin === -1) { nextHe = cur; break; }
        cur = halfEdges[halfEdges[cur].twin].next;
        if (++g2 > 1000) break;
      } while (cur !== vertHe);

      if (nextHe < 0) return -1;
      heIdx = nextHe;
      if (heIdx === boundaryHalfEdgeIdx) break;
    }

    if (loopVerts.length < 3) return -1;
    const faceLists = this._getAllFaceLists();
    const newFaceIdx = faceLists.length;
    // The loop was collected following the surrounding faces' boundary half-edges (which run
    // CCW around THOSE faces). A cap built in that same order winds inward — its half-edges
    // would duplicate the existing directions instead of twinning them, and its normal would
    // point into the mesh (black/inside-out cap). Reverse so the cap faces outward.
    faceLists.push(loopVerts.reverse());
    this._buildTopology(faceLists);
    return newFaceIdx;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getFaceCenter(fIdx: number): [number, number, number] {
    const verts = this._getFaceVerts(fIdx);
    const n = verts.length;
    if (n === 0) return [0, 0, 0];
    let x = 0, y = 0, z = 0;
    for (const vi of verts) { x += this.vertices[vi].x / n; y += this.vertices[vi].y / n; z += this.vertices[vi].z / n; }
    return [x, y, z];
  }

  getFaceNormal(fIdx: number): [number, number, number] {
    return this._computeFaceNormal(fIdx);
  }

  getFaceVertices(fIdx: number): number[] {
    return this._getFaceVerts(fIdx);
  }

  /** Returns [v_from, v_to] for the given half-edge, or null if out of range. */
  getHalfEdgeVertices(heIdx: number): [number, number] | null {
    const { halfEdges } = this;
    if (heIdx < 0 || heIdx >= halfEdges.length) return null;
    const v_to = halfEdges[heIdx].vertex;
    const v_from = halfEdges[halfEdges[heIdx].prev].vertex;
    return [v_from, v_to];
  }

  // ── Seams ─────────────────────────────────────────────────────────────────

  /** Mark half-edges (and their twins) as UV seams. Does not affect GPU geometry. */
  markSeams(halfEdgeIndices: number[]): void {
    for (const hi of halfEdgeIndices) {
      if (hi < 0 || hi >= this.halfEdges.length) continue;
      this.halfEdges[hi].isSeam = true;
      const twin = this.halfEdges[hi].twin;
      if (twin >= 0) this.halfEdges[twin].isSeam = true;
    }
  }

  /** Remove seam flag from half-edges (and their twins). */
  clearSeams(halfEdgeIndices: number[]): void {
    for (const hi of halfEdgeIndices) {
      if (hi < 0 || hi >= this.halfEdges.length) continue;
      this.halfEdges[hi].isSeam = false;
      const twin = this.halfEdges[hi].twin;
      if (twin >= 0) this.halfEdges[twin].isSeam = false;
    }
  }

  /** Remove all seams from the mesh. */
  clearAllSeams(): void {
    for (const he of this.halfEdges) he.isSeam = false;
  }

  /**
   * Auto-suggest seams by marking edges whose dihedral angle exceeds `thresholdDeg`.
   * Sharp creases are natural UV cut candidates — hard edges cause minimal distortion
   * when placed at seam boundaries.
   */
  suggestSeams(thresholdDeg = 60): void {
    const threshRad = thresholdDeg * Math.PI / 180;
    for (let hi = 0; hi < this.halfEdges.length; hi++) {
      const he = this.halfEdges[hi];
      if (he.twin < 0 || he.twin < hi) continue; // boundary or already processed
      const n1 = this._computeFaceNormal(he.face);
      const n2 = this._computeFaceNormal(this.halfEdges[he.twin].face);
      const dot = Math.max(-1, Math.min(1, n1[0]*n2[0] + n1[1]*n2[1] + n1[2]*n2[2]));
      if (Math.acos(dot) > threshRad) {
        he.isSeam = true;
        this.halfEdges[he.twin].isSeam = true;
      }
    }
  }

  /**
   * True when half-edge `hi` is an interior edge between two (near-)coplanar
   * faces — i.e. a **triangulation diagonal** with no geometric meaning, like the
   * diagonal that splits a flat quad into two triangles. The UV wireframe uses
   * this to HIDE such edges so each flat face reads as a single polygon instead
   * of a pair of triangles (a primitive becomes a triangle mesh when made
   * editable, which is why a cube face shows a diagonal). Boundary edges and
   * real creases (dihedral angle > thresholdDeg) return false.
   */
  isCoplanarInteriorEdge(hi: number, thresholdDeg = 1): boolean {
    const he = this.halfEdges[hi];
    if (!he || he.twin < 0 || he.face < 0) return false; // boundary edge → keep
    const fb = this.halfEdges[he.twin].face;
    if (fb < 0) return false;
    const n1 = this._computeFaceNormal(he.face);
    const n2 = this._computeFaceNormal(fb);
    const dot = Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]));
    return Math.acos(dot) <= thresholdDeg * Math.PI / 180;
  }

  // ── UV Islands ────────────────────────────────────────────────────────────

  /**
   * Decompose the mesh into UV islands — connected components of faces where
   * connectivity is defined by non-seam interior edges.
   *
   * Two adjacent faces are in the same island if the half-edge between them is
   * NOT a seam. Boundary half-edges (twin === -1) never cross, so boundary
   * faces are isolated from their neighbours across open edges.
   *
   * Results are recomputed on every call. Cache externally if calling each frame.
   */
  computeUVIslands(): UVIsland[] {
    const { faces, halfEdges, vertices } = this;
    const visited = new Uint8Array(faces.length);
    const islands: UVIsland[] = [];

    for (let startFace = 0; startFace < faces.length; startFace++) {
      if (visited[startFace]) continue;

      // Flood-fill from startFace over non-seam interior edges
      const faceIndices: number[] = [];
      const stack = [startFace];
      visited[startFace] = 1;

      while (stack.length > 0) {
        const fi = stack.pop()!;
        faceIndices.push(fi);

        // Walk all half-edges of this face
        let hi = faces[fi].halfEdge;
        const startHi = hi;
        let guard = 0;
        do {
          const he = halfEdges[hi];
          // Cross to twin face if: edge is interior (twin >= 0), not a seam, UV-continuous (both faces show the
          // same UVs at both ends — corners whose UVs differ are a cut even without a seam flag), not yet visited
          if (he.twin >= 0 && !he.isSeam && this._uvContinuous(hi)) {
            const twinFace = halfEdges[he.twin].face;
            if (twinFace >= 0 && !visited[twinFace]) {
              visited[twinFace] = 1;
              stack.push(twinFace);
            }
          }
          hi = he.next;
          if (++guard > 1000) break;
        } while (hi !== startHi);
      }

      // Collect unique vertices + the corners of this island
      const vertSet = new Set<number>();
      const cornerIndices: number[] = [];
      for (const fi of faceIndices) {
        let hi = faces[fi].halfEdge;
        const startHi = hi;
        let guard = 0;
        do {
          vertSet.add(halfEdges[hi].vertex);
          cornerIndices.push(hi);
          hi = halfEdges[hi].next;
          if (++guard > 1000) break;
        } while (hi !== startHi);
      }
      const vertexIndices = [...vertSet];

      // Compute UV bounding box (over the island's corners)
      let uMin = Infinity, vMin = Infinity, uMax = -Infinity, vMax = -Infinity;
      let hasUV = false;
      for (const hi of cornerIndices) {
        const uv = this.cornerUV(hi);
        if (uv) {
          hasUV = true;
          if (uv[0] < uMin) uMin = uv[0];
          if (uv[1] < vMin) vMin = uv[1];
          if (uv[0] > uMax) uMax = uv[0];
          if (uv[1] > vMax) vMax = uv[1];
        }
      }
      const uvBounds: [number, number, number, number] = hasUV
        ? [uMin, vMin, uMax, vMax]
        : [0, 0, 0, 0];

      // Compute approximate 3D world area (sum of triangle areas in object space)
      let worldArea = 0;
      for (const fi of faceIndices) {
        const fv = this._getFaceVerts(fi);
        if (fv.length < 3) continue;
        const v0 = vertices[fv[0]];
        // Fan-triangulate and sum triangle areas
        for (let k = 1; k < fv.length - 1; k++) {
          const a = vertices[fv[k]];
          const b = vertices[fv[k + 1]];
          // Cross product of (a - v0) × (b - v0), magnitude = 2 × area
          const ax = a.x - v0.x, ay = a.y - v0.y, az = a.z - v0.z;
          const bx = b.x - v0.x, by = b.y - v0.y, bz = b.z - v0.z;
          const cx = ay * bz - az * by;
          const cy = az * bx - ax * bz;
          const cz = ax * by - ay * bx;
          worldArea += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
        }
      }

      islands.push({ id: islands.length, faceIndices, vertexIndices, cornerIndices, uvBounds, worldArea });
    }

    return islands;
  }

  /** True when the faces on both sides of interior half-edge `hi` show the same UV at both of its ends. */
  private _uvContinuous(hi: number): boolean {
    const he = this.halfEdges[hi];
    if (he.twin < 0) return false;
    const tw = this.halfEdges[he.twin];
    // he: a → b in face F (corner b = he, corner a = he.prev); twin: b → a in G (corner a = twin, corner b = twin.prev)
    return sameUV(this.cornerUV(he.prev), this.cornerUV(he.twin)) && sameUV(this.cornerUV(hi), this.cornerUV(tw.prev));
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  /**
   * Snapshot (undo) / persistence form. `faces` = vertex loops (each face's first corner first — stable across a
   * round trip); `cornerUVs[f]` = that face's corner UVs flattened [u0, v0, u1, v1, …] (null pairs = the vertex's
   * UV; the whole entry null = per-vertex UVs), present only when some corner has its own UV; `smoothFaces` = the
   * smooth-shaded face indices; `seamEdges` / `sharpEdges` = vertex pairs. Vertex `color` is omitted when default.
   * Older snapshots (no cornerUVs / smoothFaces / sharpEdges) load as per-vertex UVs, flat — exactly as before.
   */
  toJSON(): object {
    const lists = this._getAllFaceLists();
    const anyCorner = lists.some(f => !!f.uvs);
    const smoothFaces: number[] = [];
    lists.forEach((f, fi) => { if (f.smooth) smoothFaces.push(fi); });
    const sharpEdges = this._flagPairs('isSharp');
    return {
      vertices: this.vertices.map(v => {
        const c = v.color;
        const isDefault = c[0] === 0.8 && c[1] === 0.8 && c[2] === 0.8 && c[3] === 1;
        return isDefault ? { x: v.x, y: v.y, z: v.z, uv: v.uv } : { x: v.x, y: v.y, z: v.z, color: c, uv: v.uv };
      }),
      faces: lists.map(f => [...f]),
      ...(anyCorner ? { cornerUVs: lists.map(f => f.uvs ? f.uvs.flatMap(u => (u ? [u[0], u[1]] : [null, null])) : null) } : {}),
      ...(smoothFaces.length ? { smoothFaces } : {}),
      seamEdges: this._flagPairs('isSeam'),
      ...(sharpEdges.length ? { sharpEdges } : {}),
      modifiers: this.modifiers.map(m => m.toJSON()),
      proportionalEditEnabled: this.proportionalEditEnabled,
      proportionalEditRadius: this.proportionalEditRadius,
      proportionalEditFalloff: this.proportionalEditFalloff,
    };
  }

  static fromJSON(data: any): EditMesh {
    const mesh = new EditMesh();
    mesh.vertices = (data.vertices ?? []).map((v: any) => ({
      x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0,
      color: v.color ? [v.color[0], v.color[1], v.color[2], v.color[3]] : [0.8, 0.8, 0.8, 1],
      halfEdge: -1,
      uv: v.uv ? [v.uv[0], v.uv[1]] : undefined,
    }));
    const rawFaces: number[][] = data.faces ?? [];
    const cornerUVs: Array<Array<number | null> | null> | undefined = data.cornerUVs;
    const smooth = new Set<number>(data.smoothFaces ?? []);
    const faceLists = rawFaces.map((f, fi) => {
      const flat = cornerUVs?.[fi];
      const uvs = flat ? f.map((_, k) => (flat[k * 2] == null || flat[k * 2 + 1] == null ? undefined : [flat[k * 2]!, flat[k * 2 + 1]!] as UV)) : null;
      return faceList([...f], uvs, smooth.has(fi));
    });
    mesh._buildTopology(faceLists, { keepFlags: false });

    // Restore seam / sharp edges by vertex pair.
    mesh._markPairs(data.seamEdges ?? [], 'isSeam');
    mesh._markPairs(data.sharpEdges ?? [], 'isSharp');

    mesh.proportionalEditEnabled = data.proportionalEditEnabled ?? false;
    mesh.proportionalEditRadius = data.proportionalEditRadius ?? 1.0;
    mesh.proportionalEditFalloff = data.proportionalEditFalloff ?? 'smooth';

    for (const m of data.modifiers ?? []) {
      if (m.type === 'mirror') {
        const mod = new MirrorModifier(m.axis ?? 'x', m.clipping ?? true);
        mod.enabled = m.enabled ?? true;
        mod.mergeThreshold = m.mergeThreshold ?? 0.001;
        mesh.modifiers.push(mod);
      } else if (m.type === 'subdivision') {
        const mod = new SubdivisionModifier(m.iterations ?? 1);
        mod.enabled = m.enabled ?? true;
        mesh.modifiers.push(mod);
      } else if (m.type === 'displace') {
        const mod = new DisplaceModifier({ strength: m.strength, frequency: m.frequency, seed: m.seed, octaves: m.octaves, direction: m.direction });
        mod.enabled = m.enabled ?? true;
        mesh.modifiers.push(mod);
      }
    }

    return mesh;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Build half-edge topology from face vertex lists. Clears existing topology. A {@link FaceList}'s corner UVs land
   * on the corners' half-edges and its `smooth` flag on the face. Seam / sharp flags of the previous topology are
   * carried over by VERTEX PAIR (an edge that still exists keeps them); an op that renumbers vertices passes
   * `remap` (old index → new, −1 = removed), and a caller replacing the mesh wholesale passes `keepFlags: false`.
   * Each face's `halfEdge` is the one ending at its first listed vertex, so the face reads back in the same order.
   */
  _buildTopology(faceLists: number[][], opts: { remap?: ArrayLike<number>; keepFlags?: boolean } = {}): void {
    let flags: Map<string, number> | null = null;
    if (opts.keepFlags !== false && this.halfEdges.length > 0) {
      const remap = opts.remap;
      for (const he of this.halfEdges) {
        if (!he.isSeam && !he.isSharp) continue;
        let a = this.halfEdges[he.prev]?.vertex ?? -1, b = he.vertex;
        if (remap) { a = a >= 0 ? remap[a] ?? -1 : -1; b = remap[b] ?? -1; }
        if (a < 0 || b < 0 || a === b) continue;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        (flags ??= new Map()).set(key, (flags.get(key) ?? 0) | (he.isSeam ? 1 : 0) | (he.isSharp ? 2 : 0));
      }
    }

    this.halfEdges = [];
    this.faces = [];
    for (const v of this.vertices) v.halfEdge = -1;

    const edgeMap = new Map<string, number>();

    for (let fi = 0; fi < faceLists.length; fi++) {
      const verts = faceLists[fi] as FaceList;
      const n = verts.length;
      const heStart = this.halfEdges.length;
      const uvs = verts.uvs;

      this.faces.push({ halfEdge: n > 0 ? heStart + n - 1 : heStart, vertexCount: n, ...(verts.smooth ? { smooth: true } : {}) });

      for (let k = 0; k < n; k++) {
        const from = verts[k];
        const to = verts[(k + 1) % n];
        const heIdx = this.halfEdges.length;
        const uv = uvs?.[(k + 1) % n];   // this half-edge ends at corner k+1

        this.halfEdges.push({
          vertex: to,
          twin: -1,
          next: heStart + (k + 1) % n,
          prev: heStart + (k + n - 1) % n,
          face: fi,
          isSeam: false,
          ...(uv ? { uv: [uv[0], uv[1]] as UV } : {}),
        });

        // Store any outgoing half-edge for this vertex
        if (from >= 0 && from < this.vertices.length) {
          this.vertices[from].halfEdge = heIdx;
        }

        edgeMap.set(`${from},${to}`, heIdx);
      }
    }

    // Link twin half-edges
    for (const [key, heIdx] of edgeMap) {
      const comma = key.indexOf(',');
      const from = +key.slice(0, comma);
      const to = +key.slice(comma + 1);
      const twinIdx = edgeMap.get(`${to},${from}`);
      if (twinIdx !== undefined && this.halfEdges[heIdx].twin === -1) {
        this.halfEdges[heIdx].twin = twinIdx;
        this.halfEdges[twinIdx].twin = heIdx;
      }
    }

    if (flags) {
      for (const he of this.halfEdges) {
        const a = this.halfEdges[he.prev].vertex, b = he.vertex;
        const f = flags.get(a < b ? `${a},${b}` : `${b},${a}`);
        if (!f) continue;
        if (f & 1) he.isSeam = true;
        if (f & 2) he.isSharp = true;
      }
    }
  }

  private _getFaceVerts(fIdx: number): number[] {
    if (fIdx < 0 || fIdx >= this.faces.length) return [];
    const verts: number[] = [];
    let he = this.faces[fIdx].halfEdge;
    const start = he;
    let guard = 0;
    do {
      verts.push(this.halfEdges[he].vertex);
      he = this.halfEdges[he].next;
      if (++guard > 1000) break;
    } while (he !== start);
    return verts;
  }

  /** Face fIdx as a FaceList: its vertex loop + its own corner UVs (when any corner has one) + its shading. */
  private _getFaceList(fIdx: number): FaceList {
    const verts: number[] = [];
    const uvs: Array<UV | undefined> = [];
    let any = false;
    const face = this.faces[fIdx];
    if (!face) return verts as FaceList;
    let he = face.halfEdge;
    const start = he;
    let guard = 0;
    do {
      const h = this.halfEdges[he];
      verts.push(h.vertex);
      uvs.push(h.uv);
      if (h.uv) any = true;
      he = h.next;
      if (++guard > 1000) break;
    } while (he !== start);
    return faceList(verts, any ? uvs : null, face.smooth);
  }

  private _getAllFaceLists(): FaceList[] {
    return this.faces.map((_, fi) => this._getFaceList(fi));
  }

  /** Corner k of face list f: its own UV, else its vertex's. */
  private _fuv(f: FaceList | number[], k: number): UV | undefined {
    return (f as FaceList).uvs?.[k] ?? this.vertices[f[k]]?.uv;
  }

  /** Set `flag` on both halves of every edge between the given vertex pairs (undirected). */
  _markPairs(pairs: ReadonlyArray<readonly [number, number]>, flag: 'isSeam' | 'isSharp'): void {
    if (pairs.length === 0) return;
    const want = new Set<string>();
    for (const [a, b] of pairs) want.add(a < b ? `${a},${b}` : `${b},${a}`);
    for (const he of this.halfEdges) {
      const a = this.halfEdges[he.prev].vertex, b = he.vertex;
      if (want.has(a < b ? `${a},${b}` : `${b},${a}`)) he[flag] = true;
    }
  }

  /** The vertex pairs [from, to] of edges carrying `flag` (one entry per edge). */
  private _flagPairs(flag: 'isSeam' | 'isSharp'): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let hi = 0; hi < this.halfEdges.length; hi++) {
      const he = this.halfEdges[hi];
      if (!he[flag]) continue;
      if (he.twin >= 0 && he.twin < hi) continue; // skip the duplicate half
      out.push([this.halfEdges[he.prev].vertex, he.vertex]);
    }
    return out;
  }

  private _computeFaceNormal(fIdx: number): [number, number, number] {
    const verts = this._getFaceVerts(fIdx);
    if (verts.length < 3) return [0, 0, 1];
    const v0 = this.vertices[verts[0]];
    const v1 = this.vertices[verts[1]];
    const v2 = this.vertices[verts[2]];
    const ax = v1.x - v0.x, ay = v1.y - v0.y, az = v1.z - v0.z;
    const bx = v2.x - v0.x, by = v2.y - v0.y, bz = v2.z - v0.z;
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return [nx / nl, ny / nl, nz / nl];
  }

  private _toEditMeshData(): EditMeshData {
    return {
      vertices: this.vertices.map(v => ({ x: v.x, y: v.y, z: v.z, color: [...v.color] as [number, number, number, number] })),
      faces: this._getAllFaceLists().map(f => ({ verts: [...f], uvs: f.uvs, smooth: f.smooth })),
      uvs: this.vertices.map(v => v.uv ? [v.uv[0], v.uv[1]] as [number, number] : [0, 0]),
      sharpEdges: this._flagPairs('isSharp'),
    };
  }

  private _fromEditMeshData(data: EditMeshData): void {
    this.vertices = data.vertices.map((v, i) => ({
      x: v.x, y: v.y, z: v.z,
      color: [...v.color] as [number, number, number, number],
      halfEdge: -1,
      uv: data.uvs[i] && (data.uvs[i][0] !== 0 || data.uvs[i][1] !== 0)
        ? [data.uvs[i][0], data.uvs[i][1]] as [number, number]
        : undefined,
    }));
    this._buildTopology(data.faces.map(f => faceList([...f.verts], f.uvs, f.smooth)), { keepFlags: false });
    this._markPairs(data.sharpEdges ?? [], 'isSharp');
  }
}

function sameUV(a: UV | undefined, b: UV | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Math.abs(a[0] - b[0]) <= 1e-6 && Math.abs(a[1] - b[1]) <= 1e-6;
}

// ── Incremental compile (mobile-parity 7.3d: Mesh Edit vertex drag) ───────────

/** What one compile() was made from (see EditMesh.patchCompiledPositions; the patch itself is edit-mesh-render.ts). */
interface IncrementalCompile {
  geom: RenderGeometry;
  verts: EditVertex[]; faces: EditFace[]; halfEdges: EditHalfEdge[];
  nv: number; nf: number; nh: number;
  state: RenderState;
}

// ── Modifier helpers ──────────────────────────────────────────────────────────

function _weldOnAxis(mesh: EditMeshData, threshold: number, axis: 'x' | 'y' | 'z'): EditMeshData {
  const snap = (v: { x: number; y: number; z: number }): number => {
    if (axis === 'x') return v.x;
    if (axis === 'y') return v.y;
    return v.z;
  };

  const remap = new Array<number>(mesh.vertices.length);
  const kept: typeof mesh.vertices = [];
  const keptUvs: [number, number][] = [];
  const uvOf = (i: number): [number, number] => mesh.uvs?.[i] ?? [0, 0];
  for (let i = 0; i < mesh.vertices.length; i++) {
    remap[i] = i;
  }

  // Weld vertices that lie within `threshold` of the mirror plane (coord ≈ 0)
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (Math.abs(snap(mesh.vertices[i])) <= threshold) {
      // Find first already-kept vertex at the plane with the same position
      const existing = kept.findIndex(k =>
        Math.abs(k.x - mesh.vertices[i].x) < threshold &&
        Math.abs(k.y - mesh.vertices[i].y) < threshold &&
        Math.abs(k.z - mesh.vertices[i].z) < threshold,
      );
      if (existing >= 0) {
        remap[i] = existing;
        continue;
      }
      // Pin to plane
      const v = { ...mesh.vertices[i] };
      if (axis === 'x') v.x = 0;
      else if (axis === 'y') v.y = 0;
      else v.z = 0;
      remap[i] = kept.length;
      kept.push(v);
      keptUvs.push(uvOf(i));
    } else {
      remap[i] = kept.length;
      kept.push({ ...mesh.vertices[i] });
      keptUvs.push(uvOf(i));
    }
  }

  const faces = mesh.faces
    .map(f => ({ ...f, verts: f.verts.map(i => remap[i]) }))
    .filter(f => new Set(f.verts).size === f.verts.length);
  const sharpEdges = (mesh.sharpEdges ?? [])
    .map(([a, b]) => [remap[a], remap[b]] as [number, number])
    .filter(([a, b]) => a !== b);

  return {
    vertices: kept,
    faces,
    uvs: keptUvs,
    sharpEdges,
  };
}

function _catmullClark(mesh: EditMeshData): EditMeshData {
  const nVerts = mesh.vertices.length;

  // Build edge adjacency: edgeKey → { midIdx, faceIndices }
  const edgeToFaces = new Map<string, number[]>();
  const vertToFaces = new Array<number[]>(nVerts).fill(null as any).map(() => [] as number[]);

  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const verts = mesh.faces[fi].verts;
    for (const vi of verts) {
      vertToFaces[vi]?.push(fi);
    }
    for (let k = 0; k < verts.length; k++) {
      const a = verts[k], b = verts[(k + 1) % verts.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeToFaces.has(key)) edgeToFaces.set(key, []);
      edgeToFaces.get(key)!.push(fi);
    }
  }

  // Face points: centroid of each face
  const facePoints = mesh.faces.map(f => {
    const n = f.verts.length;
    let x = 0, y = 0, z = 0;
    for (const vi of f.verts) {
      x += mesh.vertices[vi].x / n;
      y += mesh.vertices[vi].y / n;
      z += mesh.vertices[vi].z / n;
    }
    const colAvg = _avgColors(f.verts.map(vi => mesh.vertices[vi].color));
    return { x, y, z, color: colAvg };
  });

  // UV of each new point, parallel to the geometry above (preserve texture continuity).
  const uvOf = (i: number): [number, number] => mesh.uvs?.[i] ?? [0, 0];
  const facePointUvs = mesh.faces.map(f => {
    const n = f.verts.length;
    let u = 0, v = 0;
    for (const vi of f.verts) { const uv = uvOf(vi); u += uv[0] / n; v += uv[1] / n; }
    return [u, v] as [number, number];
  });

  // Edge points
  const edgePoints = new Map<string, { x: number; y: number; z: number; color: [number,number,number,number] }>();
  for (const [key, faces] of edgeToFaces) {
    const [a, b] = key.split(',').map(Number);
    const va = mesh.vertices[a], vb = mesh.vertices[b];
    if (faces.length === 2) {
      const fp1 = facePoints[faces[0]], fp2 = facePoints[faces[1]];
      edgePoints.set(key, {
        x: (va.x + vb.x + fp1.x + fp2.x) / 4,
        y: (va.y + vb.y + fp1.y + fp2.y) / 4,
        z: (va.z + vb.z + fp1.z + fp2.z) / 4,
        color: _avgColors([va.color, vb.color, fp1.color, fp2.color]),
      });
    } else {
      edgePoints.set(key, {
        x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2, z: (va.z + vb.z) / 2,
        color: _avgColors([va.color, vb.color]),
      });
    }
  }

  // Vertex points (Catmull-Clark formula)
  const newVerts: typeof mesh.vertices = mesh.vertices.map((v, vi) => {
    const adjFaces = vertToFaces[vi] ?? [];
    const n = adjFaces.length;
    if (n === 0) return { ...v };

    let fx = 0, fy = 0, fz = 0;
    for (const fi of adjFaces) {
      fx += facePoints[fi].x / n;
      fy += facePoints[fi].y / n;
      fz += facePoints[fi].z / n;
    }

    // Average of edge midpoints (not edge points) adjacent to this vertex
    const adjEdgeMids: { x: number; y: number; z: number }[] = [];
    for (const fi of adjFaces) {
      const fVerts = mesh.faces[fi].verts;
      const idx = fVerts.indexOf(vi);
      const neighbors = [
        fVerts[(idx + 1) % fVerts.length],
        fVerts[(idx + fVerts.length - 1) % fVerts.length],
      ];
      for (const nb of neighbors) {
        const vb = mesh.vertices[nb];
        adjEdgeMids.push({ x: (v.x + vb.x) / 2, y: (v.y + vb.y) / 2, z: (v.z + vb.z) / 2 });
      }
    }

    const nm = adjEdgeMids.length || 1;
    let ex = 0, ey = 0, ez = 0;
    for (const em of adjEdgeMids) { ex += em.x / nm; ey += em.y / nm; ez += em.z / nm; }

    return {
      x: (fx + 2 * ex + (n - 3) * v.x) / n,
      y: (fy + 2 * ey + (n - 3) * v.y) / n,
      z: (fz + 2 * ez + (n - 3) * v.z) / n,
      color: v.color,
    };
  });

  // Build new vertex array: updated originals + edge points + face points
  const newVertexList: typeof mesh.vertices = [...newVerts];
  const edgePointIdx = new Map<string, number>();
  for (const [key, ep] of edgePoints) {
    edgePointIdx.set(key, newVertexList.length);
    newVertexList.push(ep);
  }
  const facePointIdx: number[] = [];
  for (const fp of facePoints) {
    facePointIdx.push(newVertexList.length);
    newVertexList.push(fp);
  }

  // Assemble UVs parallel to newVertexList: originals keep their UV, edge points =
  // endpoint average, face points = face-vertex average.
  const newUvs: [number, number][] = new Array(newVertexList.length);
  for (let vi = 0; vi < newVerts.length; vi++) newUvs[vi] = uvOf(vi);
  for (const [key, idx] of edgePointIdx) {
    const [a, b] = key.split(',').map(Number);
    const ua = uvOf(a), ub = uvOf(b);
    newUvs[idx] = [(ua[0] + ub[0]) / 2, (ua[1] + ub[1]) / 2];
  }
  for (let fi = 0; fi < facePointIdx.length; fi++) newUvs[facePointIdx[fi]] = facePointUvs[fi];

  // New faces: each original n-gon becomes n quads. A face with its own corner UVs gives its sub-quads corner UVs
  // interpolated INSIDE the face (so a UV seam stays a seam); shading is inherited.
  const newFaces: EditMeshData['faces'] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const face = mesh.faces[fi];
    const fVerts = face.verts;
    const fpIdx = facePointIdx[fi];
    const n = fVerts.length;
    const cu = face.uvs ? fVerts.map((vi, k) => face.uvs![k] ?? uvOf(vi)) : null;
    const cC = cu ? avgUV(cu) : undefined;
    for (let k = 0; k < n; k++) {
      const v0 = fVerts[k];
      const v1 = fVerts[(k + 1) % n];
      const v2 = fVerts[(k + n - 1) % n];
      const e01 = _edgeKey(v0, v1);
      const e0prev = _edgeKey(v2, v0);
      const ep01 = edgePointIdx.get(e01)!;
      const ep0prev = edgePointIdx.get(e0prev)!;
      newFaces.push({
        verts: [v0, ep01, fpIdx, ep0prev],
        uvs: cu ? [cu[k], lerpUV(cu[k], cu[(k + 1) % n], 0.5), cC, lerpUV(cu[(k + n - 1) % n], cu[k], 0.5)] : undefined,
        smooth: face.smooth,
      });
    }
  }

  // A sharp edge a–b becomes the two sub-edges a–ep and ep–b.
  const sharpEdges: Array<[number, number]> = [];
  for (const [a, b] of mesh.sharpEdges ?? []) {
    const ep = edgePointIdx.get(_edgeKey(a, b));
    if (ep !== undefined) sharpEdges.push([a, ep], [ep, b]);
  }

  return {
    vertices: newVertexList,
    faces: newFaces,
    uvs: newUvs,
    sharpEdges,
  };
}

function _edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

function _avgColors(colors: Array<[number, number, number, number]>): [number, number, number, number] {
  const n = colors.length || 1;
  let r = 0, g = 0, b = 0, a = 0;
  for (const c of colors) { r += c[0]; g += c[1]; b += c[2]; a += c[3]; }
  return [r / n, g / n, b / n, a / n];
}
