/**
 * BrushStabilizer — smooths raw pointer input to produce cleaner strokes.
 *
 * Supports four methods:
 *  • 'moving-average': low-latency weighted average of the last N points.
 *  • 'predictive': pulls the output toward the latest raw point but dampens jitter.
 *  • 'catmull-rom': fits a Catmull-Rom spline through recent points for smooth curves.
 *  • 'pull-string': simulates dragging a string — brush only moves when string goes taut.
 *
 * Level controls the window size / damping strength (0 = off, 10 = maximum).
 */

import { BrushStabilization } from './brush-preset';

export interface StabilizedPoint {
  x: number;
  y: number;
  pressure: number;
  /** Timestamp (ms) for velocity calculations. */
  timestamp: number;
  /** Pen tilt X in degrees (-90 to 90). */
  tiltX?: number;
  /** Pen tilt Y in degrees (-90 to 90). */
  tiltY?: number;
}

export class BrushStabilizer {
  private method: BrushStabilization['method'];
  private level: number;

  // Ring buffer for moving-average & catmull-rom
  private buffer: StabilizedPoint[] = [];
  private maxWindow: number = 1;

  // Predictive state
  private smoothX = 0;
  private smoothY = 0;
  private smoothP = 0;
  private smoothTiltX = 0;
  private smoothTiltY = 0;
  private initialized = false;

  // Pull-string state
  private stringLength = 30;
  private anchorX = 0;
  private anchorY = 0;
  private anchorP = 0;
  private anchorTiltX = 0;
  private anchorTiltY = 0;

  constructor(config: BrushStabilization) {
    this.method = config.method;
    this.level = Math.max(0, Math.min(10, config.level));
    this.maxWindow = Math.max(1, Math.round(this.level * 2)); // level 5 → window 10
    this.stringLength = config.pullStringLength ?? 30;
  }

  /** Call once at stroke start to reset state. */
  public reset(): void {
    this.buffer.length = 0;
    this.initialized = false;
  }

  /** Update the stabilization settings (e.g. when the user changes brush). */
  public configure(config: BrushStabilization): void {
    this.method = config.method;
    this.level = Math.max(0, Math.min(10, config.level));
    this.maxWindow = Math.max(1, Math.round(this.level * 2));
    this.stringLength = config.pullStringLength ?? 30;
    this.reset();
  }

  /**
   * Feed a raw pointer event. Returns the smoothed point.
   */
  public push(raw: StabilizedPoint): StabilizedPoint {
    if (this.method === 'none' || this.level === 0) {
      return raw;
    }

    if (this.method === 'moving-average') {
      return this.pushMovingAverage(raw);
    }

    if (this.method === 'catmull-rom') {
      return this.pushCatmullRom(raw);
    }

    if (this.method === 'pull-string') {
      return this.pushPullString(raw);
    }

    return this.pushPredictive(raw);
  }

  /**
   * Called at stroke end to flush remaining latency.
   * Returns any final smoothed points needed to reach the actual endpoint.
   */
  public flush(endpoint: StabilizedPoint): StabilizedPoint[] {
    if (this.method === 'none' || this.level === 0) {
      return [endpoint];
    }
    // Emit the raw endpoint so the stroke finishes exactly where the pen lifted
    this.reset();
    return [endpoint];
  }

  // ── Moving Average ────────────────────────────────────────────────

  private pushMovingAverage(raw: StabilizedPoint): StabilizedPoint {
    this.buffer.push(raw);
    if (this.buffer.length > this.maxWindow) {
      this.buffer.shift();
    }

    // Weighted average: newer points count more
    let totalW = 0;
    let sx = 0, sy = 0, sp = 0, stx = 0, sty = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const w = i + 1; // linearly increasing weight
      const p = this.buffer[i];
      sx += p.x * w;
      sy += p.y * w;
      sp += p.pressure * w;
      stx += (p.tiltX ?? 0) * w;
      sty += (p.tiltY ?? 0) * w;
      totalW += w;
    }

    return {
      x: sx / totalW,
      y: sy / totalW,
      pressure: sp / totalW,
      timestamp: raw.timestamp,
      tiltX: stx / totalW,
      tiltY: sty / totalW,
    };
  }

  // ── Predictive (exponential smoothing) ────────────────────────────

  private pushPredictive(raw: StabilizedPoint): StabilizedPoint {
    // Damping factor: level 1 → alpha≈0.6, level 10 → alpha≈0.05
    const alpha = 1.0 / (1.0 + this.level * 1.5);

    if (!this.initialized) {
      this.smoothX = raw.x;
      this.smoothY = raw.y;
      this.smoothP = raw.pressure;
      this.smoothTiltX = raw.tiltX ?? 0;
      this.smoothTiltY = raw.tiltY ?? 0;
      this.initialized = true;
      return raw;
    }

    this.smoothX += (raw.x - this.smoothX) * alpha;
    this.smoothY += (raw.y - this.smoothY) * alpha;
    this.smoothP += (raw.pressure - this.smoothP) * alpha;
    this.smoothTiltX += ((raw.tiltX ?? 0) - this.smoothTiltX) * alpha;
    this.smoothTiltY += ((raw.tiltY ?? 0) - this.smoothTiltY) * alpha;

    return {
      x: this.smoothX,
      y: this.smoothY,
      pressure: this.smoothP,
      timestamp: raw.timestamp,
      tiltX: this.smoothTiltX,
      tiltY: this.smoothTiltY,
    };
  }

  // ── Catmull-Rom Spline ────────────────────────────────────────────

  /**
   * Uses a Catmull-Rom spline fitted through the last 4 points.
   * Evaluates at t=0.5 (midpoint of P1-P2 segment) for a smooth,
   * low-latency output that follows the natural curvature of the stroke.
   * Higher level = more points in the buffer = smoother but more latent.
   */
  private pushCatmullRom(raw: StabilizedPoint): StabilizedPoint {
    this.buffer.push(raw);
    const windowSize = Math.max(4, Math.round(this.level * 1.5) + 3);
    if (this.buffer.length > windowSize) {
      this.buffer.shift();
    }

    // Need at least 4 points for Catmull-Rom
    if (this.buffer.length < 4) {
      return this.pushMovingAverage(raw);
    }

    // Use the last 4 points
    const n = this.buffer.length;
    const p0 = this.buffer[n - 4];
    const p1 = this.buffer[n - 3];
    const p2 = this.buffer[n - 2];
    const p3 = this.buffer[n - 1];

    // Evaluate at t based on level — higher level = evaluate closer to center
    // level 1 → t=0.85 (close to raw), level 10 → t=0.5 (smooth midpoint)
    const t = 0.85 - (this.level - 1) * 0.035 / 9 * (this.level - 1);
    const tClamped = Math.max(0.4, Math.min(0.9, 0.9 - this.level * 0.05));

    return {
      x: this.catmullRomInterp(p0.x, p1.x, p2.x, p3.x, tClamped),
      y: this.catmullRomInterp(p0.y, p1.y, p2.y, p3.y, tClamped),
      pressure: this.catmullRomInterp(p0.pressure, p1.pressure, p2.pressure, p3.pressure, tClamped),
      timestamp: raw.timestamp,
      tiltX: this.catmullRomInterp(p0.tiltX ?? 0, p1.tiltX ?? 0, p2.tiltX ?? 0, p3.tiltX ?? 0, tClamped),
      tiltY: this.catmullRomInterp(p0.tiltY ?? 0, p1.tiltY ?? 0, p2.tiltY ?? 0, p3.tiltY ?? 0, tClamped),
    };
  }

  /** Catmull-Rom spline interpolation between p1 and p2. */
  private catmullRomInterp(
    v0: number,
    v1: number,
    v2: number,
    v3: number,
    t: number,
  ): number {
    // Standard Catmull-Rom formula with tension = 0.5
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * v1) +
      (-v0 + v2) * t +
      (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
      (-v0 + 3 * v1 - 3 * v2 + v3) * t3
    );
  }

  // ── Pull-String ───────────────────────────────────────────────────

  /**
   * Simulates dragging a string. The brush "anchor" only moves when
   * the cursor pulls far enough that the string goes taut. This produces
   * very deliberate, controlled lines — ideal for precise inking.
   */
  private pushPullString(raw: StabilizedPoint): StabilizedPoint {
    if (!this.initialized) {
      this.anchorX = raw.x;
      this.anchorY = raw.y;
      this.anchorP = raw.pressure;
      this.anchorTiltX = raw.tiltX ?? 0;
      this.anchorTiltY = raw.tiltY ?? 0;
      this.initialized = true;
      return raw;
    }

    const dx = raw.x - this.anchorX;
    const dy = raw.y - this.anchorY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const len = this.stringLength * (1 + this.level * 0.3); // level scales string length

    if (dist > len) {
      // String is taut — move anchor toward cursor
      const pull = dist - len;
      const ratio = pull / dist;
      this.anchorX += dx * ratio;
      this.anchorY += dy * ratio;
    }

    // Pressure and tilt follow immediately (no spatial smoothing)
    this.anchorP = raw.pressure;
    this.anchorTiltX = raw.tiltX ?? 0;
    this.anchorTiltY = raw.tiltY ?? 0;

    return {
      x: this.anchorX,
      y: this.anchorY,
      pressure: this.anchorP,
      timestamp: raw.timestamp,
      tiltX: this.anchorTiltX,
      tiltY: this.anchorTiltY,
    };
  }
}
