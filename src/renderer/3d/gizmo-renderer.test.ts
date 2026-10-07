/**
 * Rotate-gizmo ring drawing: near/far half classification (ortho + perspective), the near-half-only
 * hit test, and the painter's sort that makes the nearer ring win where two cross.
 */
import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import {
  GizmoRenderer,
  buildGizmoGeometry,
  computeGizmoViewLocal,
  hitRotateRing,
  isRingPointFront,
  ringFrontness,
  ringPointFacing,
  sortGizmoTrianglesBackToFront,
  RING_HIT_MIN_FACING,
  type GizmoViewLocal,
} from './gizmo-renderer';
import { Camera3D } from './camera-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';

const I = mat4.create();
const ortho = (pos: number[], target: number[] = [0, 0, 0]) => computeGizmoViewLocal('orthographic', pos, target, I);
const persp = (pos: number[], target: number[] = [0, 0, 0]) => computeGizmoViewLocal('perspective', pos, target, I);

/** Ortho camera at elevation `el` (radians) above the XZ plane, looking at the origin from +Z. */
function elevatedDir(el: number): [number, number, number] { return [0, Math.sin(el), Math.cos(el)]; }

describe('rotate gizmo — near/far classification', () => {
  it('ortho: toCam is minus the view direction, the same for every point', () => {
    const v = ortho([3, 4, 10], [3, 4, 0]);   // looking straight down -Z (gizmo off-centre on screen)
    expect(v.camPos).toBeNull();
    expect(v.toCam[2]).toBeCloseTo(1);
    expect(isRingPointFront([0, 0, 1], v)).toBe(true);
    expect(isRingPointFront([0, 0, -1], v)).toBe(false);
    // A ring seen face-on (Z ring in an ortho front view) is entirely near — never half-dimmed.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      expect(isRingPointFront([Math.cos(a), Math.sin(a), 0], v)).toBe(true);
      expect(ringFrontness(ringPointFacing([Math.cos(a), Math.sin(a), 0], v))).toBe(1);
    }
  });

  it('perspective: toCam is centre → camera, so an off-axis camera splits the ring differently from ortho', () => {
    // Camera at (10, 0, 10) looking straight down -Z at (10, 0, 0); gizmo at the origin (off to the side).
    const o = ortho([10, 0, 10], [10, 0, 0]);
    const p = persp([10, 0, 10], [10, 0, 0]);
    expect(p.camPos).toEqual([10, 0, 10]);
    expect(p.toCam[0]).toBeCloseTo(Math.SQRT1_2);
    expect(p.toCam[2]).toBeCloseTo(Math.SQRT1_2);
    // Ortho: the Z ring is face-on (all near). Perspective: the camera sees it from the +X side, so its −X
    // side is the far half.
    expect(isRingPointFront([-1, 0, 0], o)).toBe(true);
    expect(isRingPointFront([-1, 0, 0], p)).toBe(false);
    expect(isRingPointFront([1, 0, 0], p)).toBe(true);
  });

  it('works in gizmo-local space (local orientation / scaled gizmo)', () => {
    // Gizmo at (5,0,0), rotated 90° about Y (local +Z → world +X), scale 2.
    const model = mat4.create();
    mat4.translate(model, model, [5, 0, 0]);
    mat4.rotateY(model, model, Math.PI / 2);
    mat4.scale(model, model, [2, 2, 2]);
    const inv = mat4.invert(mat4.create(), model)!;
    // Camera on world +X looking at the gizmo → toward the camera is local +Z.
    const o = computeGizmoViewLocal('orthographic', [20, 0, 0], [5, 0, 0], inv);
    expect(o.toCam[2]).toBeCloseTo(1);
    const p = computeGizmoViewLocal('perspective', [25, 0, 0], [5, 0, 0], inv);
    expect(p.toCam[2]).toBeCloseTo(1);
    expect(p.camPos![2]).toBeCloseTo(10);   // 20 world units / scale 2
  });

  it('frontness fades smoothly: 1 at / above the horizon, 0 well behind it', () => {
    expect(ringFrontness(1)).toBe(1);
    expect(ringFrontness(0)).toBe(1);
    expect(ringFrontness(-0.5)).toBe(0);
    let prev = 0;
    for (let f = -0.3; f <= 0.05; f += 0.01) { const k = ringFrontness(f); expect(k).toBeGreaterThanOrEqual(prev); prev = k; }
    expect(RING_HIT_MIN_FACING).toBeLessThan(0);
    expect(RING_HIT_MIN_FACING).toBeGreaterThan(-0.12);
  });
});

/** Ray from an ortho camera (direction −toCam) through the point `p` (gizmo-local). */
function orthoRayThrough(p: number[], toCam: number[]): { o: number[]; d: number[] } {
  return { o: [p[0] + toCam[0] * 20, p[1] + toCam[1] * 20, p[2] + toCam[2] * 20], d: [-toCam[0], -toCam[1], -toCam[2]] };
}
function perspRayThrough(p: number[], cam: number[]): { o: number[]; d: number[] } {
  const d = vec3.normalize(vec3.create(), [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]]);
  return { o: cam, d: [d[0], d[1], d[2]] };
}

describe('rotate gizmo — hit test prefers / requires the near half', () => {
  // Looking down at 30°; a point on the FAR half of the Y ring (it lies in the XZ plane).
  const toCam = elevatedDir(Math.PI / 6);
  const a = (40 * Math.PI) / 180;
  const yBack = [Math.sin(a), 0, -Math.cos(a)];
  const yFront = [Math.sin(a), 0, Math.cos(a)];

  it('ortho: a ray through only the far half of a ring no longer grabs it', () => {
    const view: GizmoViewLocal = { toCam, camPos: null };
    const r = orthoRayThrough(yBack, toCam);
    expect(hitRotateRing(r.o, r.d, 'y', 1)).not.toBeNull();         // old behaviour: whole ring grabbable
    expect(hitRotateRing(r.o, r.d, 'y', 1, view)).toBeNull();       // far half: not grabbable
    const f = orthoRayThrough(yFront, toCam);
    expect(hitRotateRing(f.o, f.d, 'y', 1, view)).not.toBeNull();   // near half: grabbable
  });

  it('perspective: same, using the per-camera split', () => {
    const cam = [0, 6, 10.4];   // ~12 gizmo radii away, 30° up (the default gizmo size at a 45° fov)
    const view = computeGizmoViewLocal('perspective', cam, [0, 0, 0], I);
    const r = perspRayThrough(yBack, cam);
    expect(hitRotateRing(r.o, r.d, 'y', 1)).not.toBeNull();
    expect(hitRotateRing(r.o, r.d, 'y', 1, view)).toBeNull();
    const f = perspRayThrough(yFront, cam);
    expect(hitRotateRing(f.o, f.d, 'y', 1, view)).not.toBeNull();
  });

  it('an edge-on ring hit through both halves returns the NEAR crossing', () => {
    // Ortho front view: the X ring (YZ plane) is an edge-on line; a ray at y=0.5 crosses it twice.
    const view = ortho([0, 0, 10]);
    const o = [0, 0.5, 10], d = [0, 0, -1];
    const t = hitRotateRing(o, d, 'x', 1, view)!;
    expect(t).not.toBeNull();
    expect(o[2] + t * d[2]).toBeGreaterThan(0);   // the hit is on the +Z (camera) side
  });

  it('touch hit scale (×2) still widens the near-half band', () => {
    const steep = elevatedDir(Math.PI / 3);   // steeper view, so the ring's wall band doesn't catch the ray
    const view: GizmoViewLocal = { toCam: steep, camPos: null };
    // Just outside the mouse band (radius 1.18 → 1.25), on the near half.
    const p = [Math.sin(a) * 1.25, 0, Math.cos(a) * 1.25];
    const r = orthoRayThrough(p, steep);
    expect(hitRotateRing(r.o, r.d, 'y', 1, view)).toBeNull();
    expect(hitRotateRing(r.o, r.d, 'y', 2, view)).not.toBeNull();
  });

  it('GizmoRenderer.hitTest (rotate) ignores far halves and keeps near-half hits, local + world', () => {
    const gr = Object.create(GizmoRenderer.prototype) as GizmoRenderer;
    gr.hitScale = 1;
    for (const orientation of ['world', 'local'] as const) {
      gr.orientationMode = orientation;
      const mesh = { localMatrix: mat4.create() } as unknown as Mesh3D;   // identity: local == world axes
      for (const mode of ['orthographic', 'perspective'] as const) {
        const cam = new Camera3D({ position: [0, 6, 10.4], target: [0, 0, 0], mode, orthoSize: 5 });
        const scale = GizmoRenderer.computeGizmoScale(cam, vec3.create());
        const toWorld = (p: number[]) => vec3.fromValues(p[0] * scale, p[1] * scale, p[2] * scale);
        const ray = (p: number[]) => {
          const w = toWorld(p);
          if (mode === 'perspective') {
            return { o: vec3.clone(cam.position), d: vec3.normalize(vec3.create(), vec3.sub(vec3.create(), w, cam.position)) };
          }
          const dir = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), cam.target, cam.position));
          return { o: vec3.scaleAndAdd(vec3.create(), w, dir, -50), d: dir };
        };
        const front = ray(yFront), back = ray(yBack);
        expect(gr.hitTest(front.o, front.d, [mesh], cam, 'rotate')).toBe('y');
        expect(gr.hitTest(back.o, back.d, [mesh], cam, 'rotate')).not.toBe('y');
      }
    }
  });
});

describe('rotate gizmo — drawing', () => {
  /** Alpha of every vertex of the rotate geometry, keyed by facing. */
  function ringAlphas(view: GizmoViewLocal) {
    const g = buildGizmoGeometry('rotate', null, null, view);
    const out: { facing: number; alpha: number; r: number }[] = [];
    for (let i = 0; i < g.vertCount; i++) {
      const p = [g.verts[i * 7], g.verts[i * 7 + 1], g.verts[i * 7 + 2]];
      out.push({ facing: ringPointFacing(p, view), alpha: g.verts[i * 7 + 6], r: Math.hypot(p[0], p[1], p[2]) });
    }
    return { g, out };
  }

  it('near half full alpha, far half dim (ortho and perspective)', () => {
    for (const view of [ortho([0, 6, 10.4]), persp([0, 6, 10.4])]) {
      const { out } = ringAlphas(view);
      const ring = out.filter(v => v.alpha > 0.25);   // excludes the faint silhouette (alpha 0.22)
      const near = ring.filter(v => v.facing > 0.1), far = ring.filter(v => v.facing < -0.2);
      expect(near.length).toBeGreaterThan(20);
      expect(far.length).toBeGreaterThan(20);
      for (const v of near) expect(v.alpha).toBeCloseTo(1);
      for (const v of far) expect(v.alpha).toBeCloseTo(0.3);
    }
  });

  it('triangles are ordered far → near (the nearer ring segment draws last)', () => {
    const view = ortho([0, 6, 10.4]);
    const { g } = ringAlphas(view);
    const depth = (t: number) => {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        const i = g.idxs[t * 3 + k] * 7;
        s += -(g.verts[i] * view.toCam[0] + g.verts[i + 1] * view.toCam[1] + g.verts[i + 2] * view.toCam[2]);
      }
      return s / 3;
    };
    // The silhouette circle draws first (underneath); from there on depth never increases.
    const tris = g.idxCount / 3;
    const silTris = 64 * 2;
    for (let t = silTris + 1; t < tris; t++) expect(depth(t)).toBeLessThanOrEqual(depth(t - 1) + 1e-5)   // f32 vertex rounding;
  });

  it('dragging shows only the dragged ring', () => {
    const view = ortho([0, 6, 10.4]);
    const all = buildGizmoGeometry('rotate', null, null, view);
    const one = buildGizmoGeometry('rotate', null, 'y', view);
    expect(one.idxCount).toBeLessThan(all.idxCount);
    expect(all.idxCount - one.idxCount).toBe(2 * 64 * 6);   // two rings × 64 quads × 6 indices
  });
});

describe('painter sort', () => {
  const tri = (z: number) => [-1, 0, z, 1, 1, 1, 1, 1, 0, z, 1, 1, 1, 1, 0, 1, z, 1, 1, 1, 1];

  it('ortho: sorts by depth along the view axis', () => {
    const verts = [...tri(1), ...tri(-1), ...tri(0)];   // near, far, middle
    const idxs = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    sortGizmoTrianglesBackToFront(verts, idxs, ortho([0, 0, 10]));
    expect(idxs).toEqual([3, 4, 5, 6, 7, 8, 0, 1, 2]);   // far, middle, near
  });

  it('perspective: sorts by distance to the eye; fromIdx leaves the prefix alone', () => {
    const verts = [...tri(-1), ...tri(1), ...tri(-1)];
    const idxs = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    sortGizmoTrianglesBackToFront(verts, idxs, persp([0, 0, -10]), 3);   // eye on −Z: z=+1 is the far one
    expect(idxs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const idxs2 = [0, 1, 2, 6, 7, 8, 3, 4, 5];
    sortGizmoTrianglesBackToFront(verts, idxs2, persp([0, 0, -10]), 3);
    expect(idxs2).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
