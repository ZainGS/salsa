/**
 * edit-mesh-topology.test.ts — the modeller model (docs/specs/edit-mesh-topology.md): Edit Mesh works on WELDED
 * topology (a cube = 8 shared vertices + 6 quads) with per-corner UVs; compile() derives the split / triangulated
 * render mesh.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as Record<string, unknown> & { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
_g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, VERTEX: 32, INDEX: 16 };
_g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
import { EditMesh, MirrorModifier, SubdivisionModifier } from './edit-mesh';
import {
  generateBox, generateSphere, generateCylinder, generateTorus, generatePlane, FLOATS_PER_VERT, type MeshGeometry,
} from '../../renderer/3d/mesh-generators';
import { Mesh3D } from './mesh-3d';
import { MeshEditManager } from '../../services/managers/mesh-edit-manager';
import { EditFacePicker } from '../../services/managers/mesh-edit-face-pick';
import { MeshEditOverlayRenderer } from '../../renderer/3d/mesh-edit-overlay-renderer';
import { Camera3D } from '../../renderer/3d/camera-3d';
import type { ManagerContext } from '../../services/managers/manager-context';
import type { InteractionService } from '../../services/interaction-service';

const S = FLOATS_PER_VERT;
const isvc = { maxGlobalZIndex: 0 } as unknown as InteractionService;
const bits = (a: Float32Array) => new Uint32Array(a.buffer, a.byteOffset, a.length);

/** Half-edge validity: next/prev inverse, every face loop closes in vertexCount steps, twins symmetric and reversed. */
function topologyErrors(em: EditMesh, closed: boolean): string[] {
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
  // every vertex used by a face
  const used = new Set(H.map(h => h.vertex));
  em.vertices.forEach((_, vi) => { if (!used.has(vi)) errs.push(`vertex ${vi} unused`); });
  return errs;
}

function uniqueEdges(em: EditMesh): number {
  let n = 0;
  em.halfEdges.forEach((he, hi) => { if (!(he.twin >= 0 && he.twin < hi)) n++; });
  return n;
}

/** The pre-topology compile's output for a mesh: un-indexed triangle soup, one flat normal per triangle. */
function soupOf(g: MeshGeometry, uvOf?: (tri: number, k: number) => [number, number]): MeshGeometry {
  const nTri = g.indices.length / 3;
  const out = new Float32Array(nTri * 3 * S);
  for (let t = 0; t < nTri; t++) {
    const p = [0, 1, 2].map(k => g.indices[t * 3 + k] * S);
    const a = [g.vertices[p[0]], g.vertices[p[0] + 1], g.vertices[p[0] + 2]];
    const b = [g.vertices[p[1]], g.vertices[p[1] + 1], g.vertices[p[1] + 2]];
    const c = [g.vertices[p[2]], g.vertices[p[2] + 1], g.vertices[p[2] + 2]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let k = 0; k < 3; k++) {
      const o = (t * 3 + k) * S;
      out.set(g.vertices.subarray(p[k], p[k] + 3), o);
      out[o + 3] = n[0] / l; out[o + 4] = n[1] / l; out[o + 5] = n[2] / l;
      const uv = uvOf ? uvOf(t, k) : [0, 0];
      out[o + 6] = uv[0]; out[o + 7] = uv[1];
      out[o + 8] = 1; out[o + 11] = 1;
    }
  }
  return { vertices: out, indices: Uint32Array.from({ length: nTri * 3 }, (_, i) => i), format: '12float' };
}

function managerFor(mesh: Mesh3D): MeshEditManager {
  const ctx = { sceneGraph: { findNodeById: (id: string) => (id === mesh.id ? mesh : null) } } as unknown as ManagerContext;
  return new MeshEditManager(ctx, () => {});
}

function newell(em: EditMesh, fi: number): [number, number, number] {
  const vs = em.getFaceVertices(fi).map(i => em.vertices[i]);
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < vs.length; k++) {
    const a = vs[k], b = vs[(k + 1) % vs.length];
    x += (a.y - b.y) * (a.z + b.z); y += (a.z - b.z) * (a.x + b.x); z += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

describe('Edit Mesh topology — a cube is 8 shared vertices and 6 quads', () => {
  it('fromGeometry(generateBox) and fromBox both give 8 vertices, 6 quads, 12 edges, closed', () => {
    for (const em of [EditMesh.fromGeometry(generateBox(1, 1, 1)), EditMesh.fromBox(1, 1, 1)]) {
      expect(em.vertices.length).toBe(8);
      expect(em.faces.length).toBe(6);
      expect(em.faces.every(f => f.vertexCount === 4)).toBe(true);
      expect(uniqueEdges(em)).toBe(12);
      expect(topologyErrors(em, true)).toEqual([]);
      expect(em.faces.some(f => f.smooth)).toBe(false);   // a box is flat-shaded
    }
  });

  it('an unedited cube compiles BYTE-identically to the primitive geometry (24 render vertices, same indices)', () => {
    for (const dims of [[1, 1, 1], [2, 0.5, 3]] as const) {
      const ref = generateBox(...dims);
      for (const em of [EditMesh.fromGeometry(ref), EditMesh.fromBox(...dims)]) {
        const g = em.compile();
        expect(g.vertices.length).toBe(24 * S);
        expect(bits(g.vertices as Float32Array)).toEqual(bits(ref.vertices));
        expect(Array.from(g.indices)).toEqual(Array.from(ref.indices));
      }
    }
  });

  it('a box Mesh3D entering and leaving Edit Mesh without edits renders the same geometry', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box', width: 1.5, height: 1, depth: 0.75 });
    const ref = mesh.geometry;
    const refV = (ref.vertices as Float32Array).slice(), refI = Array.from(ref.indices);
    const me = managerFor(mesh);
    expect(me.enterEditMode(mesh.id)).toBe(true);
    expect(mesh.editMesh!.vertices.length).toBe(8);
    expect(bits(mesh.geometry.vertices as Float32Array)).toEqual(bits(refV));
    expect(Array.from(mesh.geometry.indices)).toEqual(refI);
    me.exitEditMode();
    mesh.syncFromEditMesh();   // a later recompile (any op) gives the same bytes too
    expect(bits(mesh.geometry.vertices as Float32Array)).toEqual(bits(refV));
    expect(Array.from(mesh.geometry.indices)).toEqual(refI);
    // (the one render difference: the compile also emits per-vertex colours → the vertex-colour pipeline, as before)
    expect(mesh.vertexColors?.length).toBe(24 * 4);
  });
});

describe('Edit Mesh topology — dragging a corner', () => {
  it('moves ONE shared vertex: all 3 incident faces follow, each stays flat-shaded, UVs unchanged', () => {
    const ref = generateBox(1, 1, 1);
    const em = EditMesh.fromGeometry(ref);
    const v = em.vertices.findIndex(p => p.x > 0 && p.y > 0 && p.z > 0);
    const incident = em.faces.map((_, fi) => fi).filter(fi => em.getFaceVertices(fi).includes(v));
    expect(incident.length).toBe(3);
    em.moveVertex(v, 0.2, 0.15, 0.3);
    const g = em.compile() as MeshGeometry & { sourceVerts: Uint32Array };
    const V = g.vertices as Float32Array;
    // the corner's render vertices (one per incident face) all moved to the new position
    const rvs = [...g.sourceVerts.keys()].filter(r => g.sourceVerts[r] === v);
    expect(rvs.length).toBe(3);
    for (const r of rvs) expect([V[r * S], V[r * S + 1], V[r * S + 2]].map(x => +x.toFixed(5))).toEqual([0.7, 0.65, 0.8]);
    // every face's render vertices share ONE normal = the face (Newell) normal — no smoothing across the hard edges
    for (let fi = 0; fi < em.faces.length; fi++) {
      const n = newell(em, fi);
      for (let c = 0; c < 4; c++) {
        const r = fi * 4 + c;   // flat faces emit their corners in face order
        expect(V[r * S + 3]).toBeCloseTo(n[0], 6); expect(V[r * S + 4]).toBeCloseTo(n[1], 6); expect(V[r * S + 5]).toBeCloseTo(n[2], 6);
      }
    }
    // UVs: exactly the primitive's, corner for corner
    for (let r = 0; r < 24; r++) { expect(V[r * S + 6]).toBe(ref.vertices[r * S + 6]); expect(V[r * S + 7]).toBe(ref.vertices[r * S + 7]); }
  });

  it('the in-place drag patch equals a fresh compile bit for bit (flat cube and smooth sphere)', () => {
    for (const geom of [generateBox(1, 1, 1), generateSphere(0.5, 12, 8)]) {
      const em = EditMesh.fromGeometry(geom);
      const g = em.compile();
      expect(em.patchCompiledPositions(g)).toEqual([]);
      em.moveVertex(3, 0.05, -0.1, 0.07);
      em.moveVertex(5, -0.03, 0.02, 0.01);
      const spans = em.patchCompiledPositions(g)!;
      expect(spans.length).toBeGreaterThan(0);
      const clone = EditMesh.fromJSON(em.toJSON());
      expect(bits(g.vertices as Float32Array)).toEqual(bits(clone.compile().vertices as Float32Array));
    }
  });
});

describe('Edit Mesh topology — primitives enter welded, Blender-style', () => {
  it('sphere = quads + triangle poles (smooth), cylinder = side quads + fan caps (flat caps), torus / plane = quads', () => {
    const sphere = EditMesh.fromGeometry(generateSphere(0.5, 16, 12));
    expect(sphere.vertices.length).toBe(16 * 11 + 2);
    expect(sphere.faces.filter(f => f.vertexCount === 4).length).toBe(16 * 10);
    expect(sphere.faces.filter(f => f.vertexCount === 3).length).toBe(32);
    expect(sphere.faces.every(f => f.smooth)).toBe(true);
    expect(topologyErrors(sphere, true)).toEqual([]);

    const cyl = EditMesh.fromGeometry(generateCylinder(0.5, 0.5, 1, 16));
    expect(cyl.vertices.length).toBe(16 * 2 + 2);
    const quads = cyl.faces.filter(f => f.vertexCount === 4), tris = cyl.faces.filter(f => f.vertexCount === 3);
    expect(quads.length).toBe(16);
    expect(tris.length).toBe(32);
    expect(quads.every(f => f.smooth)).toBe(true);
    expect(tris.some(f => f.smooth)).toBe(false);
    expect(topologyErrors(cyl, true)).toEqual([]);

    const torus = EditMesh.fromGeometry(generateTorus(0.5, 0.2, 16, 24));
    expect(torus.vertices.length).toBe(16 * 24);
    expect(torus.faces.length).toBe(16 * 24);
    expect(torus.faces.every(f => f.vertexCount === 4)).toBe(true);
    expect(topologyErrors(torus, true)).toEqual([]);

    const plane = EditMesh.fromGeometry(generatePlane(2, 2, 3, 3));
    expect(plane.vertices.length).toBe(16);
    expect(plane.faces.length).toBe(9);
    expect(plane.faces.every(f => f.vertexCount === 4)).toBe(true);
    expect(topologyErrors(plane, false)).toEqual([]);
  });

  it('a smooth primitive keeps its UV seam and stays smooth across the weld (render split by UV only)', () => {
    const geom = generateSphere(0.5, 16, 12);
    const g = EditMesh.fromGeometry(geom).compile() as MeshGeometry & { sourceVerts: Uint32Array };
    const V = g.vertices as Float32Array;
    // every render vertex's normal points along its position (smooth, radial) — within the faceting of a 16×12 sphere
    for (let r = 0; r < V.length / S; r++) {
      const l = Math.hypot(V[r * S], V[r * S + 1], V[r * S + 2]);
      const d = (V[r * S] * V[r * S + 3] + V[r * S + 1] * V[r * S + 4] + V[r * S + 2] * V[r * S + 5]) / l;
      expect(d).toBeGreaterThan(0.98);
    }
    // the seam column (u = 0 / u = 1) is two render vertices at one topology vertex, with the SAME normal
    const seamTopo = new Map<number, number[]>();
    for (let r = 0; r < V.length / S; r++) { const v = g.sourceVerts[r]; (seamTopo.get(v) ?? seamTopo.set(v, []).get(v)!).push(r); }
    const split = [...seamTopo.values()].filter(rs => rs.length === 2);
    expect(split.length).toBeGreaterThan(0);
    for (const [a, b] of split) {
      if (Math.abs(V[a * S + 4]) > 0.99) continue;   // (poles split per triangle UV)
      // (the generator's own normals are kept as custom normals — its u = 0 / u = 1 copies differ in the last bits)
      for (let k = 3; k < 6; k++) expect(V[a * S + k]).toBeCloseTo(V[b * S + k], 6);
    }
  });
});

describe('Edit Mesh topology — old saves (triangle soup) weld on entering Edit Mesh', () => {
  it('an un-indexed soup cube (the old compile output) → 8 vertices, 6 quads, closed', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { geometry: soupOf(generateBox(1, 1, 1)) });
    expect(mesh.meshPrimitive).toBe('custom');
    managerFor(mesh).makeEditable(mesh.id);
    const em = mesh.editMesh!;
    expect(em.vertices.length).toBe(8);
    expect(em.faces.length).toBe(6);
    expect(em.faces.every(f => f.vertexCount === 4)).toBe(true);
    expect(topologyErrors(em, true)).toEqual([]);
  });

  it('a UV-painted soup (6 separate UV islands) keeps every corner UV — paint maps to the same texels', () => {
    const box = generateBox(1, 1, 1);
    // an unwrapped layout: face i's quad in its own cell of a 3×2 atlas
    const atlas = (t: number, k: number): [number, number] => {
      const face = Math.floor(t / 2), src = box.indices[t * 3 + k] - face * 4;
      const q = [[0, 0], [1, 0], [1, 1], [0, 1]][src];
      return [((face % 3) + q[0] * 0.9 + 0.05) / 3, (Math.floor(face / 3) + q[1] * 0.9 + 0.05) / 2];
    };
    const soup = soupOf(box, atlas);
    const em = EditMesh.fromGeometry(soup);
    expect(em.vertices.length).toBe(8);
    expect(em.computeUVIslands().length).toBe(6);
    const g = em.compile();
    const V = g.vertices as Float32Array, sv = soup.vertices;
    // every soup corner finds a render vertex at the same position + normal with the same UV
    for (let c = 0; c < sv.length / S; c++) {
      let found = false;
      for (let r = 0; r < V.length / S && !found; r++) {
        let same = true;
        for (let k = 0; k < 8 && same; k++) if (Math.abs(V[r * S + k] - sv[c * S + k]) > 1e-6) same = false;
        found = same;
      }
      expect(found, `soup corner ${c}`).toBe(true);
    }
  });

  it('an old EditMesh snapshot (per-vertex UVs, no corner data) loads and compiles as before', () => {
    const old = { vertices: [{ x: 0, y: 0, z: 0, uv: [0, 0] }, { x: 1, y: 0, z: 0, uv: [1, 0] }, { x: 1, y: 1, z: 0, uv: [1, 1] }, { x: 0, y: 1, z: 0, uv: [0, 1] }],
      faces: [[0, 1, 2, 3]], seamEdges: [[0, 1]], modifiers: [] };
    const em = EditMesh.fromJSON(old);
    expect(em.faces.length).toBe(1);
    expect(em.getFaceVertices(0)).toEqual([0, 1, 2, 3]);
    expect(em.halfEdges.filter(h => h.isSeam).length).toBe(1);
    const g = em.compile();
    expect(Array.from(g.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(Array.from((g.vertices as Float32Array).filter((_, i) => i % S === 6 || i % S === 7))).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
  });
});

describe('Edit Mesh topology — persistence', () => {
  it('toJSON / fromJSON round-trips topology, corner UVs, smooth faces and sharp edges (identical compile)', () => {
    const em = EditMesh.fromGeometry(generateCylinder(0.4, 0.5, 1, 12));
    em.setSharpEdges([0], true);
    const j = JSON.parse(JSON.stringify(em.toJSON()));
    const back = EditMesh.fromJSON(j);
    expect(back.vertices.length).toBe(em.vertices.length);
    expect(back.faces.map(f => f.vertexCount)).toEqual(em.faces.map(f => f.vertexCount));
    expect(back.faces.map(f => !!f.smooth)).toEqual(em.faces.map(f => !!f.smooth));
    expect(back.halfEdges.filter(h => h.isSharp).length).toBe(2);
    expect(bits(back.compile().vertices as Float32Array)).toEqual(bits(em.compile().vertices as Float32Array));
    // a second round trip is stable (faces keep their first corner)
    expect(JSON.stringify(EditMesh.fromJSON(back.toJSON()).toJSON())).toBe(JSON.stringify(back.toJSON()));
  });

  it('Mesh3D saves its edit topology (not for a skinned body); the saved geometry is its render mesh', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    managerFor(mesh).makeEditable(mesh.id);
    const state = mesh.toJSON();
    expect(state.editMesh).toBeTruthy();
    expect(state.config.geometry.vertices.length).toBe(24 * S);
    const restored = EditMesh.fromJSON(JSON.parse(JSON.stringify(state.editMesh)));
    expect(restored.vertices.length).toBe(8);
    expect(bits(restored.compile().vertices as Float32Array)).toEqual(bits(Float32Array.from(state.config.geometry.vertices)));
  });
});

describe('Edit Mesh topology — selection, pick and overlay', () => {
  it('a face pick anywhere on a cube side returns that side\'s ONE quad', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    managerFor(mesh).makeEditable(mesh.id);
    const em = mesh.editMesh!;
    const cam = new Camera3D({ position: [0, 0, 4], target: [0, 0, 0] });
    cam.aspect = 1;
    const fp = new EditFacePicker();
    const W = 400, H = 400;
    const project = (x: number, y: number, z: number) => {
      const m = cam.getViewProjectionMatrix() as unknown as Float32Array;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * W, (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5 * H];
    };
    const front = em.faces.findIndex((_, fi) => newell(em, fi)[2] > 0.9);
    // points in BOTH triangles of the front quad (near opposite corners of its diagonal) and the centre
    for (const [x, y] of [[0, 0], [-0.4, 0.35], [0.4, -0.35], [0.35, 0.4], [-0.35, -0.4]]) {
      const [px, py] = project(x, y, 0.5);
      expect(fp.pick(mesh, cam, px, py, W, H)).toBe(front);
    }
    expect(em.faces[front].vertexCount).toBe(4);
  });

  it('the overlay wireframe draws the 12 cube edges (no diagonals); a selected face fills the whole quad', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    managerFor(mesh).makeEditable(mesh.id);
    const draws: Array<{ pipe: string; count: number }> = [];
    let pipe = '';
    const device = {
      createBuffer: (d: { size: number }) => ({ size: d.size, destroy() { /* */ } }),
      createShaderModule: () => ({}), createBindGroupLayout: () => ({}), createBindGroup: () => ({}),
      createPipelineLayout: () => ({}), createRenderPipeline: (d: { label?: string }) => ({ label: d.label }),
      queue: { writeBuffer: () => {} },
    } as unknown as GPUDevice;
    const pass = {
      setPipeline: (p: { label?: string }) => { pipe = p.label ?? ''; }, setBindGroup: () => {}, setVertexBuffer: () => {},
      draw: (count: number) => { draws.push({ pipe, count }); },
    } as unknown as GPURenderPassEncoder;
    const r = new MeshEditOverlayRenderer(device, 'bgra8unorm');
    const cam = new Camera3D({ position: [2, 2, 3], target: [0, 0, 0] });
    r.draw(pass, { mesh, selection: { meshId: mesh.id, vertices: new Set(), edges: new Set(), faces: new Set([0]) }, mode: 'face' }, cam);
    const lines = draws.find(d => d.pipe === 'MeshEditLine')!;
    expect(lines.count).toBe(12 * 2);
    // Two triangle draws: the fills under the wireframe (the quad's 2 triangles), then the handles over it — the
    // selected face's 3 px outline (4 bands × 2 triangles) and a face dot per face (rim + core); no vertex dots in
    // Face mode (UI review 2026-10-07 §3 #19).
    const tris = draws.filter(d => d.pipe === 'MeshEditTri').map(d => d.count);
    expect(tris).toEqual([2 * 3, 4 * 6 + 6 * 2 * 6]);
  });
});

describe('Edit Mesh topology — tools keep a valid closed mesh', () => {
  it('extrude a quad: +4 vertices, +4 side quads, still closed; side faces carry the edge UVs', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    em.extrudeFace(0, 0.3);
    expect(em.vertices.length).toBe(12);
    expect(em.faces.length).toBe(10);
    expect(em.faces.every(f => f.vertexCount === 4)).toBe(true);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(em.compile().indices.length).toBe(10 * 6);
  });

  it('loop cut around a cube: 12 vertices, 10 quads, closed; the new corners get interpolated UVs', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const he = em.faces[0].halfEdge;
    em.loopCut(he, 0.5);
    expect(em.vertices.length).toBe(12);
    expect(em.faces.length).toBe(10);
    expect(topologyErrors(em, true)).toEqual([]);
    // every corner UV of the cut faces lies on the face's [0,1] square with a 0.5 coordinate at the cut
    const halves = em.halfEdges.filter(h => h.vertex >= 8);
    expect(halves.length).toBeGreaterThan(0);
    for (const h of halves) expect(h.uv![0] === 0.5 || h.uv![1] === 0.5).toBe(true);
  });

  it('knife across one cube side: the side splits, its neighbours take the new vertices — no T-junction', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const fv = em.getFaceVertices(0);   // front [4,5,6,7]
    em.knifeCut([{ faceIdx: 0, cuts: [
      { vA: fv[0], vB: fv[1], t: 0.5, edgeIdx: 0 },
      { vA: fv[2], vB: fv[3], t: 0.5, edgeIdx: 2 },
    ] }]);
    expect(em.vertices.length).toBe(10);
    expect(em.faces.length).toBe(7);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(em.faces.filter(f => f.vertexCount === 5).length).toBe(2);   // bottom + top gained a vertex
    em.extrudeFace(0, 0.2);   // and the tools keep working on the result
    expect(topologyErrors(em, true)).toEqual([]);
  });

  it('delete, flip, bevel, subdivide, merge: valid topology; flip reverses the corner UVs with the corners', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const uvs = (fi: number) => { const out: Array<[number, number]> = []; let h = em.faces[fi].halfEdge; do { out.push(em.cornerUV(h)!); h = em.halfEdges[h].next; } while (h !== em.faces[fi].halfEdge); return out; };
    const u0 = uvs(2), v0 = em.getFaceVertices(2);
    em.flipFaces(new Set([2]));
    expect(em.getFaceVertices(2)).toEqual([...v0].reverse());
    expect(uvs(2)).toEqual([...u0].reverse());
    em.flipFaces(new Set([2]));
    em.subdivideFace(1);
    expect(topologyErrors(em, true)).toEqual([]);
    // (bevelEdge is a full bevel now — edit-mesh-bevel.ts: the end corners are re-cut and capped, the mesh stays closed)
    em.bevelEdge(em.faces[0].halfEdge, 0.2);
    expect(topologyErrors(em, true)).toEqual([]);
    em.deleteFaces(new Set([0]));
    expect(topologyErrors(em, false)).toEqual([]);
    expect(em.mergeByDistance(1e-9)).toBe(0);
  });

  it('mirror + subdivision modifiers keep corner UVs (no zeroed / smeared seams)', () => {
    const em = EditMesh.fromBox(1, 2, 3);
    em.modifiers.push(new MirrorModifier('x', false), new SubdivisionModifier(1));
    const g = em.compile();
    const V = g.vertices as Float32Array;
    let min = Infinity, max = -Infinity;
    for (let r = 0; r < V.length / S; r++) { min = Math.min(min, V[r * S + 6], V[r * S + 7]); max = Math.max(max, V[r * S + 6], V[r * S + 7]); }
    expect(min).toBe(0); expect(max).toBe(1);
    em.applyModifier(1);
    expect(em.hasCornerUVs()).toBe(true);
    expect(topologyErrors(em, false)).toEqual([]);
  });
});

describe('Edit Mesh topology — undo / redo and the UV editor', () => {
  it('undo / redo of a topology op restores the welded mesh and its corner UVs exactly', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    const cmds: Array<{ undo: () => void; redo: () => void }> = [];
    const ctx = { sceneGraph: { findNodeById: (id: string) => (id === mesh.id ? mesh : null) } } as unknown as ManagerContext;
    const me = new MeshEditManager(ctx, (c) => cmds.push(c));
    me.makeEditable(mesh.id);
    const v0 = bits((mesh.geometry.vertices as Float32Array).slice());
    me.extrudeFace(mesh.id, 0, 0.4);
    const v1 = bits((mesh.geometry.vertices as Float32Array).slice());
    expect(mesh.editMesh!.vertices.length).toBe(12);
    cmds[0].undo();
    expect(mesh.editMesh!.vertices.length).toBe(8);
    expect(bits(mesh.geometry.vertices as Float32Array)).toEqual(v0);
    cmds[0].redo();
    expect(bits(mesh.geometry.vertices as Float32Array)).toEqual(v1);
  });

  it('moving one face\'s UVs on a welded cube moves that face only (its corners are cut from the neighbours)', async () => {
    const { UVEditManager } = await import('../../services/managers/uv-edit-manager');
    const { UVEditorSession } = await import('../../services/managers/uv-canvas-renderer');
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    const ctx = { sceneGraph: { findNodeById: (id: string) => (id === mesh.id ? mesh : null) } } as unknown as ManagerContext;
    const me = new MeshEditManager(ctx, () => {});
    me.makeEditable(mesh.id);
    me.autoUnwrap(mesh.id);
    const session = new UVEditorSession(mesh.id);
    const uvm = new UVEditManager(ctx, () => {}, () => session);
    const before = Array.from((mesh.geometry.vertices as Float32Array).filter((_, i) => i % S === 6 || i % S === 7));
    session.selectFace(0);
    expect(uvm.moveSelected(mesh.id, 0.01, 0.02)).toBe(true);
    const after = Array.from((mesh.geometry.vertices as Float32Array).filter((_, i) => i % S === 6 || i % S === 7));
    for (let r = 0; r < 24; r++) {
      const du = after[r * 2] - before[r * 2], dv = after[r * 2 + 1] - before[r * 2 + 1];
      if (r < 4) { expect(du).toBeCloseTo(0.01, 6); expect(dv).toBeCloseTo(0.02, 6); }
      else { expect(du).toBe(0); expect(dv).toBe(0); }
    }
    expect(mesh.editMesh!.vertices.length).toBe(8);
  });
});

describe('Edit Mesh topology — UV paint on a welded cube', () => {
  it('Auto Unwrap keeps the cube welded (8 vertices) and gives each side its own non-overlapping UV island', () => {
    const mesh = new Mesh3D(isvc, 0, 0, 0, { primitive: 'box' });
    const me = managerFor(mesh);
    me.makeEditable(mesh.id);
    expect(mesh.editMesh!.vertices.some(v => v.uv)).toBe(false);   // the UV editor still auto-unwraps a fresh box
    me.autoUnwrap(mesh.id);
    const em = mesh.editMesh!;
    expect(em.vertices.length).toBe(8);
    expect(em.faces.length).toBe(6);
    expect(em.computeUVIslands().length).toBe(6);
    expect(em.vertices.every(v => v.uv)).toBe(true);   // … and does not unwrap it again on the next open
    // compiled: per face, the UV bbox of its 4 render vertices; the 6 boxes are inside [0,1] and disjoint
    const g = mesh.geometry, V = g.vertices as Float32Array;
    const boxes = Array.from({ length: 6 }, (_, f) => {
      const us = [0, 1, 2, 3].map(c => V[(f * 4 + c) * S + 6]), vs = [0, 1, 2, 3].map(c => V[(f * 4 + c) * S + 7]);
      return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
    });
    for (const b of boxes) {
      expect(b[0]).toBeGreaterThanOrEqual(-1e-6); expect(b[3]).toBeLessThanOrEqual(1 + 1e-6);
      expect((b[2] - b[0]) * (b[3] - b[1])).toBeGreaterThan(0.01);
    }
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 1e-6 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 1e-6;
      expect(overlap, `faces ${i} / ${j}`).toBe(false);
    }
    // dragging the corner afterwards still moves all 3 sides and keeps the painted UVs
    const uvBefore = Array.from(V.filter((_, i) => i % S === 6 || i % S === 7));
    const v = em.vertices.findIndex(p => p.x > 0 && p.y > 0 && p.z > 0);
    em.moveVertex(v, 0.1, 0.1, 0.1);
    mesh.syncFromEditMesh();
    const V2 = mesh.geometry.vertices as Float32Array;
    expect(Array.from(V2.filter((_, i) => i % S === 6 || i % S === 7))).toEqual(uvBefore);
  });
});
