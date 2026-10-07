/**
 * Edit Mesh redesign (UI review 2026-10-07 §4) — the geometry under the new tools:
 *  - KNIFE along a polyline of surface points (edit-mesh-knife.ts / EditMesh.knifeCutPath): a straight cut across the
 *    top face of a cube, a cut that bends inside one face and crosses onto the next, the eye plane, dangling ends,
 *    corner UVs, seam hand-over;
 *  - LOOP CUT with several cuts + a position (EditMesh.loopCuts): consistent sides around the ring, counts, preview;
 *  - REGION OFFSET (the Inset tool's depth).
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
const _g = globalThis as Record<string, unknown> & { self?: unknown; crypto?: unknown };
_g.self ??= globalThis;
_g.crypto ??= webcrypto;
import { EditMesh } from './edit-mesh';
import { generateBox } from '../../renderer/3d/mesh-generators';

/** Half-edge validity: next / prev inverse, twins symmetric + reversed, directed edges unique, every vertex used;
 *  `closed` = no boundary half-edge. */
function topologyErrors(em: EditMesh, closed: boolean): string[] {
  const errs: string[] = [];
  const H = em.halfEdges;
  H.forEach((he, hi) => {
    if (H[he.next]?.prev !== hi) errs.push(`he ${hi}: next.prev`);
    if (he.twin >= 0) {
      const tw = H[he.twin];
      if (tw.twin !== hi) errs.push(`he ${hi}: twin not symmetric`);
      if (tw.vertex !== H[he.prev].vertex || H[tw.prev].vertex !== he.vertex) errs.push(`he ${hi}: twin not reversed`);
    } else if (closed) errs.push(`he ${hi}: boundary on a closed mesh`);
  });
  const seen = new Set<string>();
  H.forEach((he) => { const k = `${H[he.prev].vertex},${he.vertex}`; if (seen.has(k)) errs.push(`directed edge ${k} twice`); seen.add(k); });
  const used = new Set(H.map(h => h.vertex));
  em.vertices.forEach((_, vi) => { if (!used.has(vi)) errs.push(`vertex ${vi} unused`); });
  return errs;
}

const cube = () => EditMesh.fromBox(1, 1, 1);
const faceWhere = (em: EditMesh, pred: (v: { x: number; y: number; z: number }) => boolean) =>
  em.faces.findIndex((_, fi) => em.getFaceVertices(fi).every(vi => pred(em.vertices[vi])));
const edgeCount = (em: EditMesh) => em.halfEdges.filter((h, i) => h.twin < 0 || h.twin > i).length;
const euler = (em: EditMesh) => em.vertices.length - edgeCount(em) + em.faces.length;
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe('Knife — polyline cut (EditMesh.knifeCutPath)', () => {
  it('two taps on opposite edges of the top face split it in two; the neighbours take the new vertices (closed)', () => {
    const em = cube();
    const top = faceWhere(em, v => v.y > 0);
    const n = em.knifeCutPath([{ face: top, x: 0, y: 0.5, z: 0.5 }, { face: top, x: 0, y: 0.5, z: -0.5 }]);
    expect(n).toBe(1);
    expect(em.vertices.length).toBe(10);
    expect(em.faces.length).toBe(7);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(euler(em)).toBe(2);
    // the two new vertices sit exactly at the tapped edge points
    const added = em.vertices.slice(8).map(v => [v.x, v.y, v.z]);
    expect(added).toEqual(expect.arrayContaining([[0, 0.5, 0.5], [0, 0.5, -0.5]]));
    // the top is now two quads (x ≤ 0 and x ≥ 0); the front / back faces are pentagons
    const tops = em.faces.map((_, fi) => fi).filter(fi => em.getFaceVertices(fi).every(vi => em.vertices[vi].y > 0));
    expect(tops).toHaveLength(2);
    for (const fi of tops) expect(em.faces[fi].vertexCount).toBe(4);
    expect(em.faces.filter(f => f.vertexCount === 5)).toHaveLength(2);
    // every face keeps its outward normal (winding)
    for (const fi of tops) expect(em.getFaceNormal(fi)[1]).toBeGreaterThan(0.99);
  });

  it('a tap inside the face bends the cut there; the next segment crosses onto the front face (eye plane)', () => {
    const em = cube();
    const top = faceWhere(em, v => v.y > 0);
    const front = faceWhere(em, v => v.z > 0);
    const eye: [number, number, number] = [0.3, 3, 3];
    const n = em.knifeCutPath([
      { face: top, x: -0.5, y: 0.5, z: 0 },        // on the top's left edge
      { face: top, x: 0, y: 0.5, z: 0.2 },         // inside the top: a bend
      { face: front, x: 0.2, y: -0.5, z: 0.5 },    // on the front's bottom edge
    ], { eye });
    expect(n).toBe(2);                              // the top and the front are split
    expect(topologyErrors(em, true)).toEqual([]);
    expect(euler(em)).toBe(2);
    // the interior point is a vertex now, used by both halves of the top
    const bend = em.vertices.findIndex(v => near(v.x, 0) && near(v.y, 0.5) && near(v.z, 0.2));
    expect(bend).toBeGreaterThanOrEqual(0);
    expect(em.faces.filter((_, fi) => em.getFaceVertices(fi).includes(bend))).toHaveLength(2);
    // the crossing of the top / front edge lies ON that edge, and on the plane through the bend, the end and the eye
    const cross = em.vertices.findIndex((v, i) => i >= 8 && near(v.y, 0.5) && near(v.z, 0.5));
    expect(cross).toBeGreaterThanOrEqual(0);
    const P = (i: number) => [em.vertices[i].x, em.vertices[i].y, em.vertices[i].z];
    const b = P(bend), e = [0.2, -0.5, 0.5], c = P(cross);
    const d = [e[0] - b[0], e[1] - b[1], e[2] - b[2]], toEye = [eye[0] - b[0], eye[1] - b[1], eye[2] - b[2]];
    const nrm = [d[1] * toEye[2] - d[2] * toEye[1], d[2] * toEye[0] - d[0] * toEye[2], d[0] * toEye[1] - d[1] * toEye[0]];
    expect(Math.abs(nrm[0] * (c[0] - b[0]) + nrm[1] * (c[1] - b[1]) + nrm[2] * (c[2] - b[2]))).toBeLessThan(1e-9);
  });

  it('dangling ends inside a face are not cut; a path inside ONE face cuts nothing (mesh untouched)', () => {
    const em = cube();
    const top = faceWhere(em, v => v.y > 0);
    const before = JSON.stringify(em.toJSON());
    expect(em.knifeCutPath([{ face: top, x: -0.2, y: 0.5, z: 0 }, { face: top, x: 0.2, y: 0.5, z: 0.1 }])).toBe(0);
    expect(JSON.stringify(em.toJSON())).toBe(before);
    // from inside the top across its front edge to the front's bottom edge: only the front (edge to edge) is split
    const front = faceWhere(em, v => v.z > 0);
    const n = em.knifeCutPath([{ face: top, x: 0, y: 0.5, z: 0 }, { face: front, x: 0, y: -0.5, z: 0.5 }], { viewDir: [0, -1, -1] });
    expect(n).toBe(1);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(em.faces.length).toBe(7);
  });

  it('corner UVs are interpolated onto the cut (an imported, textured cube); a cut seam stays a seam on both pieces', () => {
    const em = EditMesh.fromGeometry(generateBox(1, 1, 1));
    const top = faceWhere(em, v => v.y > 0);
    const uvAt = (fi: number, vi: number) => {
      let hi = em.faces[fi].halfEdge;
      for (let k = 0; k < em.faces[fi].vertexCount; k++) { if (em.halfEdges[hi].vertex === vi) return em.cornerUV(hi); hi = em.halfEdges[hi].next; }
      return undefined;
    };
    // the top's corner UVs at the two front corners
    const fv = em.getFaceVertices(top);
    const fl = fv.find(v => em.vertices[v].x < 0 && em.vertices[v].z > 0)!, fr = fv.find(v => em.vertices[v].x > 0 && em.vertices[v].z > 0)!;
    const ul = uvAt(top, fl)!, ur = uvAt(top, fr)!;
    // mark the top's front edge as a seam, then cut through its midpoint
    const he = em.halfEdges.findIndex((_, i) => { const e = em.getHalfEdgeVertices(i)!; return (e[0] === fl && e[1] === fr) || (e[0] === fr && e[1] === fl); });
    em.markSeams([he]);
    expect(em.knifeCutPath([{ face: top, x: 0, y: 0.5, z: 0.5 }, { face: top, x: 0, y: 0.5, z: -0.5 }])).toBe(1);
    const mid = em.vertices.findIndex(v => near(v.x, 0) && near(v.y, 0.5) && near(v.z, 0.5));
    const topHalves = em.faces.map((_, fi) => fi).filter(fi => em.getFaceVertices(fi).every(vi => em.vertices[vi].y > 0));
    for (const fi of topHalves) {
      const u = uvAt(fi, mid)!;
      expect(u[0]).toBeCloseTo((ul[0] + ur[0]) / 2, 6);
      expect(u[1]).toBeCloseTo((ul[1] + ur[1]) / 2, 6);
    }
    // both pieces of the cut seam edge are seams
    const seamPieces = em.halfEdges.filter((h, i) => h.isSeam && em.getHalfEdgeVertices(i)!.includes(mid));
    expect(seamPieces.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Loop cut with count + position (EditMesh.loopCuts)', () => {
  /** The half-edge from a to b. */
  const heOf = (em: EditMesh, a: (v: { x: number; y: number; z: number }) => boolean, b: (v: { x: number; y: number; z: number }) => boolean) =>
    em.halfEdges.findIndex((_, i) => { const e = em.getHalfEdgeVertices(i)!; return a(em.vertices[e[0]]) && b(em.vertices[e[1]]); });

  it('one cut at 0.5 rings the cube (4 quads → 8): 12 vertices, all on one plane, closed', () => {
    const em = cube();
    // the top-front edge runs along X
    const he = heOf(em, v => v.y > 0 && v.z > 0 && v.x < 0, v => v.y > 0 && v.z > 0 && v.x > 0);
    expect(he).toBeGreaterThanOrEqual(0);
    expect(em.loopCuts(he, 1, 0.5)).toBe(true);
    expect(em.vertices.length).toBe(12);
    expect(em.faces.length).toBe(10);
    expect(topologyErrors(em, true)).toEqual([]);
    for (const v of em.vertices.slice(8)) expect(v.x).toBeCloseTo(0, 12);
  });

  it('count 3 at an off-centre position: every ring edge cut at the SAME fractions from the same side', () => {
    const em = cube();
    const he = heOf(em, v => v.y > 0 && v.z > 0 && v.x < 0, v => v.y > 0 && v.z > 0 && v.x > 0);
    const ts = EditMesh.loopCutFractions(3, 0.3);
    expect(ts).toHaveLength(3);
    expect(ts[1]).toBeCloseTo(0.3, 12);                         // the middle cut sits at the position
    expect(em.loopCuts(he, 3, 0.3)).toBe(true);
    expect(em.vertices.length).toBe(8 + 4 * 3);
    expect(em.faces.length).toBe(2 + 4 * 4);
    expect(topologyErrors(em, true)).toEqual([]);
    // the four cuts' x values: the same three planes on every ring edge (no criss-cross)
    const xs = [...new Set(em.vertices.slice(8).map(v => Math.round(v.x * 1e9) / 1e9))].sort((a, b) => a - b);
    expect(xs).toHaveLength(3);
    const fromLeft = ts.map(t => -0.5 + t).sort((a, b) => a - b), fromRight = ts.map(t => 0.5 - t).sort((a, b) => a - b);
    const match = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
    expect(match(xs, fromLeft) || match(xs, fromRight)).toBe(true);
    // every face is a planar quad (no folded / crossing faces)
    for (let fi = 0; fi < em.faces.length; fi++) expect(em.faces[fi].vertexCount).toBe(4);
  });

  it('the preview is the segments the cut adds; a triangle the ring stops at gains the vertex (no crack)', () => {
    const em = cube();
    const he = heOf(em, v => v.y > 0 && v.z > 0 && v.x < 0, v => v.y > 0 && v.z > 0 && v.x > 0);
    const seg = em.loopCutPreview(he, 2, 0.5);
    expect(seg.length).toBe(4 * 2 * 6);                         // 4 quads × 2 cuts × one segment
    // a grid with a triangle at one end: the loop stops there and the triangle gains the cut vertex
    const tri = EditMesh.fromJSON({
      vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 1 }, { x: 0.5, y: 0, z: 2 }],
      faces: [[0, 3, 2, 1], [3, 4, 2]],
    });
    const h = tri.halfEdges.findIndex((_, i) => { const e = tri.getHalfEdgeVertices(i)!; return e[0] === 1 && e[1] === 0; });
    expect(tri.loopCuts(h, 1, 0.5)).toBe(true);
    expect(tri.faces.map(f => f.vertexCount).sort()).toEqual([4, 4, 4]);
    expect(topologyErrors(tri, false)).toEqual([]);
  });
});

describe('Region offset (the Inset tool depth)', () => {
  it('inset the top face, then offset the inner face down by 0.1 along its normal', () => {
    const em = cube();
    const top = faceWhere(em, v => v.y > 0);
    em.insetRegion([top], 0.5);
    expect(em.offsetRegion([top], -0.1)).toBe(true);
    for (const vi of em.getFaceVertices(top)) expect(em.vertices[vi].y).toBeCloseTo(0.4, 12);
    expect(topologyErrors(em, true)).toEqual([]);
    expect(em.offsetRegion([top], 0)).toBe(false);
  });
});
