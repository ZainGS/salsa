/**
 * Boolean CSG on triangle soup — union / subtract / intersect between two solids.
 *
 * Self-contained BSP-tree algorithm (the csg.js / three-csg lineage), no external deps. PURE: triangles in →
 * triangles out (flat-shaded, non-indexed). Inputs should be CLOSED, manifold meshes for correct results; open or
 * self-intersecting input may leave holes. Coplanar faces are the fragile part (handled with an epsilon). Intended
 * for the modest meshes an AI/programmatic caller builds (primitives, revolves) — the orchestrator caps triangle
 * count to avoid a pathological hang. Result geometry is in whatever common space the caller passed in (world space).
 */

export type V3 = [number, number, number];
export interface Tri { a: V3; b: V3; c: V3; }

const EPS = 1e-5;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const normalize = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

interface Plane { normal: V3; w: number; }
const planeFrom = (a: V3, b: V3, c: V3): Plane => { const n = normalize(cross(sub(b, a), sub(c, a))); return { normal: n, w: dot(n, a) }; };
const flipPlane = (p: Plane): Plane => ({ normal: [-p.normal[0], -p.normal[1], -p.normal[2]], w: -p.w });

interface Polygon { verts: V3[]; plane: Plane; }
const polygon = (verts: V3[]): Polygon => ({ verts, plane: planeFrom(verts[0], verts[1], verts[2]) });
const flipPolygon = (p: Polygon): Polygon => ({ verts: [...p.verts].reverse(), plane: flipPlane(p.plane) });

const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

/** Classify `poly` against `plane`; append it (or its split pieces) to the four buckets. */
function splitPolygon(plane: Plane, poly: Polygon, coFront: Polygon[], coBack: Polygon[], front: Polygon[], back: Polygon[]): void {
  let polygonType = 0;
  const types: number[] = [];
  for (const v of poly.verts) {
    const t = dot(plane.normal, v) - plane.w;
    const type = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
    polygonType |= type;
    types.push(type);
  }
  switch (polygonType) {
    case COPLANAR:
      (dot(plane.normal, poly.plane.normal) > 0 ? coFront : coBack).push(poly);
      break;
    case FRONT: front.push(poly); break;
    case BACK: back.push(poly); break;
    default: {   // SPANNING
      const f: V3[] = [], b: V3[] = [];
      for (let i = 0; i < poly.verts.length; i++) {
        const j = (i + 1) % poly.verts.length;
        const ti = types[i], tj = types[j];
        const vi = poly.verts[i], vj = poly.verts[j];
        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(vi);
        if ((ti | tj) === SPANNING) {
          const t = (plane.w - dot(plane.normal, vi)) / dot(plane.normal, sub(vj, vi));
          const v = lerp(vi, vj, t);
          f.push(v); b.push(v);
        }
      }
      if (f.length >= 3) front.push(polygon(f));
      if (b.length >= 3) back.push(polygon(b));
    }
  }
}

/** A BSP-tree node (csg.js algorithm). */
class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polygons: Polygon[] = [];

  build(polygons: Polygon[]): void {
    if (!polygons.length) return;
    if (!this.plane) this.plane = polygons[0].plane;
    const front: Polygon[] = [], back: Polygon[] = [];
    for (const p of polygons) splitPolygon(this.plane, p, this.polygons, this.polygons, front, back);
    if (front.length) { (this.front ??= new Node()).build(front); }
    if (back.length) { (this.back ??= new Node()).build(back); }
  }
  clipPolygons(polygons: Polygon[]): Polygon[] {
    if (!this.plane) return [...polygons];
    let front: Polygon[] = [], back: Polygon[] = [];
    for (const p of polygons) splitPolygon(this.plane, p, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return [...front, ...back];
  }
  clipTo(bsp: Node): void {
    this.polygons = bsp.clipPolygons(this.polygons);
    this.front?.clipTo(bsp);
    this.back?.clipTo(bsp);
  }
  invert(): void {
    this.polygons = this.polygons.map(flipPolygon);
    if (this.plane) this.plane = flipPlane(this.plane);
    const t = this.front; this.front = this.back; this.back = t;
    this.front?.invert();
    this.back?.invert();
  }
  allPolygons(): Polygon[] {
    return [...this.polygons, ...(this.front?.allPolygons() ?? []), ...(this.back?.allPolygons() ?? [])];
  }
}

export type BooleanOp = 'union' | 'subtract' | 'intersect';

/**
 * CSG on two triangle sets. Returns a flat-shaded, non-indexed triangle list ({ positions, normals } — 3 entries
 * per triangle) in the input space. Empty if the result has no geometry.
 */
export function booleanMesh(trisA: Tri[], trisB: Tri[], op: BooleanOp): { positions: V3[]; normals: V3[] } {
  const A = new Node(); A.build(trisA.map(t => polygon([t.a, t.b, t.c])));
  const B = new Node(); B.build(trisB.map(t => polygon([t.a, t.b, t.c])));

  if (op === 'union') {
    A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.allPolygons());
  } else if (op === 'subtract') {
    A.invert(); A.clipTo(B); B.clipTo(A); B.invert(); B.clipTo(A); B.invert(); A.build(B.allPolygons()); A.invert();
  } else {   // intersect
    A.invert(); B.clipTo(A); B.invert(); A.clipTo(B); B.clipTo(A); A.build(B.allPolygons()); A.invert();
  }

  const positions: V3[] = [], normals: V3[] = [];
  for (const p of A.allPolygons()) {
    const n = p.plane.normal;
    for (let i = 2; i < p.verts.length; i++) {   // fan-triangulate the (convex) polygon
      positions.push(p.verts[0], p.verts[i - 1], p.verts[i]);
      normals.push(n, n, n);
    }
  }
  return { positions, normals };
}
