import { describe, it, expect } from 'vitest';
import { GpSurfacePlacer, type GpSurfaceHit, type GpPlacedEvent } from './gp-surface-placer';

// A unit sphere at the origin seen by a pinhole camera at (0, 0, 5) looking down -z: 400 x 400 px, focal 800 px, so the
// sphere covers a disc of ~163 px radius around (200, 200).
const F = 800, CX = 200, CY = 200, EYE: [number, number, number] = [0, 0, 5];
function rayAt(x: number, y: number): [number, number, number] {
  const dx = (x - CX) / F, dy = -(y - CY) / F, dz = -1;
  const l = Math.hypot(dx, dy, dz);
  return [dx / l, dy / l, dz / l];
}
const sphere = (x: number, y: number): GpSurfaceHit | null => {
  const d = rayAt(x, y);
  const b = EYE[0] * d[0] + EYE[1] * d[1] + EYE[2] * d[2];
  const c = EYE[0] ** 2 + EYE[1] ** 2 + EYE[2] ** 2 - 1;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  const p: [number, number, number] = [EYE[0] + d[0] * t, EYE[1] + d[1] * t, EYE[2] + d[2] * t];
  return { point: p, normal: [p[0], p[1], p[2]], rayDir: d };
};
const pointsOf = (evs: GpPlacedEvent[]) => evs.filter((e): e is Extract<GpPlacedEvent, { kind: 'point' }> => e.kind === 'point');
const len = (p: { x: number; y: number; z: number }) => Math.hypot(p.x, p.y, p.z);

describe('GpSurfacePlacer (Grease Pencil Surface placement)', () => {
  const OFFSET = 0.01;

  it('puts every point on the sphere, lifted by the offset along the normal', () => {
    const placer = new GpSurfacePlacer(sphere, OFFSET);
    const evs = [...placer.sample(120, 200), ...placer.sample(200, 150), ...placer.sample(290, 230)];
    const pts = pointsOf(evs);
    expect(evs.every(e => e.kind === 'point')).toBe(true);
    expect(pts.length).toBeGreaterThan(3);
    for (const p of pts) expect(len(p)).toBeCloseTo(1 + OFFSET, 9);
  });

  it('subdivides a fast stroke so the line between points stays on the surface (no chord through the sphere)', () => {
    const placer = new GpSurfacePlacer(sphere, OFFSET);
    // One jump from one side of the sphere to the other: a single chord would cut ~0.5 units deep into it.
    const pts = pointsOf([...placer.sample(60, 200), ...placer.sample(340, 200)]);
    expect(pts.length).toBeGreaterThan(10);
    let worst = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      worst = Math.min(worst, Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2));
    }
    // every segment midpoint stays above the surface: at most half the offset below the lifted points
    expect(worst).toBeGreaterThanOrEqual(1 + OFFSET * 0.5 - 1e-9);
    // pressure is interpolated along the subdivided path
    const placer2 = new GpSurfacePlacer(sphere, OFFSET);
    placer2.sample(100, 200, 0.2);
    const mid = pointsOf(placer2.sample(300, 200, 1));
    expect(mid[0].pressure).toBeGreaterThan(0.2);
    expect(mid[mid.length - 1].pressure).toBe(1);
  });

  it('adds no points on a flat face (only the samples themselves)', () => {
    const plane = (x: number, y: number): GpSurfaceHit | null => {
      const d = rayAt(x, y);
      const t = -EYE[2] / d[2];
      return { point: [EYE[0] + d[0] * t, EYE[1] + d[1] * t, 0], normal: [0, 0, -1], rayDir: d };   // normal faces away
    };
    const placer = new GpSurfacePlacer(plane, OFFSET);
    expect(pointsOf(placer.sample(100, 100))).toHaveLength(1);
    const evs = placer.sample(110, 100);                 // under one step: the end sample only
    expect(evs).toHaveLength(1);
    const p = pointsOf(evs)[0];
    expect(p.z).toBeCloseTo(OFFSET, 12);                 // the normal is turned toward the viewer (+z)
  });

  it('a miss breaks the stroke at the silhouette; coming back onto the mesh starts a new piece', () => {
    const placer = new GpSurfacePlacer(sphere, OFFSET);
    expect(placer.sample(5, 200)).toEqual([]);           // the press is off the sphere: nothing
    expect(placer.onSurface).toBe(false);
    const enter = placer.sample(200, 200);
    expect(enter[0].kind).toBe('point');                 // the first hit (the edge, bisected) starts the piece
    expect(pointsOf(enter)[0].x).toBeLessThan(-0.9);     // found next to the left silhouette
    const leave = placer.sample(395, 200);
    expect(leave[leave.length - 1]).toEqual({ kind: 'break' });
    const lastHit = pointsOf(leave).pop()!;
    expect(lastHit.x).toBeGreaterThan(0.9);              // the last hit is right at the right silhouette
    expect(len(lastHit)).toBeCloseTo(1 + OFFSET, 9);
    expect(placer.sample(398, 210)).toEqual([]);         // still off: no repeated breaks
    const back = placer.sample(300, 200);
    expect(back[0].kind).toBe('point');
    expect(back.filter(e => e.kind === 'break')).toHaveLength(0);
  });

  it('a stroke across a gap (off the mesh between two hits) is split there', () => {
    // two spheres side by side: x = -1.2 and x = +1.2
    const two = (x: number, y: number): GpSurfaceHit | null => {
      const d = rayAt(x, y);
      let best: GpSurfaceHit | null = null, bestT = Infinity;
      for (const cx of [-1.2, 1.2]) {
        const o = [EYE[0] - cx, EYE[1], EYE[2]];
        const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
        const disc = b * b - (o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - 1);
        if (disc < 0) continue;
        const t = -b - Math.sqrt(disc);
        if (t < bestT) { bestT = t; const p: [number, number, number] = [EYE[0] + d[0] * t, EYE[1] + d[1] * t, EYE[2] + d[2] * t]; best = { point: p, normal: [p[0] - cx, p[1], p[2]], rayDir: d }; }
      }
      return best;
    };
    const placer = new GpSurfacePlacer(two, 0);
    const evs = [...placer.sample(80, 200), ...placer.sample(320, 200)];
    expect(evs.filter(e => e.kind === 'break')).toHaveLength(1);
    const i = evs.findIndex(e => e.kind === 'break');
    expect(pointsOf(evs.slice(0, i)).every(p => p.x < 0)).toBe(true);
    expect(pointsOf(evs.slice(i)).every(p => p.x > 0)).toBe(true);
  });
});
