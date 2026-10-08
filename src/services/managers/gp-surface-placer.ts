/**
 * GpSurfacePlacer — Grease Pencil "Surface" placement (DOM-free, so it is unit tested).
 *
 * Every sample of a stroke is put ONTO the target mesh under the pen (a raycast), lifted `offset` world units along
 * the hit face's normal (turned toward the viewer) so the line clears the surface instead of z-fighting / hiding in it.
 * Between two pointer samples the screen path is re-projected, so a fast stroke across a curved surface (a head, a
 * sphere) follows it instead of cutting a straight chord through it:
 *  - the path is cut into chunks of at most {@link STEP_PX} screen pixels, each chunk end re-projected;
 *  - inside a chunk, the screen midpoint is re-projected and compared with the 3D chord's midpoint: while they are
 *    further apart than `tolerance` (default half the offset) the halves are subdivided again (adaptive, down to
 *    {@link MIN_PX} px / {@link MAX_DEPTH} levels), so on a flat face no extra points are made.
 * A sample whose ray MISSES the mesh breaks the stroke: the placer emits the last hit found next to the silhouette
 * (bisected to ~{@link MIN_PX} px), then a `break`. When the pen comes back onto the mesh the next hit starts a new
 * piece (the host begins a new stroke with the same style).
 */

/** A ray hit on the target surface. `rayDir` is the view ray's direction (orients the normal toward the viewer). */
export interface GpSurfaceHit {
  point: [number, number, number];
  normal: [number, number, number];
  rayDir: [number, number, number];
}

/** Raycast the target mesh through a client (CSS px) point. */
export type GpSurfaceRaycast = (clientX: number, clientY: number) => GpSurfaceHit | null;

/** What the placer emits, in order: a placed point (already lifted) or a break (the stroke left the mesh). */
export type GpPlacedEvent =
  | { kind: 'point'; x: number; y: number; z: number; pressure: number }
  | { kind: 'break' };

interface Sample {
  sx: number; sy: number; pressure: number;
  /** Lifted point, or null on a miss. */
  p: [number, number, number] | null;
}

export class GpSurfacePlacer {
  /** Longest screen step (CSS px) between re-projected samples before the adaptive test. */
  static STEP_PX = 16;
  /** Smallest screen step (CSS px) the adaptive subdivision / silhouette bisection goes down to. */
  static MIN_PX = 1.5;
  /** Subdivision depth cap per chunk (2^MAX_DEPTH pieces at most). */
  static MAX_DEPTH = 5;
  /** Chunks per sample at most (a jump across the screen is not re-projected every 16 px beyond this). */
  static MAX_CHUNKS = 64;

  private last: Sample | null = null;
  private lastEmitted: 'point' | 'break' | null = null;
  private out: GpPlacedEvent[] = [];
  private readonly tol: number;

  constructor(
    private readonly raycast: GpSurfaceRaycast,
    private readonly offset: number,
    tolerance?: number,
  ) {
    this.tol = tolerance ?? Math.max(offset * 0.5, 1e-4);
  }

  /** Whether the latest sample was on the mesh. */
  get onSurface(): boolean { return !!this.last?.p; }

  /** Place one pointer sample. Returns the events it produced (points between the previous sample and this one,
   *  then this one), possibly none. */
  sample(clientX: number, clientY: number, pressure = 1): GpPlacedEvent[] {
    this.out = [];
    const cur = this.at(clientX, clientY, pressure);
    const prev = this.last;
    if (prev) {
      const len = Math.hypot(cur.sx - prev.sx, cur.sy - prev.sy);
      const n = Math.min(GpSurfacePlacer.MAX_CHUNKS, Math.max(1, Math.ceil(len / GpSurfacePlacer.STEP_PX)));
      let a = prev;
      for (let i = 1; i <= n; i++) {
        const b = i === n ? cur : this.lerpSample(prev, cur, i / n);
        this.segment(a, b, 0);
        this.emit(b);
        a = b;
      }
    } else {
      this.emit(cur);
    }
    this.last = cur;
    return this.out;
  }

  /** Re-project the screen point a fraction `t` of the way from `a` to `b`. */
  private lerpSample(a: Sample, b: Sample, t: number): Sample {
    return this.at(a.sx + (b.sx - a.sx) * t, a.sy + (b.sy - a.sy) * t, a.pressure + (b.pressure - a.pressure) * t);
  }

  private at(sx: number, sy: number, pressure: number): Sample {
    const h = this.raycast(sx, sy);
    if (!h) return { sx, sy, pressure, p: null };
    let [nx, ny, nz] = h.normal;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    if (nx * h.rayDir[0] + ny * h.rayDir[1] + nz * h.rayDir[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }   // face the viewer
    const o = this.offset;
    return { sx, sy, pressure, p: [h.point[0] + nx * o, h.point[1] + ny * o, h.point[2] + nz * o] };
  }

  /** Emit the samples strictly between `a` and `b` (both already placed) that keep the line on the surface. */
  private segment(a: Sample, b: Sample, depth: number): void {
    if (!a.p && !b.p) return;                                   // off the mesh at both ends
    if (depth >= GpSurfacePlacer.MAX_DEPTH || Math.hypot(b.sx - a.sx, b.sy - a.sy) < GpSurfacePlacer.MIN_PX) return;
    const m = this.lerpSample(a, b, 0.5);
    if (a.p && b.p && m.p) {
      const cx = (a.p[0] + b.p[0]) * 0.5, cy = (a.p[1] + b.p[1]) * 0.5, cz = (a.p[2] + b.p[2]) * 0.5;
      if (Math.hypot(m.p[0] - cx, m.p[1] - cy, m.p[2] - cz) <= this.tol) return;   // the chord hugs the surface
    }
    this.segment(a, m, depth + 1);
    this.emit(m);
    this.segment(m, b, depth + 1);
  }

  private emit(s: Sample): void {
    if (s.p) {
      this.out.push({ kind: 'point', x: s.p[0], y: s.p[1], z: s.p[2], pressure: s.pressure });
      this.lastEmitted = 'point';
    } else if (this.lastEmitted === 'point') {
      this.out.push({ kind: 'break' });
      this.lastEmitted = 'break';
    }
  }
}
