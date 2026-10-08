/**
 * edit-mesh-mirror.test.ts — the plane mirror + bisect (round 2 "Mirror rework", edit-mesh-mirror.ts):
 * bisect of a cube (no duplicate / overlapping faces, welded seam, closed manifold), face mirror, a turned plane
 * re-cuts, flip side, the old axis mirror loads + round-trips + behaves exactly as before, Bake = the modifier output,
 * and the images helpers (picking / overlay) map the copy side back to the real side.
 */
import { describe, it, expect } from 'vitest';
import { EditMesh, MirrorModifier, SubdivisionModifier, type EditMeshData } from './edit-mesh';
import { bisectMirror, forEachPointImage, forEachSegmentImage, forEachPolygonImage, toRealSide, imageAffine, planeDistance, type MirrorPlane } from './edit-mesh-mirror';

/** The modifier stack's output (what compile() renders / Bake writes). */
function output(em: EditMesh): EditMeshData {
  let data = (em as unknown as { _toEditMeshData(): EditMeshData })._toEditMeshData();
  for (const m of em.modifiers) if (m.enabled) data = m.apply(data);
  return data;
}

/** The output as a half-edge mesh (Bake on a copy). */
function baked(em: EditMesh): EditMesh {
  const c = EditMesh.fromJSON(em.toJSON());
  c.applyModifier(c.modifiers.length - 1);
  return c;
}

/** Closed 2-manifold, consistently oriented: every directed edge once, and its reverse once. */
function expectClosedManifold(d: EditMeshData): void {
  const dir = new Map<string, number>();
  for (const f of d.faces) {
    expect(new Set(f.verts).size).toBe(f.verts.length);
    for (let k = 0; k < f.verts.length; k++) {
      const key = `${f.verts[k]}>${f.verts[(k + 1) % f.verts.length]}`;
      dir.set(key, (dir.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of dir) {
    expect(n).toBe(1);
    const [a, b] = key.split('>');
    expect(dir.get(`${b}>${a}`)).toBe(1);
  }
}

/** No two vertices at the same place (the seam is welded) and no two faces on the same vertex set / centre. */
function expectNoDuplicates(d: EditMeshData): void {
  const pos = new Set<string>();
  for (const v of d.vertices) {
    const k = `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
    expect(pos.has(k)).toBe(false);
    pos.add(k);
  }
  const sets = new Set<string>(), centres = new Set<string>();
  for (const f of d.faces) {
    const s = [...f.verts].sort((a, b) => a - b).join(',');
    expect(sets.has(s)).toBe(false);
    sets.add(s);
    let x = 0, y = 0, z = 0;
    for (const i of f.verts) { x += d.vertices[i].x; y += d.vertices[i].y; z += d.vertices[i].z; }
    const c = `${(x / f.verts.length).toFixed(5)},${(y / f.verts.length).toFixed(5)},${(z / f.verts.length).toFixed(5)}`;
    expect(centres.has(c)).toBe(false);
    centres.add(c);
  }
}

function range(d: EditMeshData, k: 'x' | 'y' | 'z'): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of d.vertices) { lo = Math.min(lo, v[k]); hi = Math.max(hi, v[k]); }
  return [lo, hi];
}

const faceWhere = (em: EditMesh, pred: (v: { x: number; y: number; z: number }) => boolean): number =>
  em.faces.findIndex((_, fi) => em.getFaceVertices(fi).every(vi => pred(em.vertices[vi])));

describe('plane mirror — bisect', () => {
  it('bisect of a cube through its bounds centre: half kept + reflected copy, seam welded, closed manifold, no duplicates', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const base = JSON.stringify(em.toJSON());
    em.modifiers.push(MirrorModifier.plane('bisect', em.boundsCenter(), [-1, 0, 0]));
    const d = output(em);
    // 4 (+X face) + 4 cut vertices on the plane + 4 reflected = 12; 5 kept faces (+X whole, 4 halves) × 2 = 10
    expect(d.vertices).toHaveLength(12);
    expect(d.faces).toHaveLength(10);
    expectClosedManifold(d);
    expectNoDuplicates(d);
    expect(d.vertices.filter(v => Math.abs(v.x) < 1e-12)).toHaveLength(4);   // the welded seam ring, exactly on x = 0
    expect(range(d, 'x')).toEqual([-0.5, 0.5]);
    // non-destructive: the base mesh is untouched
    expect(JSON.stringify({ ...(em.toJSON() as object), modifiers: [] })).toBe(JSON.stringify({ ...JSON.parse(base), modifiers: [] }));
    // the half-edge mesh of the output has no boundary
    const b = baked(em);
    expect(b.halfEdges.every(h => h.twin >= 0)).toBe(true);
    expect(b.compile().indices!.length / 3).toBe(20);
  });

  it('face mirror on the +X face: the copy appears on the +X side, the shared face is gone (internal), seam welded', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const fx = faceWhere(em, v => v.x > 0);
    const pl = em.facePlane(fx)!;
    expect(pl.point).toEqual([0.5, 0, 0]);
    expect(pl.normal.map(c => Math.round(c * 1e9) / 1e9)).toEqual([1, 0, 0]);
    em.modifiers.push(MirrorModifier.plane('face', pl.point, pl.normal));
    const d = output(em);
    expect(range(d, 'x')).toEqual([-0.5, 1.5]);           // the copy is outward from the face
    expect(d.vertices).toHaveLength(12);
    expect(d.faces).toHaveLength(10);
    expectClosedManifold(d);
    expectNoDuplicates(d);
    // no face lies in the mirror plane (the +X face would be internal)
    for (const f of d.faces) expect(f.verts.every(i => Math.abs(d.vertices[i].x - 0.5) < 1e-9)).toBe(false);
  });

  it('a turned plane re-cuts: every output vertex is on the real side or the reflection of one; cut vertices on the plane', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const mod = MirrorModifier.plane('bisect', [0, 0, 0], [-1, 0, 0]);
    em.modifiers.push(mod);
    const before = output(em);
    mod.normal = [-Math.SQRT1_2, Math.SQRT1_2, 0];   // tilted 45° about Z
    const d = output(em);
    expect(d.vertices.length).not.toBe(before.vertices.length);
    expectClosedManifold(d);
    expectNoDuplicates(d);
    const pl: MirrorPlane = { point: mod.point, normal: mod.normal, eps: mod.mergeThreshold };
    const key = (x: number, y: number, z: number) => `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    const all = new Set(d.vertices.map(v => key(v.x, v.y, v.z)));
    for (const v of d.vertices) {
      // symmetric: the reflection of every output vertex is an output vertex
      const s = planeDistance(pl, v.x, v.y, v.z), n = mod.normal;
      expect(all.has(key(v.x - 2 * s * n[0], v.y - 2 * s * n[1], v.z - 2 * s * n[2]))).toBe(true);
    }
    // the real half: the base corners on the real side are all present, none of the copy-side ones (other than as reflections)
    const real = em.vertices.filter(v => planeDistance(pl, v.x, v.y, v.z) < -1e-6);
    for (const v of real) expect(all.has(key(v.x, v.y, v.z))).toBe(true);
    // the seam: vertices on the plane are exactly on it
    const onPlane = d.vertices.filter(v => Math.abs(planeDistance(pl, v.x, v.y, v.z)) < 1e-3);
    expect(onPlane.length).toBeGreaterThan(0);
    for (const v of onPlane) expect(Math.abs(planeDistance(pl, v.x, v.y, v.z))).toBeLessThan(1e-12);
  });

  it('flip side swaps which half is real', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    for (const v of em.vertices) if (v.x > 0) v.y *= 2;    // the +X end twice as tall
    const mod = MirrorModifier.plane('bisect', em.boundsCenter(), [-1, 0, 0]);
    em.modifiers.push(mod);
    let d = output(em);                                    // real = +X (tall) half
    expect(range(d, 'y')).toEqual([-1, 1]);
    expect(d.vertices.filter(v => v.x === -0.5).every(v => Math.abs(v.y) === 1)).toBe(true);
    mod.normal = [1, 0, 0];                                // flipped: real = -X (short) half
    d = output(em);
    expect(range(d, 'y')).toEqual([-0.75, 0.75]);           // (the slanted top is cut at y = 0.75 on the seam)
    expect(d.vertices.filter(v => Math.abs(v.x) === 0.5).every(v => Math.abs(v.y) === 0.5)).toBe(true);
    expectClosedManifold(d);
  });

  it('a plane past the whole mesh is inert (the mesh never vanishes); corner UVs / colours ride the cut', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    const mod = MirrorModifier.plane('bisect', [-2, 0, 0], [1, 0, 0]);   // the whole cube on the copy side
    em.modifiers.push(mod);
    const d = output(em);
    expect(d.vertices).toHaveLength(8);
    expect(mod.inert).toBe(true);
    expect(em.mirrorPlanes()).toHaveLength(0);
    mod.point = [0, 0, 0];
    const d2 = output(em);
    expect(mod.inert).toBe(false);
    expect(em.mirrorPlanes()).toHaveLength(1);
    // the box's corner UVs: the cut corners get the interpolated u / v (the cube's faces run 0..1)
    const cut = d2.faces.find(f => f.uvs && f.uvs.some(u => u && (u[0] === 0.5 || u[1] === 0.5)));
    expect(cut).toBeDefined();
  });

  it('clipping is linear: a 24k-face mesh bisects in well under a second', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    em.modifiers.push(new SubdivisionModifier(6));
    em.applyModifier(0);
    expect(em.faces.length).toBe(6 * 4 ** 6);
    const t0 = performance.now();
    const r = bisectMirror(output(em), { point: [0, 0, 0], normal: [-1, 0, 0], eps: 0.001 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.inert).toBe(false);
    expectClosedManifold(r.data);
  });
});

describe('plane mirror — persistence, old axis mirrors, Bake', () => {
  it('an OLD-format axis mirror loads as mode axis, round-trips identically and compiles exactly as before', () => {
    const old = { type: 'mirror', enabled: true, axis: 'x', mergeThreshold: 0.001, clipping: true };
    const box = EditMesh.fromBox(1, 2, 3);
    box.vertices.forEach(v => { v.x += 0.75; });          // off the origin, so the old mirror really duplicates
    const json = { ...(box.toJSON() as Record<string, unknown>), modifiers: [old] };
    const em = EditMesh.fromJSON(json);
    const mod = em.modifiers[0] as MirrorModifier;
    expect(mod.mode).toBe('axis');
    expect(mod.getPlane()).toEqual({ mode: 'axis', point: [0, 0, 0], normal: [1, 0, 0] });
    expect((em.toJSON() as { modifiers: object[] }).modifiers).toEqual([old]);
    expect(JSON.stringify(EditMesh.fromJSON(em.toJSON()).toJSON())).toBe(JSON.stringify(em.toJSON()));
    // the old behaviour: the whole mesh + its mirror (no bisect) — the same bytes as a fresh old-style modifier
    const ref = EditMesh.fromJSON({ ...json, modifiers: [] });
    ref.modifiers.push(new MirrorModifier('x', true));
    const a = em.compile(), b = ref.compile();
    expect(Array.from(a.vertices)).toEqual(Array.from(b.vertices));
    expect(Array.from(a.indices!)).toEqual(Array.from(b.indices!));
    expect(output(em).vertices).toHaveLength(16);         // nothing clipped
    expect(em.mirrorPlanes()).toHaveLength(0);            // no copy-side picking for the old mode
  });

  it('plane mirrors save mode / point / normal and load back the same', () => {
    const em = EditMesh.fromBox(1, 1, 1);
    em.modifiers.push(MirrorModifier.plane('face', [0.5, 0, 0], [1, 0, 0]), MirrorModifier.plane('bisect', [0, 0.1, 0], [0, -2, 0]));
    const j = em.toJSON() as { modifiers: Array<Record<string, unknown>> };
    expect(j.modifiers[0]).toMatchObject({ type: 'mirror', mode: 'face', point: [0.5, 0, 0], normal: [1, 0, 0] });
    expect(j.modifiers[1]).toMatchObject({ mode: 'bisect', point: [0, 0.1, 0], normal: [0, -1, 0] });
    const back = EditMesh.fromJSON(JSON.parse(JSON.stringify(j)));
    expect(back.toJSON()).toEqual(j);
    expect(Array.from(back.compile().vertices)).toEqual(Array.from(em.compile().vertices));
  });

  it('Bake writes exactly the modifier output (compile before === compile after)', () => {
    for (const make of [
      (em: EditMesh) => MirrorModifier.plane('bisect', em.boundsCenter(), [-1, 0, 0]),
      (em: EditMesh) => MirrorModifier.plane('bisect', [0.1, 0, 0], [-0.8, 0.6, 0]),
      (em: EditMesh) => { const p = em.facePlane(faceWhere(em, v => v.x > 0))!; return MirrorModifier.plane('face', p.point, p.normal); },
    ]) {
      const em = EditMesh.fromBox(1, 1, 1);
      em.modifiers.push(make(em));
      const live = em.compile();
      em.applyModifier(0);
      expect(em.modifiers).toHaveLength(0);
      const after = em.compile();
      expect(Array.from(after.vertices)).toEqual(Array.from(live.vertices));
      expect(Array.from(after.indices!)).toEqual(Array.from(live.indices!));
    }
  });
});

describe('plane mirror — images (picking / overlay)', () => {
  const pl: MirrorPlane = { point: [0, 0, 0], normal: [-1, 0, 0], eps: 0.001 };

  it('points: real + reflection; on-plane once; discarded none; toRealSide maps a copy point back', () => {
    const got: number[][] = [];
    forEachPointImage([pl], 0.5, 0.2, 0.1, (x, y, z, img) => got.push([x, y, z, img]));
    expect(got).toEqual([[0.5, 0.2, 0.1, 0], [-0.5, 0.2, 0.1, 1]]);
    got.length = 0;
    forEachPointImage([pl], 0, 1, 1, (x, y, z, img) => got.push([x, y, z, img]));
    expect(got).toEqual([[0, 1, 1, 0]]);
    got.length = 0;
    forEachPointImage([pl], -0.5, 0, 0, () => got.push([]));
    expect(got).toHaveLength(0);
    expect(toRealSide([pl], -0.5, 0.2, 0.1)).toEqual({ x: 0.5, y: 0.2, z: 0.1, img: 1 });
    expect(toRealSide([pl], 0.5, 0.2, 0.1).img).toBe(0);
    const A = imageAffine([pl], 1);
    expect([A[0] * 0.5 + A[9], A[4], A[8]]).toEqual([-0.5, 1, 1]);
  });

  it('segments / polygons are clipped to the real side and reflected', () => {
    const segs: number[][] = [];
    forEachSegmentImage([pl], -0.5, 0, 0, 0.5, 0, 0, (ax, ay, az, bx, by, bz, img) => segs.push([ax, bx, img]));
    expect(segs.map(sg => sg.map(v => v + 0))).toEqual([[0, 0.5, 0], [0, -0.5, 1]]);
    const polys: Array<{ n: number; img: number; xs: number[] }> = [];
    forEachPolygonImage([pl], [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], (p, img) => polys.push({ n: p.length / 3, img, xs: p.filter((_, i) => i % 3 === 0) }));
    expect(polys.map(p => [p.n, p.img])).toEqual([[4, 0], [4, 1]]);
    expect(Math.min(...polys[0].xs)).toBe(0);
    expect(Math.max(...polys[1].xs)).toBe(0);
  });
});
