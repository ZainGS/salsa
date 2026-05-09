/**
 * ParticleEmitter3D — CPU-simulated billboard particle system.
 *
 * Extends Shape to participate in the scene graph (transforms, visibility,
 * serialization). Owns a pool of up to maxParticles particles and drives
 * them with Euler integration each tick(). The compact GPU data buffer
 * (position + size + color + textureIndex per particle) is rebuilt each
 * tick and read by Renderer3D.drawParticles().
 *
 * GPU layout per particle (48 bytes = 3 × vec4):
 *   px,py,pz,size       (16 bytes)
 *   cr,cg,cb,ca         (16 bytes)
 *   textureIndex,0,0,0  (16 bytes)
 */

import { Shape } from './base/shape';
import { InteractionService } from '../../services/interaction-service';
import type { Vec2 } from '../../types/interaction';
import type { RGBA } from '../../types/rgba';

// ── Exported constants ─────────────────────────────────────────────────────

/** Floats per particle in the compact GPU upload buffer. */
export const PARTICLE_GPU_FLOATS = 12; // 48 bytes

// ── Emitter config ─────────────────────────────────────────────────────────

export interface ParticleEmitterConfig {
  /** Hard cap on live particle count. */
  maxParticles?:    number;          // default 200
  /** New particles per second. */
  emitRate?:        number;          // default 30
  /** [min, max] particle lifetime in seconds. */
  lifetime?:        [number, number]; // default [1, 2]
  /** [min, max] initial size in world units. */
  startSize?:       [number, number]; // default [0.05, 0.15]
  /** [min, max] size at end of life (lerped from startSize over lifetime). */
  endSize?:         [number, number]; // default [0, 0]
  /** Particle colour at birth. */
  startColor?:      RGBA;            // default white
  /** Particle colour at death (lerped from startColor). */
  endColor?:        RGBA;            // default transparent white
  /** [min, max] initial speed along emit direction. */
  speed?:           [number, number]; // default [0.3, 0.8]
  /** Emission cone half-angle in radians (0 = point upward, π = sphere). */
  spread?:          number;          // default 0.4
  /** World-space gravity acceleration vector. */
  gravity?:         [number, number, number]; // default [0, -0.3, 0]
  /** Per-second random velocity kick (turbulence). */
  turbulence?:      number;          // default 0
  /** Emit direction in local space (normalized). Default = +Y. */
  direction?:       [number, number, number]; // default [0, 1, 0]
  /** Whether the emitter loops. If false, emits one burst then stops. */
  loop?:            boolean;         // default true
  /** Layer index into the shared texture_2d_array atlas (0 = white default). */
  textureIndex?:    number;          // default 0
  /** TextureLibrary IDs for flipbook animation. When set, textureIndex is ignored. */
  animTextures?:    string[];        // default []
  /** Seconds each animation frame is shown. */
  animFrameTime?:   number;          // default 0.1
}

// ── Preset factory ─────────────────────────────────────────────────────────

export type ParticlePreset = 'dust' | 'sparks' | 'snow' | 'magic';

const PRESETS: Record<ParticlePreset, ParticleEmitterConfig> = {
  dust: {
    maxParticles: 120,
    emitRate:     20,
    lifetime:     [1.5, 3.0],
    startSize:    [0.04, 0.12],
    endSize:      [0.0, 0.0],
    startColor:   { r: 0.85, g: 0.80, b: 0.70, a: 0.6 },
    endColor:     { r: 0.85, g: 0.80, b: 0.70, a: 0.0 },
    speed:        [0.05, 0.2],
    spread:       Math.PI,      // full sphere
    gravity:      [0, -0.04, 0],
    turbulence:   0.06,
  },
  sparks: {
    maxParticles: 80,
    emitRate:     40,
    lifetime:     [0.4, 1.0],
    startSize:    [0.03, 0.07],
    endSize:      [0.0, 0.0],
    startColor:   { r: 1.0, g: 0.9, b: 0.3, a: 1.0 },
    endColor:     { r: 1.0, g: 0.3, b: 0.0, a: 0.0 },
    speed:        [0.8, 2.0],
    spread:       0.6,
    gravity:      [0, -1.5, 0],
    turbulence:   0.1,
  },
  snow: {
    maxParticles: 200,
    emitRate:     30,
    lifetime:     [3.0, 6.0],
    startSize:    [0.04, 0.10],
    endSize:      [0.04, 0.10],
    startColor:   { r: 1.0, g: 1.0, b: 1.0, a: 0.8 },
    endColor:     { r: 1.0, g: 1.0, b: 1.0, a: 0.0 },
    speed:        [0.05, 0.15],
    spread:       Math.PI,
    gravity:      [0, -0.12, 0],
    turbulence:   0.08,
    direction:    [0, -1, 0],
  },
  magic: {
    maxParticles: 150,
    emitRate:     35,
    lifetime:     [0.8, 2.0],
    startSize:    [0.06, 0.14],
    endSize:      [0.0, 0.0],
    startColor:   { r: 0.6, g: 0.4, b: 1.0, a: 1.0 },
    endColor:     { r: 0.9, g: 0.7, b: 1.0, a: 0.0 },
    speed:        [0.15, 0.5],
    spread:       Math.PI,
    gravity:      [0, 0.1, 0],  // slight upward drift
    turbulence:   0.15,
  },
};

// ── Internal particle state ────────────────────────────────────────────────

// Compact flat array per particle (13 values):
// [0]=px,[1]=py,[2]=pz,[3]=vx,[4]=vy,[5]=vz,
// [6]=age,[7]=lifetime,[8]=startSize,[9]=endSize,[10]=sr,[11]=sg,[12]=sb,[13]=sa
//         [14]=er,[15]=eg,[16]=eb,[17]=ea
const P = 18; // floats per particle in the internal CPU pool

// ── Main class ─────────────────────────────────────────────────────────────

export class ParticleEmitter3D extends Shape {
  private _cfg!:  Required<ParticleEmitterConfig>;
  private _pool!: Float32Array;          // CPU particle state, P floats each
  private _count  = 0;                   // current live count
  private _emitAccum = 0;               // fractional particles to emit
  private _gpuData!: Float32Array;      // compact GPU upload buffer
  private _activeCount = 0;             // how many entries are valid in _gpuData

  /** Set true when gpuData has been rebuilt since last upload. */
  public gpuDirty = true;

  // ── Construction ──────────────────────────────────────────────────

  constructor(
    interactionService: InteractionService,
    x: number, y: number, z: number,
    config: ParticleEmitterConfig = {},
    preset?: ParticlePreset,
  ) {
    const defaultColor: RGBA = { r: 1, g: 1, b: 1, a: 1 };
    super(defaultColor, defaultColor, 1, interactionService);
    this._x = x;
    this._y = y;
    this._z = z;
    this._name = 'ParticleEmitter';
    this.updateLocalMatrix();
    this._applyConfig(preset ? { ...PRESETS[preset], ...config } : config);
  }

  private _applyConfig(config: ParticleEmitterConfig): void {
    this._cfg = {
      maxParticles:  config.maxParticles  ?? 200,
      emitRate:      config.emitRate      ?? 30,
      lifetime:      config.lifetime      ?? [1, 2],
      startSize:     config.startSize     ?? [0.05, 0.15],
      endSize:       config.endSize       ?? [0, 0],
      startColor:    config.startColor    ?? { r: 1, g: 1, b: 1, a: 1 },
      endColor:      config.endColor      ?? { r: 1, g: 1, b: 1, a: 0 },
      speed:         config.speed         ?? [0.3, 0.8],
      spread:        config.spread        ?? 0.4,
      gravity:       config.gravity       ?? [0, -0.3, 0],
      turbulence:    config.turbulence    ?? 0,
      direction:     config.direction     ?? [0, 1, 0],
      loop:          config.loop          ?? true,
      textureIndex:  config.textureIndex  ?? 0,
      animTextures:  config.animTextures  ?? [],
      animFrameTime: config.animFrameTime ?? 0.1,
    };
    this._pool    = new Float32Array(this._cfg.maxParticles * P);
    this._gpuData = new Float32Array(this._cfg.maxParticles * PARTICLE_GPU_FLOATS);
    this._count   = 0;
    this._emitAccum = 0;
  }

  // ── Public API ────────────────────────────────────────────────────

  get config(): Required<ParticleEmitterConfig> { return this._cfg; }
  get activeCount(): number                      { return this._activeCount; }
  get gpuData(): Float32Array                    { return this._gpuData; }

  setConfig(partial: ParticleEmitterConfig): void {
    this._applyConfig({ ...this._cfg, ...partial });
    this.gpuDirty = true;
  }

  // ── Type / scene-graph overrides ──────────────────────────────────

  getType(): string { return 'ParticleEmitter3D'; }

  protected getScaleFactors(): [number, number] { return [1, 1]; }

  calculateBoundingBox(): void {
    this._boundingBox = { x: this._x - 0.5, y: this._y - 0.5, width: 1, height: 1 };
  }

  getWorldSpaceBoundingBoxPolygon(): Vec2[] { return []; }
  getGeometryVertices(): Float32Array | null { return null; }
  getGeometryIndices(): Uint16Array | null   { return null; }

  // ── Simulation ────────────────────────────────────────────────────

  /**
   * Advance the simulation by `dt` seconds. Spawns new particles, integrates
   * existing ones, and rebuilds the compact GPU upload buffer.
   * Call once per render frame from Scene3DManager.tickParticles().
   */
  tick(dt: number): void {
    const cfg = this._cfg;
    const pool = this._pool;

    // ── Integrate existing particles ──────────────────────────────
    let writeIdx = 0;
    for (let i = 0; i < this._count; i++) {
      const b = i * P;
      pool[b + 6] += dt; // age
      if (pool[b + 6] >= pool[b + 7]) continue; // dead → drop (don't copy forward)

      // Euler integration
      pool[b + 3] += cfg.gravity[0] * dt;
      pool[b + 4] += cfg.gravity[1] * dt;
      pool[b + 5] += cfg.gravity[2] * dt;

      // Turbulence: random velocity kick
      if (cfg.turbulence > 0) {
        pool[b + 3] += (Math.random() * 2 - 1) * cfg.turbulence * dt;
        pool[b + 4] += (Math.random() * 2 - 1) * cfg.turbulence * dt;
        pool[b + 5] += (Math.random() * 2 - 1) * cfg.turbulence * dt;
      }

      pool[b + 0] += pool[b + 3] * dt;
      pool[b + 1] += pool[b + 4] * dt;
      pool[b + 2] += pool[b + 5] * dt;

      // Compact to front (in-place defrag)
      if (writeIdx !== i) {
        pool.copyWithin(writeIdx * P, b, b + P);
      }
      writeIdx++;
    }
    this._count = writeIdx;

    // ── Spawn new particles ───────────────────────────────────────
    if (cfg.loop || this._emitAccum >= 0) {
      this._emitAccum += cfg.emitRate * dt;
      const toSpawn = Math.floor(this._emitAccum);
      this._emitAccum -= toSpawn;

      for (let n = 0; n < toSpawn && this._count < cfg.maxParticles; n++) {
        this._spawnOne();
      }
    }

    this.gpuDirty = true;
  }

  private _spawnOne(): void {
    const cfg = this._cfg;
    const b   = this._count * P;
    const pool = this._pool;

    // World position = emitter world position (emitter transforms handled by matrix)
    const mat = this.localMatrix as unknown as Float32Array;
    pool[b + 0] = mat[12]; // world x
    pool[b + 1] = mat[13]; // world y
    pool[b + 2] = mat[14]; // world z

    // Velocity: cone around local direction, rotated by emitter world orientation
    const [dx, dy, dz] = cfg.direction;
    const spd = _lerp(cfg.speed[0], cfg.speed[1], Math.random());
    // Scatter direction within spread cone
    const theta = Math.random() * 2 * Math.PI;
    const phi   = Math.random() * cfg.spread;
    // Rotate direction by phi around a perpendicular axis
    const perp  = _perpendicular(dx, dy, dz);
    const [rx, ry, rz] = _rotateAroundAxis(dx, dy, dz, perp[0], perp[1], perp[2], phi);
    // Rotate around original direction by theta (spin around cone axis)
    const [fx, fy, fz] = _rotateAroundAxis(rx, ry, rz, dx, dy, dz, theta);
    // Transform by emitter world rotation (top-left 3x3 of localMatrix)
    pool[b + 3] = (mat[0]*fx + mat[4]*fy + mat[8]*fz) * spd;
    pool[b + 4] = (mat[1]*fx + mat[5]*fy + mat[9]*fz) * spd;
    pool[b + 5] = (mat[2]*fx + mat[6]*fy + mat[10]*fz) * spd;

    pool[b + 6] = 0; // age
    pool[b + 7] = _lerp(cfg.lifetime[0], cfg.lifetime[1], Math.random()); // lifetime
    pool[b + 8] = _lerp(cfg.startSize[0], cfg.startSize[1], Math.random()); // startSize
    pool[b + 9] = _lerp(cfg.endSize[0],   cfg.endSize[1],   Math.random()); // endSize

    pool[b + 10] = cfg.startColor.r;
    pool[b + 11] = cfg.startColor.g;
    pool[b + 12] = cfg.startColor.b;
    pool[b + 13] = cfg.startColor.a ?? 1;
    pool[b + 14] = cfg.endColor.r;
    pool[b + 15] = cfg.endColor.g;
    pool[b + 16] = cfg.endColor.b;
    pool[b + 17] = cfg.endColor.a ?? 0;

    this._count++;
  }

  /**
   * Build the compact GPU upload buffer from the current CPU particle pool.
   * Called by Renderer3D.drawParticles() each frame.
   *
   * @param animLayers  Resolved atlas layer indices for flipbook animation.
   *                    Must match the order of config.animTextures. Pass []
   *                    (or omit) to use the static config.textureIndex.
   */
  buildGPUData(animLayers: number[] = []): void {
    const gpu  = this._gpuData;
    const pool = this._pool;
    const cfg  = this._cfg;
    const dv   = new DataView(gpu.buffer);
    const useAnim = animLayers.length > 0 && cfg.animTextures.length > 0 && cfg.animFrameTime > 0;

    for (let i = 0; i < this._count; i++) {
      const b  = i * P;
      const g  = i * PARTICLE_GPU_FLOATS;
      const t  = pool[b + 6] / pool[b + 7]; // normalized age 0..1
      const tC = Math.min(1, Math.max(0, t));

      gpu[g + 0] = pool[b + 0];
      gpu[g + 1] = pool[b + 1];
      gpu[g + 2] = pool[b + 2];
      gpu[g + 3] = _lerp(pool[b + 8], pool[b + 9], tC);

      gpu[g + 4] = _lerp(pool[b + 10], pool[b + 14], tC);
      gpu[g + 5] = _lerp(pool[b + 11], pool[b + 15], tC);
      gpu[g + 6] = _lerp(pool[b + 12], pool[b + 16], tC);
      gpu[g + 7] = _lerp(pool[b + 13], pool[b + 17], tC);

      let texIdx = cfg.textureIndex;
      if (useAnim) {
        const frame = Math.floor(pool[b + 6] / cfg.animFrameTime) % animLayers.length;
        texIdx = animLayers[frame];
      }
      dv.setUint32((g + 8) * 4, texIdx, true);
      gpu[g + 9]  = 0;
      gpu[g + 10] = 0;
      gpu[g + 11] = 0;
    }

    this._activeCount = this._count;
    this.gpuDirty = false;
  }

  // ── Serialization ─────────────────────────────────────────────────

  toJSON(): any {
    return {
      type:   'ParticleEmitter3D',
      id:     this.id,
      x:      this.x,
      y:      this.y,
      z:      this.z,
      rotationX: this.rotationX,
      rotationY: this.rotationY,
      rotation:  this.rotation,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      scaleZ: this.scaleZ,
      name:   this.name,
      config: this._cfg,
    };
  }
}

// ── Math helpers ───────────────────────────────────────────────────────────

function _lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function _perpendicular(x: number, y: number, z: number): [number, number, number] {
  if (Math.abs(x) <= Math.abs(y) && Math.abs(x) <= Math.abs(z)) {
    const len = Math.sqrt(y * y + z * z);
    return len < 1e-6 ? [0, 1, 0] : [0, -z / len, y / len];
  } else if (Math.abs(y) <= Math.abs(z)) {
    const len = Math.sqrt(x * x + z * z);
    return len < 1e-6 ? [1, 0, 0] : [-z / len, 0, x / len];
  } else {
    const len = Math.sqrt(x * x + y * y);
    return len < 1e-6 ? [1, 0, 0] : [-y / len, x / len, 0];
  }
}

function _rotateAroundAxis(
  vx: number, vy: number, vz: number,
  ax: number, ay: number, az: number,
  angle: number,
): [number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = ax * vx + ay * vy + az * vz;
  const crx = ay * vz - az * vy;
  const cry = az * vx - ax * vz;
  const crz = ax * vy - ay * vx;
  return [
    vx * c + crx * s + ax * dot * (1 - c),
    vy * c + cry * s + ay * dot * (1 - c),
    vz * c + crz * s + az * dot * (1 - c),
  ];
}
