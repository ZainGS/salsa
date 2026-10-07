/**
 * edit-mesh-features.test.ts — the Edit Mesh items built on the welded topology (docs/specs/edit-mesh-topology.md §7):
 * shading / sharp edges in the overlay, concave-quad diagonals, per-corner colours, imported custom normals, and the
 * bevel / chamfer tool.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as Record<string, unknown> & { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
_g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, VERTEX: 32, INDEX: 16 };
_g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
import { EditMesh } from './edit-mesh';
import { FLOATS_PER_VERT, generateBox, generateSphere, generatePlane, type MeshGeometry } from '../../renderer/3d/mesh-generators';
import { Mesh3D } from './mesh-3d';
import { MeshEditManager } from '../../services/managers/mesh-edit-manager';
import { MeshEditOverlayRenderer } from '../../renderer/3d/mesh-edit-overlay-renderer';
import { Camera3D } from '../../renderer/3d/camera-3d';
import type { ManagerContext } from '../../services/managers/manager-context';
import type { InteractionService } from '../../services/interaction-service';
import type { Command3D } from '../../services/managers/undo-manager-3d';

const S = FLOATS_PER_VERT;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;

/** Half-edge validity: next/prev inverse, face loops close, twins symmetric and reversed; `closed` = no boundary. */
export function topologyErrors(em: EditMesh, closed: boolean): string[] {
  const errs: string[] = [];
  const H = em.halfEdges;
  H.forEach((he, hi) => {
    if (H[he.next]?.prev !== hi) errs.push(`he ${hi}: next.prev`);
    if (H[he.prev]?.next !== hi) errs.push(`he ${hi}: prev.next`);
    if (he.twin >= 0) {
      const tw = H[he.twin];
      if (tw.twin !== hi) errs.push(`he ${hi}: twin not symmetric`);
      if (tw.vertex !== H[he.prev].vertex || H[tw.prev].vertex !== he.vertex) errs.push(`he ${hi}: twin not reversed`);
    } else if (closed) errs.push(`he ${hi}: boundary on a closed mesh`);
  });
  em.faces.forEach((f, fi) => {
    let hi = f.halfEdge, n = 0;
    do { if (H[hi].face !== fi) errs.push(`face ${fi}: he ${hi} in another face`); hi = H[hi].next; n++; } while (hi !== f.halfEdge && n <= f.vertexCount);
    if (n !== f.vertexCount) errs.push(`face ${fi}: loop ${n} ≠ vertexCount ${f.vertexCount}`);
  });
  // directed edges unique (a non-manifold / doubled face shows up here)
  const seen = new Set<string>();
  H.forEach((he) => { const k = `${H[he.prev].vertex},${he.vertex}`; if (seen.has(k)) errs.push(`directed edge ${k} twice`); seen.add(k); });
  const used = new Set(H.map(h => h.vertex));
  em.vertices.forEach((_, vi) => { if (!used.has(vi)) errs.push(`vertex ${vi} unused`); });
  return errs;
}

function managerFor(mesh: Mesh3D, cmds?: Command3D[]): MeshEditManager {
  const ctx = { sceneGraph: { findNodeById: (id: string) => (id === mesh.id ? mesh : null) } } as unknown as ManagerContext;
  return new MeshEditManager(ctx, (c) => { cmds?.push(c); });
}

/** A fake device that records the line-buffer uploads of the overlay. */
function overlayHarness() {
  const writes = new Map<object, Float32Array>();
  const draws: Array<{ pipe: string; count: number }> = [];
  let pipe = '';
  const device = {
    createBuffer: (d: { size: number }) => ({ size: d.size, destroy() { /* */ } }),
    createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createBindGroup: () => ({}),
    createPipelineLayout: () => ({}), createRenderPipeline: (d: { label?: string }) => ({ label: d.label }),
    queue: { writeBuffer: (buf: object, _o: number, data: Float32Array, off = 0, size?: number) => {
      writes.set(buf, Float32Array.from(data.subarray(off, off + (size ?? data.length - off))));
    } },
  } as unknown as GPUDevice;
  const pass = {
    setPipeline: (p: { label?: string }) => { pipe = p.label ?? ''; }, setBindGroup: () => {},
    setVertexBuffer: (_s: number, b: object) => { (pass as unknown as { vb: object }).vb = b; },
    draw: (count: number) => { draws.push({ pipe, count }); (draws[draws.length - 1] as { data?: Float32Array }).data = writes.get((pass as unknown as { vb: object }).vb); },
  } as unknown as GPURenderPassEncoder;
  return { device, pass, draws: draws as Array<{ pipe: string; count: number; data?: Float32Array }> };
}

describe('Edit Mesh — shading: Shade Smooth / Flat, Mark Sharp (item 1)', () => {
  it('sharp edges draw cyan in the overlay; the wireframe rebuilds when an edge is marked', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    const mgr = managerFor(mesh);
    mgr.makeEditable(mesh.id);
    const { device, pass, draws } = overlayHarness();
    const r = new MeshEditOverlayRenderer(device, 'bgra8unorm');
    const cam = new Camera3D({ position: [2, 2, 3], target: [0, 0, 0] });
    const sel = { meshId: mesh.id, vertices: new Set<number>(), edges: new Set<number>(), faces: new Set<number>() };
    const cyan = (d: Float32Array) => { let n = 0; for (let i = 0; i < d.length; i += 7) if (d[i + 3] < 0.3 && d[i + 4] > 0.8 && d[i + 5] > 0.9) n++; return n; };
    r.draw(pass, { mesh, selection: sel, mode: 'face' }, cam);
    expect(cyan(draws.find(d => d.pipe === 'MeshEditLine')!.data!)).toBe(0);
    const builds = r.wireframeBuilds;
    expect(mgr.setSharpEdges(mesh.id, [0, 1], true)).toBe(true);
    draws.length = 0;
    r.draw(pass, { mesh, selection: sel, mode: 'face' }, cam);
    expect(r.wireframeBuilds).toBe(builds + 1);
    expect(cyan(draws.find(d => d.pipe === 'MeshEditLine')!.data!)).toBe(4);   // two edges × two endpoints
  });

  it('Shade Smooth / Flat and Mark / Clear Sharp are one undo step each and round-trip', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    const cmds: Command3D[] = [];
    const mgr = managerFor(mesh, cmds);
    mgr.makeEditable(mesh.id);
    const flatBytes = Float32Array.from(mesh.geometry!.vertices);
    mgr.setFacesSmooth(mesh.id, null, true);           // nothing selected → every face
    expect(mesh.editMesh!.faces.every(f => f.smooth)).toBe(true);
    expect(mesh.geometry!.vertices.length / S).toBeLessThanOrEqual(24);   // smooth corners with equal UVs share
    mgr.setSharpEdges(mesh.id, [mesh.editMesh!.faces[0].halfEdge], true);
    expect(cmds.length).toBe(2);
    cmds[1].undo(); cmds[0].undo();
    expect(mesh.editMesh!.faces.some(f => f.smooth)).toBe(false);
    expect(Array.from(mesh.geometry!.vertices)).toEqual(Array.from(flatBytes));
    cmds[0].redo(); cmds[1].redo();
    expect(mesh.editMesh!.faces.every(f => f.smooth)).toBe(true);
    expect(mesh.editMesh!.halfEdges.filter(h => h.isSharp).length).toBe(2);
  });
});

/** Unit normal of render triangle t. */
function triNormal(g: { vertices: ArrayLike<number>; indices: ArrayLike<number> }, t: number): [number, number, number] {
  const p = [0, 1, 2].map(k => g.indices[t * 3 + k] * S);
  const a = [g.vertices[p[0]], g.vertices[p[0] + 1], g.vertices[p[0] + 2]];
  const b = [g.vertices[p[1]], g.vertices[p[1] + 1], g.vertices[p[1] + 2]];
  const c = [g.vertices[p[2]], g.vertices[p[2] + 1], g.vertices[p[2] + 2]];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: [number, number, number] = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

describe('Edit Mesh — concave quads flip their diagonal (item 2)', () => {
  it('a corner dragged past the 0–2 diagonal: the quad splits 1–3, both triangles face out (no fold)', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    // front quad [4,5,6,7] = (−,−) (+,−) (+,+) (−,+) at z = +0.5; pull corner 5 inside past the 4–6 diagonal (y = x)
    Object.assign(em.vertices[5], { x: 0.1, y: 0.3 });
    const g = em.compile();
    const front = 0;   // fromBox face order: front first
    // the face's two triangles are the first two of the index buffer (faces in order, 2 tris per quad)
    for (const t of [0, 1]) expect(triNormal(g, t)[2]).toBeGreaterThan(0.99);
    expect(em.faces[front].vertexCount).toBe(4);
    // the triangles cover the concave quad (areas add up to the polygon area)
    const area = (t: number) => {
      const p = [0, 1, 2].map(k => g.indices[t * 3 + k] * S);
      const [ax, ay, bx, by, cx, cy] = [g.vertices[p[0]], g.vertices[p[0] + 1], g.vertices[p[1]], g.vertices[p[1] + 1], g.vertices[p[2]], g.vertices[p[2] + 1]];
      return Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    };
    const poly = [[-0.5, -0.5], [0.1, 0.3], [0.5, 0.5], [-0.5, 0.5]];
    let shoelace = 0;
    for (let i = 0; i < 4; i++) shoelace += poly[i][0] * poly[(i + 1) % 4][1] - poly[(i + 1) % 4][0] * poly[i][1];
    expect(area(0) + area(1)).toBeCloseTo(Math.abs(shoelace) / 2, 6);
  });

  it('a convex quad keeps the generator split (unedited cube still byte-identical — see the topology tests)', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    Object.assign(em.vertices[5], { x: 0.3, y: -0.1 });   // moved, still convex
    expect(Array.from(em.compile().indices.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('a drag through the flip: the in-place patch == a full compile every frame; the flip frame rewrites the quad index range', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const g = em.compile();
    let flips = 0;
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      Object.assign(em.vertices[5], { x: 0.5 + (0.1 - 0.5) * t, y: -0.5 + (0.3 + 0.5) * t, z: 0.5 - 0.2 * t });
      const spans = em.patchCompiledPositions(g);
      expect(spans).not.toBeNull();   // never a full compile
      if (em.lastPatchIndexSpans.length) {
        flips++;
        expect(em.lastPatchIndexSpans).toContain(0);      // the front quad = the first 6 indices
      }
      const ref = EditMesh.fromJSON(em.toJSON()).compile();
      expect(Array.from(g.indices)).toEqual(Array.from(ref.indices));
      expect(Array.from(g.vertices)).toEqual(Array.from(ref.vertices));
    }
    expect(flips).toBeGreaterThanOrEqual(1);
    // the final front quad is split 1–3 and neither triangle folds
    expect(Array.from(g.indices.slice(0, 6))).toEqual([0, 1, 3, 1, 2, 3]);
    for (const t of [0, 1]) expect(triNormal(g, t)[2]).toBeGreaterThan(0.5);
  });

  it('Mesh3D drag path: patchFromEditMesh keeps patching through the flip (geometry object kept)', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    managerFor(mesh).makeEditable(mesh.id);
    const em = mesh.editMesh!;
    const geom = mesh.geometry;
    const v = em.vertices.findIndex(p => p.x > 0 && p.y < 0 && p.z > 0);   // the (+,−,+) corner
    let idxFrames = 0;
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      Object.assign(em.vertices[v], { x: 0.5 - 0.4 * t, y: -0.5 + 0.8 * t });
      const spans = mesh.patchFromEditMesh();
      expect(spans).not.toBeNull();
      if (em.lastPatchIndexSpans.length) idxFrames++;
    }
    expect(idxFrames).toBeGreaterThanOrEqual(1);
    expect(mesh.geometry).toBe(geom);
    const ref = EditMesh.fromJSON(em.toJSON()).compile();
    expect(Array.from(mesh.geometry!.vertices)).toEqual(Array.from(ref.vertices));
    expect(Array.from(mesh.geometry!.indices)).toEqual(Array.from(ref.indices));
  });
});

// ── Item 3: per-corner colours ────────────────────────────────────────────────

const GREY = [0.8, 0.8, 0.8, 1];
type Compiled = ReturnType<EditMesh['compile']> & { vertexColors: Float32Array; sourceVerts: Uint32Array };
/** Render-vertex colours (rgba per render vertex) + their topology vertices. */
function colorsOf(em: EditMesh): { vc: Float32Array; src: Uint32Array; g: Compiled } {
  const g = em.compile() as Compiled;
  return { vc: g.vertexColors, src: g.sourceVerts, g };
}
/** The render vertices of face fi (via the index buffer: each face's triangles are consecutive, in face order). */
function renderVertsOfFace(em: EditMesh, g: { indices: ArrayLike<number> }, fi: number): Set<number> {
  let t = 0;
  for (let f = 0; f < fi; f++) t += em.faces[f].vertexCount - 2;
  const out = new Set<number>();
  for (let k = t * 3; k < (t + em.faces[fi].vertexCount - 2) * 3; k++) out.add(g.indices[k]);
  return out;
}
const round6 = (a: ArrayLike<number>) => Array.from(a).map(x => +x.toFixed(6));

describe('Edit Mesh — per-corner colours: Paint Face Colour does not bleed (item 3)', () => {
  it('painting one face of a WELDED cube leaves every neighbour unchanged', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    const mgr = managerFor(mesh);
    mgr.makeEditable(mesh.id);
    const em = mesh.editMesh!;
    expect(em.vertices.length).toBe(8);
    mgr.paintFaceColor(mesh.id, 0, 1, 0, 0, 1);
    const { vc, g } = colorsOf(em);
    const painted = renderVertsOfFace(em, g, 0);
    expect(painted.size).toBe(4);
    for (let r = 0; r < vc.length / 4; r++) {
      const c = vc.slice(r * 4, r * 4 + 4);
      if (painted.has(r)) expect(Array.from(c)).toEqual([1, 0, 0, 1]);
      else expect(round6(c)).toEqual(GREY);   // every other face: untouched
    }
    // the mesh's own vertexColors (what the renderer uploads) match
    expect(Array.from(mesh.vertexColors!)).toEqual(Array.from(vc));
  });

  it('a smooth mesh splits the painted face off its fans (the neighbours keep their colour)', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    em.setFacesSmooth(em.faces.map((_, i) => i), true);
    for (const h of em.halfEdges) h.uv = [0, 0];   // one UV everywhere: one render vertex per topology vertex
    expect(em.compile().vertices.length / S).toBe(8);
    em.paintFaceColor(0, 0, 0, 1, 1);
    const { vc, g } = colorsOf(em);
    expect(g.vertices.length / S).toBe(12);   // the 4 painted corners split off
    const painted = renderVertsOfFace(em, g, 0);
    for (let r = 0; r < vc.length / 4; r++) expect(round6(vc.slice(r * 4, r * 4 + 4))).toEqual(painted.has(r) ? [0, 0, 1, 1] : GREY);
  });

  it('old per-vertex colours keep rendering (the corners fall back to them); Paint Vertex Colour paints every corner', () => {
    const old = EditMesh.fromBox(1, 1, 1);
    old.vertices[6].color = [0, 1, 0, 1];          // an old save: per-vertex colour
    const json = old.toJSON() as { cornerColors?: unknown };
    expect(json.cornerColors).toBeUndefined();
    const em = EditMesh.fromJSON(json);
    expect(Array.from(colorsOf(em).vc)).toEqual(Array.from(colorsOf(old).vc));
    em.paintFaceColor(0, 1, 0, 0, 1);              // the front face has vertex 6
    em.paintVertexColor(6, 0, 0, 1, 1);            // the vertex wins at every corner again
    const { vc, src } = colorsOf(em);
    let n = 0;
    for (let r = 0; r < src.length; r++) if (src[r] === 6) { expect(Array.from(vc.slice(r * 4, r * 4 + 4))).toEqual([0, 0, 1, 1]); n++; }
    expect(n).toBe(3);
  });

  it('save / load and undo / redo keep corner colours; ops interpolate them', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    const cmds: Command3D[] = [];
    const mgr = managerFor(mesh, cmds);
    mgr.makeEditable(mesh.id);
    const plain = Float32Array.from(mesh.vertexColors!);
    mgr.paintFaceColor(mesh.id, 2, 0.2, 0.4, 0.6, 1);
    const painted = Float32Array.from(mesh.vertexColors!);
    // JSON round trip (the Mesh3D save → restore path is EditMesh.toJSON → EditMesh.fromJSON)
    const json = JSON.parse(JSON.stringify(mesh.editMesh!.toJSON()));
    expect(json.cornerColors).toBeTruthy();
    expect(Array.from(colorsOf(EditMesh.fromJSON(json)).vc)).toEqual(Array.from(painted));
    expect((mesh.toJSON() as { editMesh?: { cornerColors?: unknown } }).editMesh?.cornerColors).toBeTruthy();
    cmds[0].undo();
    expect(Array.from(mesh.vertexColors!)).toEqual(Array.from(plain));
    cmds[0].redo();
    expect(Array.from(mesh.vertexColors!)).toEqual(Array.from(painted));
    // extrude the painted face: the top keeps the colour; a loop cut through it keeps it on both halves
    const em = EditMesh.fromBox(1, 1, 1);
    em.paintFaceColor(0, 1, 0, 0, 1);
    em.extrudeFace(0, 0.2);
    expect(em.cornerColor(em.faces[0].halfEdge)).toEqual([1, 0, 0, 1]);
    const em2 = EditMesh.fromBox(1, 1, 1);
    em2.paintFaceColor(0, 1, 0, 0, 1);
    em2.loopCut(em2.faces[0].halfEdge, 0.5);
    const red = em2.halfEdges.filter(h => h.color && h.color[0] === 1 && h.color[1] === 0).length;
    expect(red).toBe(8);   // the two halves of the front quad: 8 corners
    expect(topologyErrors(em2, true)).toEqual([]);
  });
});

// ── Item 4: imported custom normals ───────────────────────────────────────────

/** The authored normal of the test cube at position p: "rounded" and skewed toward +X — what an import with custom
 *  normals looks like (neither the flat faces nor a fan average give it). */
const authoredN = (x: number, y: number, z: number): number[] => { const n = [x + 0.3, y, z], l = Math.hypot(n[0], n[1], n[2]); return n.map(c => c / l); };
function roundedNormalCube(): MeshGeometry {
  const g = generateBox(1, 1, 1);
  const V = Float32Array.from(g.vertices);
  for (let r = 0; r < V.length / S; r++) {
    const n = authoredN(V[r * S], V[r * S + 1], V[r * S + 2]);
    V[r * S + 3] = n[0]; V[r * S + 4] = n[1]; V[r * S + 5] = n[2];
  }
  return { vertices: V, indices: Uint32Array.from(g.indices), format: '12float' };
}

/** A UV sphere whose normals are tilted (authored, not radial). */
function tiltedSphere(): MeshGeometry {
  const g = generateSphere(0.5, 12, 8), V = Float32Array.from(g.vertices);
  for (let r = 0; r < V.length / S; r++) {
    const nx = V[r * S + 3] + 0.3, ny = V[r * S + 4], nz = V[r * S + 5], l = Math.hypot(nx, ny, nz);
    V[r * S + 3] = nx / l; V[r * S + 4] = ny / l; V[r * S + 5] = nz / l;
  }
  return { vertices: V, indices: g.indices, format: '12float' };
}

/** The geometry as a multiset of triangles (each = its 3 corners' position + normal + UV bits, rotated to a canonical
 *  start; degenerate ones skipped) — equal multisets render identically whatever the vertex order / indexing. */
function triangleSet(g: { vertices: ArrayLike<number>; indices: ArrayLike<number> }): string[] {
  const V = Float32Array.from(g.vertices as ArrayLike<number>), U = new Uint32Array(V.buffer);
  // positions by value (a weld keeps ONE copy of a seam vertex: its twins' last bits / −0 differ), normal + UV by bits
  const pos = (i: number) => Array.from(V.slice(i * S, i * S + 3)).map(x => String(Math.round(x * 1e6) / 1e6 + 0)).join(',');
  const W = new Float32Array(V.length);
  for (let i = 0; i < V.length; i++) W[i] = V[i] + 0;   // −0 ≡ +0 (a JSON save cannot keep −0; it renders the same)
  const UW = new Uint32Array(W.buffer);
  const key = (i: number) => pos(i) + ',' + Array.from(UW.slice(i * S + 3, i * S + 8)).join(',');
  const out: string[] = [];
  for (let t = 0; t < g.indices.length / 3; t++) {
    const ps = [0, 1, 2].map(k => pos(g.indices[t * 3 + k]));
    if (ps[0] === ps[1] || ps[1] === ps[2] || ps[0] === ps[2]) continue;   // degenerate (a UV sphere's pole caps): draws nothing
    const ks = [0, 1, 2].map(k => key(g.indices[t * 3 + k]));
    const m = ks.indexOf([...ks].sort()[0]);
    out.push([ks[m], ks[(m + 1) % 3], ks[(m + 2) % 3]].join('|'));
  }
  return out.sort();
}
const u32 = (a: ArrayLike<number>) => Array.from(new Uint32Array(Float32Array.from(a).buffer));

describe('Edit Mesh — imported custom normals are kept (item 4)', () => {
  it('an import with authored normals enters and exits Edit Mesh rendering identically (normals bit for bit)', () => {
    for (const src of [roundedNormalCube(), tiltedSphere()]) {
      const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'custom', geometry: src });
      managerFor(mesh).makeEditable(mesh.id);
      expect(mesh.editMesh!.hasCustomNormals()).toBe(true);
      // every source triangle is drawn with exactly its position / normal / UV bits
      expect(triangleSet(mesh.geometry!)).toEqual(triangleSet(src));
      // save / load: identical bytes again
      const back = EditMesh.fromJSON(JSON.parse(JSON.stringify(mesh.editMesh!.toJSON())));
      const g2 = back.compile();
      expect(u32(g2.vertices)).toEqual(u32(mesh.geometry!.vertices));
      expect(Array.from(g2.indices)).toEqual(Array.from(mesh.geometry!.indices));
    }
  });

  it('moving one vertex recomputes only the faces around it (with their fans); the rest keeps its normal bits', () => {
    const src = roundedNormalCube();
    const em = EditMesh.fromGeometry(src);
    const g0 = em.compile() as Compiled;
    const v = em.vertices.findIndex(p => p.x > 0 && p.y > 0 && p.z > 0);   // the (+,+,+) corner
    em.moveVertex(v, 0.1, 0.1, 0.1);
    const g1 = em.compile() as Compiled;
    // near = the vertices of the faces around v (a cube corner's 3 faces touch 7 of the 8 vertices)
    const near = new Set<number>();
    em.faces.forEach((_, fi) => { const vs = em.getFaceVertices(fi); if (vs.includes(v)) vs.forEach(x => near.add(x)); });
    expect(near.size).toBe(7);
    const far = [...Array(8).keys()].filter(x => !near.has(x));
    // the far vertex: every render vertex there keeps the authored normal exactly (same UV → same render vertex)
    let checked = 0;
    for (let r = 0; r < g1.sourceVerts.length; r++) {
      if (g1.sourceVerts[r] !== far[0]) continue;
      const r0 = [...g0.sourceVerts].findIndex((sv, i) => sv === far[0]
        && g0.vertices[i * S + 6] === g1.vertices[r * S + 6] && g0.vertices[i * S + 7] === g1.vertices[r * S + 7]);
      expect(u32([3, 4, 5].map(k => g1.vertices[r * S + k]))).toEqual(u32([3, 4, 5].map(k => g0.vertices[r0 * S + k])));
      checked++;
    }
    expect(checked).toBe([...g0.sourceVerts].filter(sv => sv === far[0]).length);
    expect(checked).toBeGreaterThan(0);
    // the near vertices lost the authored normal (recomputed from the faces)
    for (let r = 0; r < g1.sourceVerts.length; r++) {
      const sv = g1.sourceVerts[r];
      if (!near.has(sv) || sv === v) continue;
      const p = [0, 1, 2].map(k => g1.vertices[r * S + k]), n = [3, 4, 5].map(k => g1.vertices[r * S + k]);
      const a = authoredN(p[0], p[1], p[2]);
      expect(Math.abs(n[0] * a[0] + n[1] * a[1] + n[2] * a[2] - 1)).toBeGreaterThan(1e-4);
    }
    // the in-place drag patch agrees with a full compile while the normals clear
    const em2 = EditMesh.fromGeometry(src);
    const g = em2.compile();
    em2.moveVertex(v, 0.05, 0, 0);
    expect(em2.patchCompiledPositions(g)).not.toBeNull();
    expect(u32(g.vertices)).toEqual(u32(EditMesh.fromJSON(em2.toJSON()).compile().vertices));
  });

  it('Shade Smooth / Flat on a face clears its custom normals (and the fans it touched); the rest keeps theirs', () => {
    const em = EditMesh.fromGeometry(roundedNormalCube());
    em.setFacesSmooth([0], false);
    let h = em.faces[0].halfEdge;
    for (let k = 0; k < 4; k++) { expect(em.halfEdges[h].normal).toBeUndefined(); h = em.halfEdges[h].next; }
    expect(em.hasCustomNormals()).toBe(true);
    const json = JSON.parse(JSON.stringify(em.toJSON()));
    expect(u32(EditMesh.fromJSON(json).compile().vertices)).toEqual(u32(em.compile().vertices));
  });

  it('topology ops keep custom normals away from the edit (extrude: the fans the new side faces join recompute)', () => {
    const em = EditMesh.fromGeometry(roundedNormalCube());
    expect(em.halfEdges.filter(h => h.normal).length).toBe(24);
    em.extrudeFace(0, 0.2);
    const kept = em.halfEdges.filter(h => h.normal);
    expect(kept.length).toBe(12);   // the 4 back vertices × 3 faces keep the authored normals
    expect(topologyErrors(em, true)).toEqual([]);
    // no fan mixes custom and computed (a cube with rounded normals: one smooth fan per vertex)
    for (const he of kept) for (const o of em.halfEdges) if (o.vertex === he.vertex) expect(!!o.normal).toBe(true);
  });
});

// ── Item 5: bevel / chamfer ───────────────────────────────────────────────────

/** Euler characteristic V − E + F (2 for a closed genus-0 surface). */
function euler(em: EditMesh): number {
  let e = 0;
  em.halfEdges.forEach((he, hi) => { if (!(he.twin >= 0 && he.twin < hi)) e++; });
  return em.vertices.length - e + em.faces.length;
}
/** Every compiled triangle faces away from the mesh centre (a convex solid stays outward-wound). */
function allOutward(em: EditMesh): boolean {
  const g = em.compile();
  for (let t = 0; t < g.indices.length / 3; t++) {
    const p = [0, 1, 2].map(k => g.indices[t * 3 + k] * S);
    const c = [0, 1, 2].map(i => (g.vertices[p[0] + i] + g.vertices[p[1] + i] + g.vertices[p[2] + i]) / 3);
    const n = triNormal(g, t);
    if (n[0] * c[0] + n[1] * c[1] + n[2] * c[2] <= 0) return false;
  }
  return true;
}
const cornerOf = (em: EditMesh, x: number, y: number, z: number) =>
  em.vertices.findIndex(p => Math.sign(p.x) === x && Math.sign(p.y) === y && Math.sign(p.z) === z);
/** The undirected edge between two cube corners. */
const edgeOf = (em: EditMesh, a: number, b: number): [number, number] => [a, b];

describe('Edit Mesh — bevel / chamfer (item 5)', () => {
  it('vertex chamfer on a cube: a new triangle face, closed manifold, outward', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const v = cornerOf(em, 1, 1, 1);
    const r = em.bevel({ vertices: [v], amount: 0.25 })!;
    expect(r).not.toBeNull();
    expect(em.vertices.length).toBe(10);
    expect(em.faces.length).toBe(7);
    expect(r.newFaces.length).toBe(1);
    expect(em.faces[r.newFaces[0]].vertexCount).toBe(3);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(euler(em)).toBe(2);
    expect(allOutward(em)).toBe(true);
    // the triangle's corners sit 0.25 along the 3 edges from the old corner
    for (const vi of em.getFaceVertices(r.newFaces[0])) {
      const p = em.vertices[vi];
      expect([p.x, p.y, p.z].filter(c => Math.abs(c - 0.5) < 1e-12).length).toBe(2);
      expect([p.x, p.y, p.z].some(c => Math.abs(c - 0.25) < 1e-12)).toBe(true);
    }
  });

  it('vertex chamfer with 3 segments: rounded corner, still closed', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    em.bevel({ vertices: [cornerOf(em, 1, 1, 1)], amount: 0.3, segments: 3 });
    expect(topologyErrors(em, true)).toEqual([]);
    expect(euler(em)).toBe(2);
    expect(allOutward(em)).toBe(true);
  });

  it('edge bevel, 1 segment: a flat chamfer strip; the end faces become pentagons — no open corner', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const a = cornerOf(em, 1, 1, 1), b = cornerOf(em, -1, 1, 1);
    const r = em.bevel({ edges: [edgeOf(em, a, b)], amount: 0.2 })!;
    expect(r.newFaces.length).toBe(1);
    expect(em.vertices.length).toBe(10);
    expect(em.faces.length).toBe(7);
    expect(em.faces.filter(f => f.vertexCount === 5).length).toBe(2);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(euler(em)).toBe(2);
    expect(allOutward(em)).toBe(true);
  });

  it('edge bevel, 3 segments: a rounded strip (smooth), the ends close with the profile — no open corner', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const a = cornerOf(em, 1, 1, 1), b = cornerOf(em, -1, 1, 1);
    const r = em.bevel({ edges: [[a, b]], amount: 0.2, segments: 3 })!;
    expect(r.newFaces.length).toBe(3);
    expect(em.vertices.length).toBe(8 - 2 + 4 + 2 * 2);
    expect(r.newFaces.every(f => em.faces[f].smooth)).toBe(true);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(euler(em)).toBe(2);
    expect(allOutward(em)).toBe(true);
    // the profile is a circular arc: its middle points are 0.2 from the arc centre (0.3, 0.3) in the end plane
    const mids = em.vertices.slice(-4);
    for (const p of mids) expect(Math.hypot(p.y - 0.3, p.z - 0.3)).toBeCloseTo(0.2, 6);
  });

  it('beveling a loop / every cube edge / three edges at a corner: closed manifold, outward', () => {
    for (const segs of [1, 2, 3]) {
      // the 4 edges of the top face
      const em = EditMesh.fromBox(1, 1, 1);
      const top = em.faces.findIndex((_, fi) => em.getFaceVertices(fi).every(vi => em.vertices[vi].y > 0));
      const tv = em.getFaceVertices(top);
      em.bevel({ edges: tv.map((v, i) => [v, tv[(i + 1) % 4]] as [number, number]), amount: 0.15, segments: segs });
      expect(topologyErrors(em, true)).toEqual([]);
      expect(euler(em)).toBe(2);
      expect(allOutward(em)).toBe(true);
      // every edge of the cube
      const all = EditMesh.fromBox(1, 1, 1);
      const edges: Array<[number, number]> = [];
      all.halfEdges.forEach((he, hi) => { if (he.twin > hi) edges.push(all.getHalfEdgeVertices(hi)!); });
      all.bevel({ edges, amount: 0.1, segments: segs });
      expect(topologyErrors(all, true)).toEqual([]);
      expect(euler(all)).toBe(2);
      expect(allOutward(all)).toBe(true);
      // the three edges at one corner
      const c3 = EditMesh.fromBox(1, 1, 1);
      const v = cornerOf(c3, 1, 1, 1);
      const nb = [cornerOf(c3, -1, 1, 1), cornerOf(c3, 1, -1, 1), cornerOf(c3, 1, 1, -1)];
      c3.bevel({ edges: nb.map(x => [v, x] as [number, number]), amount: 0.2, segments: segs });
      expect(topologyErrors(c3, true)).toEqual([]);
      expect(euler(c3)).toBe(2);
      expect(allOutward(c3)).toBe(true);
    }
  });

  it('a terminal edge on a valence-4 vertex (a grid) keeps the vertex and caps the end with a triangle', () => {
    const em = EditMesh.fromGeometry(generatePlane(2, 2, 2, 2));   // 3×3 vertices, the centre has valence 4
    const c = em.vertices.findIndex(p => Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9 && Math.abs(p.z) < 1e-9);
    const n = em.vertices.findIndex(p => Math.abs(p.x - 1) < 1e-9 && Math.abs(p.y) + Math.abs(p.z) < 1e-9);
    const before = em.faces.length;
    const r = em.bevel({ edges: [[c, n]], amount: 0.2 })!;
    expect(r).not.toBeNull();
    expect(em.faces.length).toBe(before + 2);   // the strip + the triangle cap at the centre
    expect(r.newFaces.some(f => em.faces[f].vertexCount === 3)).toBe(true);
    expect(topologyErrors(em, false)).toEqual([]);
    expect(euler(em)).toBe(1);   // still a disc
  });

  it('open meshes: an edge reaching the border and a border corner bevel without new holes (still a disc)', () => {
    for (const segs of [1, 3]) {
      const em = EditMesh.fromGeometry(generatePlane(2, 2, 2, 2));
      const c = em.vertices.findIndex(p => Math.abs(p.x) + Math.abs(p.y) + Math.abs(p.z) < 1e-9);
      const n = em.vertices.findIndex(p => Math.abs(p.x - 1) < 1e-9 && Math.abs(p.y) + Math.abs(p.z) < 1e-9);   // on the border
      const boundaryBefore = em.halfEdges.filter(h => h.twin < 0).length;
      expect(em.bevel({ edges: [[c, n]], amount: 0.2, segments: segs })).not.toBeNull();
      expect(topologyErrors(em, false)).toEqual([]);
      expect(euler(em)).toBe(1);
      expect(em.halfEdges.filter(h => h.twin < 0).length).toBe(boundaryBefore + segs);   // the border edge gains the strip's end
      const corner = EditMesh.fromGeometry(generatePlane(2, 2, 2, 2));
      const k = corner.vertices.findIndex(p => p.x > 0.99 && Math.abs(p.y) + Math.abs(p.z) > 0.99);   // a corner of the square
      expect(corner.bevel({ vertices: [k], amount: 0.3, segments: segs })).not.toBeNull();
      expect(topologyErrors(corner, false)).toEqual([]);
      expect(euler(corner)).toBe(1);
    }
  });

  it('clamping: the amount stops where cuts would pass a neighbour or overlap (clamp overlap)', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const v = cornerOf(em, 1, 1, 1);
    expect(em.bevelLimit({ vertices: [v] })).toBeCloseTo(0.995, 9);           // a lone corner: up to the neighbours
    const w = cornerOf(em, -1, 1, 1);
    expect(em.bevelLimit({ vertices: [v, w] })).toBeCloseTo(0.4975, 9);      // two cuts on one edge: half each
    const r = em.bevel({ vertices: [v, w], amount: 5 })!;
    expect(r.amount).toBeCloseTo(0.4975, 9);
    expect(topologyErrors(em, true)).toEqual([]);
    const e = EditMesh.fromBox(2, 1, 1);
    const a = cornerOf(e, 1, 1, 1), b = cornerOf(e, -1, 1, 1);
    expect(e.bevelLimit({ edges: [[a, b]] })).toBeCloseTo(0.995, 9);           // the rails are 1 long
  });

  it('UVs on untouched faces are unchanged; corner colours, sharp edges and custom normals around survive', () => {
    const em = EditMesh.fromGeometry(roundedNormalCube());
    const v = em.vertices.findIndex(p => p.x > 0 && p.y > 0 && p.z > 0);
    const far = em.vertices.findIndex(p => p.x < 0 && p.y < 0 && p.z < 0);
    // the faces not touching v: their corner UVs (by vertex position) before
    const snap = (m: EditMesh) => {
      const out = new Map<string, string>();
      m.faces.forEach((f, fi) => {
        const vs = m.getFaceVertices(fi);
        if (vs.some(x => m.vertices[x].x > 0 && m.vertices[x].y > 0 && m.vertices[x].z > 0)) return;
        let h = f.halfEdge;
        do { const p = m.vertices[m.halfEdges[h].vertex]; out.set(`${fi}:${p.x},${p.y},${p.z}`, JSON.stringify(m.cornerUV(h))); h = m.halfEdges[h].next; } while (h !== f.halfEdge);
      });
      return out;
    };
    const farFace = em.faces.findIndex((_, fi) => !em.getFaceVertices(fi).includes(v));
    em.paintFaceColor(farFace, 1, 0, 0, 1);
    const farN = em.halfEdges.filter(h => h.vertex === far).map(h => h.normal);
    const before = snap(em);
    em.bevel({ vertices: [v], amount: 0.2 });
    const after = snap(em);
    for (const [k, uv] of before) if (after.has(k)) expect(after.get(k)).toBe(uv);
    expect([...after.keys()].length).toBeGreaterThanOrEqual(3 * 4);
    expect(em.cornerColor(em.faces[farFace].halfEdge)).toEqual([1, 0, 0, 1]);
    const far2 = em.vertices.findIndex(p => p.x < 0 && p.y < 0 && p.z < 0);
    expect(em.halfEdges.filter(h => h.vertex === far2).map(h => h.normal)).toEqual(farN);   // authored normals kept
    expect(farN.every(n => !!n)).toBe(true);
    expect(topologyErrors(em, true)).toEqual([]);
  });

  it('a sharp edge that is cut keeps its sharp flag on both pieces', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const v = cornerOf(em, 1, 1, 1), x = cornerOf(em, 1, -1, 1);
    const he = em.halfEdges.findIndex((h) => h.vertex === x && em.halfEdges[h.prev].vertex === v);
    em.setSharpEdges([he], true);
    em.bevel({ vertices: [v], amount: 0.3 });
    const sharp = em.halfEdges.filter(h => h.isSharp);
    expect(sharp.length).toBe(2);   // the remaining piece of the edge (both halves)
  });
});
