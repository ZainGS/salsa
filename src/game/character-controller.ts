/**
 * CharacterController — a first/third-person mover for Play mode (docs/specs/play-mode.md, docs/specs/free-camera-and-scene-targets.md L3).
 *
 * Pure kinematic integration (no physics engine): planar movement relative to the CAMERA yaw, gravity + jump, and
 * look (yaw + pitch). Collision against the real scene is injected as two optional callbacks so the controller stays
 * deterministic + unit-testable — the scene/camera wiring (and the raycast samplers that back those callbacks) lives in
 * Scene3DManager's Play mode; this file is just the math.
 *
 *  - groundSampler(x, z)      → world height of the STANDABLE ground under (x,z) — a surface no higher than the feet +
 *                               stepHeight (collision-math sampleStandableGround) — or null for "no ground here" (fall
 *                               to cfg.groundY).
 *  - moveResolver(fx,fz,tx,tz,r) → the resolved (x,z) for a horizontal move from (fx,fz) to (tx,tz) for a body of
 *                                 radius r; lets a wall block the into-wall component. Absent = move freely.
 *
 * TWO YAWS (R6.2, 2026-09-30). `yaw` is the LOOK / camera yaw (mouse, right stick, Q/E); `facing` is the BODY yaw.
 * Movement is relative to `yaw` (camera-relative: W = away from the camera, S = toward it, A/D = screen left/right).
 * In third-person the body turns smoothly toward the direction it is moving (exponential turn, capped at maxTurnSpeed)
 * and never turns with the mouse: standing still and orbiting leaves the character alone, and holding a direction
 * while orbiting runs in circles. In first-person `facing` = `yaw` (you are the camera).
 *
 * GAITS (Round 8). Three full-input speeds: WALK (`walkSpeed`, the Play default), RUN (`moveSpeed`, Shift toggles it in
 * the Play loop) and SNEAK (`sneakSpeed`, Ctrl held / C toggled; overrides run). An analog stick scales the active one.
 * The planar VELOCITY (a vector, so a reversal decelerates through zero instead of snapping round) moves toward the
 * target with max(an exponential step at acceleration / deceleration 1/s, a linear floor of groundAccel / groundDecel
 * units/s²): the exponential gives a soft landing on the target speed, the linear floor removes the long exponential
 * tail, so starts / stops are quick without a snap. 0 exponential rates = instant (tests). In the air the same rates
 * are scaled by airControl and releasing the stick keeps the momentum.
 *
 * JUMP (Round 8). Edge-triggered with a BUFFER (a press up to jumpBufferTime before landing still jumps) and COYOTE time
 * (a jump up to coyoteTime after walking off a ledge still works). Variable height: releasing the button while rising
 * multiplies gravity by jumpCutGravityMultiplier; past the apex gravity is fallGravityMultiplier × (snappy descent);
 * near the apex (|vy| < apexHangSpeed, button held) gravity is apexGravityMultiplier × (a short hang). Falls are capped
 * at maxFallSpeed. The tick that lands reports `landImpact` (the impact speed / jumpSpeed) for the landing animation.
 * WIND-UP (visual-polish item 13): with jumpWindup > 0 a jump from the GROUND first crouches for that long (the
 * animation's anticipation; locomotion().jumpWindup reports the 0→1 progress) and then launches; a coyote jump, or
 * leaving the ground mid-crouch, launches at once. 0 (the pure default) = launch on the press tick. Play uses ~0.06 s.
 */

import type { LocomotionState } from './locomotion';

export type Vec3 = [number, number, number];

export type CameraMode = 'first' | 'third';

export interface CharacterConfig {
  moveSpeed: number;     // world units / second (planar) at full input while RUNNING
  walkSpeed: number;     // full-input speed while WALKING (units/s) — the Play default gait
  sneakSpeed: number;    // full-input speed while SNEAKING (units/s)
  walkSpeedFactor: number; // legacy: > 0 = walk at moveSpeed × this instead of walkSpeed (0 = use walkSpeed)
  acceleration: number;  // 1/s exponential rate the planar velocity approaches a faster target (0 = instant)
  deceleration: number;  // 1/s exponential rate the planar velocity approaches a slower target (0 = instant)
  groundAccel: number;   // linear floor of the speed-up (units/s²) — no long exponential tail
  groundDecel: number;   // linear floor of the slow-down (units/s²)
  airControl: number;    // fraction of the ground acceleration available in the air (0..1)
  faceTurnRate: number;  // third-person: 1/s exponential rate the body turns toward its move direction (0 = instant)
  maxTurnSpeed: number;  // third-person: cap on the body's turn speed (rad/s)
  turnSpeed: number;     // radians / second (look yaw from keyboard Q/E look input)
  jumpSpeed: number;     // initial upward velocity on jump (units/s)
  gravity: number;       // downward accel (units/s²) while rising with the button held
  fallGravityMultiplier: number;    // gravity × this once past the apex (snappy descent)
  jumpCutGravityMultiplier: number; // gravity × this while rising after the button is released (variable height)
  apexGravityMultiplier: number;    // gravity × this near the apex with the button held (a short hang)
  apexHangSpeed: number;            // |vy| below this (units/s) counts as "near the apex"
  maxFallSpeed: number;             // terminal fall speed (units/s)
  coyoteTime: number;               // seconds after leaving the ground a jump still works
  jumpBufferTime: number;           // seconds a jump press is remembered before landing
  variableJumpHeight: boolean;      // releasing the button early cuts the jump (false = every jump is full height)
  /** Seconds a GROUND jump crouches before it launches (the anticipation; 0 = launch on the press tick). Optional so
   *  hand-built configs still type-check. */
  jumpWindup?: number;
  groundY: number;       // fallback flat ground height when no groundSampler hit (feet rest here)
  eyeHeight: number;     // camera/head offset above the feet position
  radius: number;        // body radius (for horizontal collision)
  stepHeight: number;    // max ground rise the character steps up onto instead of being blocked (curbs/stairs)
  cameraMode: CameraMode;        // first- or third-person framing
  thirdPersonDistance: number;   // camera distance behind the pivot in third-person
  thirdPersonHeight: number;     // extra height of the orbit pivot above the head in third-person (negative = below)
  thirdPersonFovDeg: number;     // third-person vertical field of view (degrees)
  /** Third-person SHOULDER offset (visual-polish #7a): the camera + its aim slide this far to the view's RIGHT, so the
   *  character sits left of centre (over-the-shoulder framing). 0 = centred (the pre-2026-10 framing). Pulled in when a
   *  wall is beside the character. Optional so older configs / hosts that build a full config by hand still type-check. */
  cameraShoulderOffset?: number;
  firstPersonFovDeg: number | null; // first-person FOV (degrees); null = leave the camera's FOV as it was
  cameraCollision: boolean;      // third-person: pull the camera in when a wall is between it and the character
  cameraCollisionPadding: number;// gap kept between the camera and a hit wall
  cameraCollisionRadius: number; // radius of the (ray-bundle) sphere cast used for camera collision
  cameraMinDistance: number;     // third-person: never let the camera get closer than this (avoid clipping the body)
  cameraFollowRate: number;      // third-person pivot follow smoothing, horizontal (1/s; higher = snappier; ≤0 = rigid)
  cameraVerticalFollowRate: number; // third-person pivot follow smoothing, vertical (1/s) — softer, absorbs steps / jumps
  cameraLookAhead: number;       // third-person: seconds of planar velocity the pivot leads the character by
  cameraRecoverRate: number;     // third-person: 1/s rate the camera eases back out after a collision pull-in
  pitchMin: number;      // look-pitch clamp (radians); down — first-person
  pitchMax: number;      // look-pitch clamp (radians); up — first-person
  thirdPersonPitchMin: number;   // third-person orbit pitch clamp (radians; negative = camera above, looking down)
  thirdPersonPitchMax: number;   // third-person orbit pitch clamp (radians; positive = camera below, looking up)
}

export const DEFAULT_CHARACTER: CharacterConfig = {
  moveSpeed: 5.2, walkSpeed: 1.6, sneakSpeed: 1.0, walkSpeedFactor: 0,
  acceleration: 10, deceleration: 12, groundAccel: 20, groundDecel: 24, airControl: 0.35,
  faceTurnRate: 16, maxTurnSpeed: 15,
  // Jump: ≈ 1.05 m full-hold height (6.5² / (2·20)) + a little apex hang; ≈ 0.55 m tap; ~0.6 s in the air.
  turnSpeed: 2.4, jumpSpeed: 6.5, gravity: 20, fallGravityMultiplier: 1.6, jumpCutGravityMultiplier: 2.6,
  apexGravityMultiplier: 0.55, apexHangSpeed: 1.2, maxFallSpeed: 30, coyoteTime: 0.1, jumpBufferTime: 0.12,
  variableJumpHeight: true, groundY: 0, eyeHeight: 1.6,
  // visual-polish #7a (2026-10-03): a tighter Persona-style follow — 3 m back (was 4.5), a chest-height pivot (1.3 m;
  // was 1.4), a 50 deg FOV (was 72) and a 0.35 m shoulder offset. Explicit host / saved Play settings still win.
  radius: 0.35, stepHeight: 0.4, cameraMode: 'first', thirdPersonDistance: 3.0, thirdPersonHeight: -0.3,
  thirdPersonFovDeg: 50, firstPersonFovDeg: null, cameraShoulderOffset: 0.35,
  cameraCollision: true, cameraCollisionPadding: 0.25, cameraCollisionRadius: 0.2, cameraMinDistance: 0.5,
  cameraFollowRate: 12, cameraVerticalFollowRate: 8, cameraLookAhead: 0.22, cameraRecoverRate: 4,
  pitchMin: -1.4, pitchMax: 1.4,   // ~±80°
  thirdPersonPitchMin: -1.25, thirdPersonPitchMax: 0.6,
};

/** The jump wind-up Play runs with (seconds; visual-polish item 13): long enough to read as an anticipation crouch,
 *  short enough (4 ticks) not to feel laggy. The pure controller default stays 0 (launch on the press tick). */
export const PLAY_JUMP_WINDUP = 0.06;

/**
 * Per-tick intent (from the host's input layer). forward/right ∈ [-1,1]; `look` = keyboard yaw-rate intent ∈ [-1,1]
 * (scaled by turnSpeed·dt). `lookYaw`/`lookPitch` are DIRECT radian deltas for mouse-look, so a host can drive
 * turning by keyboard (`look`), by mouse (`lookYaw`/`lookPitch`), or both.
 *
 * SIGN CONVENTIONS (2026-09-16 handedness fix): positive `right` strafes SCREEN-RIGHT; positive `look`/`lookYaw`
 * turns RIGHT (clockwise from above) — i.e. mouse-moved-right. In this engine's right-handed Y-up world a camera
 * facing +Z has screen-right = −X, and yaw is CCW about +Y (yaw+ turns LEFT), so the controller negates these
 * internally. The original code assumed the mirrored (-Z-forward) convention, which inverted A/D AND mouse turn.
 */
export interface CharacterInput {
  forward: number;
  right: number;
  look: number;
  jump: boolean;
  lookYaw?: number;
  lookPitch?: number;
  interact?: boolean;   // "use" key held — the Play loop edge-detects it (fires once per press), not the controller
}
export const NO_INPUT: CharacterInput = { forward: 0, right: 0, look: 0, jump: false };

const TAU = Math.PI * 2;
/** Wrap an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Turn `current` toward `target` (radians, shortest arc): exponential at `rate` (1/s), capped at `maxSpeed` rad/s.
 *  rate ≤ 0 snaps. Frame-rate independent. */
export function turnToward(current: number, target: number, rate: number, maxSpeed: number, dt: number): number {
  const d = wrapAngle(target - current);
  if (rate <= 0 || dt <= 0) return dt <= 0 ? current : wrapAngle(current + d);
  let step = d * (1 - Math.exp(-rate * dt));
  const cap = maxSpeed > 0 ? maxSpeed * dt : Infinity;
  if (step > cap) step = cap; else if (step < -cap) step = -cap;
  return wrapAngle(current + step);
}

export class CharacterController {
  cfg: CharacterConfig;
  pos: Vec3;          // FEET position
  vel: Vec3;          // velocity (.y integrated as gravity; .x/.z = the planar velocity of the last step)
  yaw: number;        // LOOK / camera yaw (radians), 0 = +Z forward
  pitch: number;      // look pitch (radians), + = up
  facing: number;     // BODY yaw (radians) — what the avatar mesh is driven with
  grounded: boolean;
  /** Run (true) or walk. The pure controller defaults to run (full input = moveSpeed, as before); Play starts in WALK
   *  (the Play loop sets this from its remembered state — Shift toggles it). */
  running = true;
  /** Sneak (overrides run): Ctrl held / C toggled in the Play loop. */
  sneaking = false;
  lastPlanarSpeed = 0;   // actual planar distance moved last step / dt (world units/s) — drives walk/run animation
  /** Impact speed / jumpSpeed on the tick the character LANDED (0 on every other tick) — the landing animation. */
  landImpact = 0;
  /** Seconds since the feet last touched the ground (0 while grounded). */
  airTime = 0;
  /** Previous-step feet + facing, for render interpolation between fixed steps (renderPos / renderFacing). */
  prevPos: Vec3;
  prevFacing: number;

  /** Planar velocity state (pre-collision, world units/s) and the last non-zero move direction (unit XZ). */
  private _vx = 0;
  private _vz = 0;
  private _dirX = 0;
  private _dirZ = 1;
  /** Jump state: the buffered press timer, the previous jump input (edge detection), whether this airborne phase is a
   *  jump (so the button-release cut applies) and whether the button is still held. */
  private _jumpBuffer = 0;
  private _prevJump = false;
  private _inJump = false;
  private _jumpHeld = false;
  /** Seconds of jump wind-up left (−1 = not winding up). */
  private _windup = -1;
  /** Third-person: the turn (rad, + = left) the body still has to make toward the move direction after this step. */
  private _turnRemaining = 0;
  /** Rise-bug safety net (2026-10-04): step-ups taken in a row while grounded WITHOUT moving horizontally. The first
   *  one is allowed (a spawn / teleport settling onto a kerb, a tile landing under the feet); the next ones are held. */
  private _stillRises = 0;
  /** A/B (rise bug 2026-10-04): false = a grounded, unmoving character may step up every tick (the old behaviour: a
   *  surface that follows the feet — e.g. the player's own contact blob — then lifts it forever). */
  static stillRiseGuard = true;
  /** Diagnostics: step-ups the still-rise guard refused. */
  stillRisesHeld = 0;

  /** Injected collision (optional; see file header). Set by the host after construction. */
  groundSampler: ((x: number, z: number) => number | null) | null = null;
  /** The standable ground height found under the feet on the last step (sampled surface, else cfg.groundY) — what a
   *  contact shadow sits on while airborne. */
  lastGroundY = 0;
  moveResolver: ((fromX: number, fromZ: number, toX: number, toZ: number, radius: number) => [number, number]) | null = null;

  constructor(cfg: Partial<CharacterConfig> = {}, start: Vec3 = [0, 0, 0]) {
    this.cfg = { ...DEFAULT_CHARACTER, ...cfg };
    this.pos = [start[0], Math.max(start[1], this.cfg.groundY), start[2]];
    this.prevPos = [this.pos[0], this.pos[1], this.pos[2]];
    this.vel = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.facing = 0;
    this.prevFacing = 0;
    this.grounded = this.pos[1] <= this.cfg.groundY + 1e-4;
  }

  /** Flip walk ⇄ run. Returns the new state (true = running). */
  toggleRun(): boolean { this.running = !this.running; return this.running; }

  /** The active gait: sneak (wins), run, or walk. */
  gait(): 'walk' | 'run' | 'sneak' { return this.sneaking ? 'sneak' : this.running ? 'run' : 'walk'; }

  /** Full-input walk speed (world units/s): walkSpeed (never above the run speed), or the legacy moveSpeed ×
   *  walkSpeedFactor when that is set. */
  walkTopSpeed(): number { return this.cfg.walkSpeedFactor > 0 ? this.cfg.moveSpeed * this.cfg.walkSpeedFactor : Math.min(this.cfg.walkSpeed, this.cfg.moveSpeed); }

  /** Full-input planar speed for the current gait (world units/s). Sneak is never faster than the walk. */
  targetTopSpeed(): number {
    const g = this.gait();
    return g === 'sneak' ? Math.min(this.cfg.sneakSpeed, this.walkTopSpeed()) : g === 'run' ? this.cfg.moveSpeed : this.walkTopSpeed();
  }

  /** Point the camera AND the body along `yaw` (spawn / re-bind). */
  setHeading(yaw: number, pitch = this.pitch): void {
    this.yaw = wrapAngle(yaw); this.facing = this.yaw; this.prevFacing = this.yaw;
    this._dirX = Math.sin(this.yaw); this._dirZ = Math.cos(this.yaw);
    this.pitch = pitch; this._clampPitch();
  }

  /** Teleport the feet (no interpolation smear across the jump). */
  teleport(p: Vec3): void {
    this.pos = [p[0], p[1], p[2]];
    this.prevPos = [p[0], p[1], p[2]];
    this._stillRises = 0;
  }

  /** Apply look deltas (radians; + yaw = turn RIGHT, + pitch = look up) — camera only in third-person. The Play loop
   *  calls this per RENDER frame for the mouse / right stick (crisp at any refresh rate); update() also applies the
   *  per-tick input.lookYaw / lookPitch / look for hosts that feed them. */
  applyLook(yawDelta: number, pitchDelta: number): void {
    this.yaw = wrapAngle(this.yaw - yawDelta);
    this.pitch += pitchDelta;
    this._clampPitch();
    if (this.cfg.cameraMode !== 'third') this.facing = this.yaw;
  }

  private _clampPitch(): void {
    const third = this.cfg.cameraMode === 'third';
    const lo = third ? this.cfg.thirdPersonPitchMin : this.cfg.pitchMin;
    const hi = third ? this.cfg.thirdPersonPitchMax : this.cfg.pitchMax;
    if (this.pitch < lo) this.pitch = lo;
    if (this.pitch > hi) this.pitch = hi;
  }

  /** Camera-relative move vector for an input: forward = +Z rotated CCW by yaw; right = SCREEN-right =
   *  normalize(cross(forward, worldUp)) = (-fwdZ, fwdX) — same math as flyMove(). Facing +Z (yaw 0) that is −X: in a
   *  right-handed Y-up view, +X sits to the LEFT of a +Z camera. Clamped (not normalized) to length 1, so diagonals
   *  aren't faster but an analog stick below full tilt moves slower. */
  moveVector(forward: number, right: number): [number, number] {
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let mx = sin * forward - cos * right;
    let mz = cos * forward + sin * right;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1) { mx /= mlen; mz /= mlen; }
    return [mx, mz];
  }

  /** Advance one fixed step. */
  update(dt: number, input: CharacterInput = NO_INPUT): void {
    const c = this.cfg;
    this.prevPos[0] = this.pos[0]; this.prevPos[1] = this.pos[1]; this.prevPos[2] = this.pos[2];
    this.prevFacing = this.facing;
    this.landImpact = 0;
    // Look: keyboard rate-turn + direct look deltas. Inputs are "positive = turn RIGHT" (clockwise from above).
    this.applyLook(input.look * c.turnSpeed * dt + (input.lookYaw ?? 0), input.lookPitch ?? 0);

    // Planar move: the camera-relative input sets a target VELOCITY; the velocity approaches it (see file header).
    const [mx, mz] = this.moveVector(input.forward, input.right);
    const mag = Math.hypot(mx, mz);
    if (mag > 1e-4) { this._dirX = mx / mag; this._dirZ = mz / mag; }
    const top = this.targetTopSpeed();
    const tx = mx * top, tz = mz * top;
    const airborne = !this.grounded;
    if (!(airborne && mag <= 1e-4)) {   // in the air with no input: keep the momentum
      const dx = tx - this._vx, dz = tz - this._vz, dl = Math.hypot(dx, dz);
      const speeding = Math.hypot(tx, tz) >= Math.hypot(this._vx, this._vz) - 1e-9;
      const k = speeding ? c.acceleration : c.deceleration;
      if (k <= 0 || dt <= 0) { this._vx = tx; this._vz = tz; }
      else if (dl > 0) {
        const air = airborne ? Math.max(0, Math.min(1, c.airControl)) : 1;
        const lin = (speeding ? c.groundAccel : c.groundDecel) * air * dt;
        // In the air only the (reduced) linear rate: steering, not a second ground.
        const step = Math.min(dl, airborne ? lin : Math.max(dl * (1 - Math.exp(-k * dt)), lin));
        this._vx += (dx / dl) * step; this._vz += (dz / dl) * step;
      }
      if (mag <= 1e-4 && Math.hypot(this._vx, this._vz) < 0.02 * Math.max(top, 1e-6)) { this._vx = 0; this._vz = 0; }   // settle
    }

    // Body facing: third-person turns toward the move direction (only while there is move INPUT — releasing the
    // stick keeps the last facing; orbiting the camera never turns it); half as fast in the air. First-person = look.
    this._turnRemaining = 0;
    if (c.cameraMode === 'third') {
      if (mag > 1e-3) {
        const air = airborne ? 0.5 : 1;
        const want = Math.atan2(this._dirX, this._dirZ);
        this.facing = turnToward(this.facing, want, c.faceTurnRate * air, c.maxTurnSpeed * air, dt);
        this._turnRemaining = wrapAngle(want - this.facing);
      }
    } else {
      this.facing = this.yaw;
    }

    const prevX = this.pos[0], prevZ = this.pos[2];
    const wantX = prevX + this._vx * dt;
    const wantZ = prevZ + this._vz * dt;
    // Horizontal collision (optional): a wall can cancel the into-wall component of the move.
    if (this.moveResolver && (wantX !== prevX || wantZ !== prevZ)) {
      const [rx, rz] = this.moveResolver(prevX, prevZ, wantX, wantZ, c.radius);
      this.pos[0] = rx; this.pos[2] = rz;
    } else {
      this.pos[0] = wantX; this.pos[2] = wantZ;
    }
    // Actual planar velocity (post-collision) — a wall/idle drops it to ~0, driving idle vs walk/run.
    this.vel[0] = dt > 0 ? (this.pos[0] - prevX) / dt : 0;
    this.vel[2] = dt > 0 ? (this.pos[2] - prevZ) / dt : 0;
    this.lastPlanarSpeed = Math.hypot(this.vel[0], this.vel[2]);
    // A wall that blocks us also bleeds the velocity: keep only what actually moved (a slide along the wall keeps its
    // tangential part), so leaving the wall doesn't launch at full speed.
    if (dt > 0 && this.lastPlanarSpeed < Math.hypot(this._vx, this._vz) - 1e-6) { this._vx = this.vel[0]; this._vz = this.vel[2]; }

    // The standable ground under the (possibly new) x,z — the sampled scene surface, else the flat fallback.
    const ground = this.groundSampler?.(this.pos[0], this.pos[2]);
    const groundY = (ground === null || ground === undefined) ? c.groundY : ground;
    this.lastGroundY = groundY;

    // Jump: edge-triggered + buffered, with coyote time after walking off the ground.
    const wasGrounded = this.grounded;
    const preY = this.pos[1];
    const pressed = input.jump && !this._prevJump;
    this._prevJump = input.jump;
    this._jumpHeld = input.jump;
    if (pressed && this._windup < 0) this._jumpBuffer = Math.max(c.jumpBufferTime, 1e-6);
    let jumped = false;
    const launch = () => { this.vel[1] = c.jumpSpeed; this.grounded = false; jumped = true; this._inJump = true; this._jumpBuffer = 0; this._windup = -1; };
    const windup = c.jumpWindup ?? 0;
    if (this._windup >= 0) {
      // Crouching for a jump: launch when the wind-up is over — or at once if the ground went away meanwhile.
      this._windup -= dt;
      if (this._windup <= 1e-9 || !this.grounded) launch();
    } else {
      const canJump = this.grounded || (!this._inJump && this.airTime <= c.coyoteTime && this.vel[1] <= 0);
      if (this._jumpBuffer > 0 && canJump) {
        if (windup > 0 && this.grounded) { this._windup = windup; this._jumpBuffer = 0; }
        else launch();
      }
    }
    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    // Gravity: full while rising with the button held, cut when released early, a hang near the apex, snappier falling.
    const vy = this.vel[1];
    let gmul = vy > 0 ? 1 : c.fallGravityMultiplier;
    if (this._inJump && vy > 0 && !this._jumpHeld && c.variableJumpHeight) gmul = c.jumpCutGravityMultiplier;
    else if (this._inJump && this._jumpHeld && Math.abs(vy) < c.apexHangSpeed) gmul = c.apexGravityMultiplier;
    this.vel[1] -= c.gravity * gmul * dt;
    if (this.vel[1] < -c.maxFallSpeed) this.vel[1] = -c.maxFallSpeed;
    const vyLand = this.vel[1];
    this.pos[1] += this.vel[1] * dt;

    // Ground collision. Rising (a jump) never gets pulled UP onto a surface above where the feet started this step
    // — that is overhead geometry, not a floor. Walking (grounded, not jumping) stays glued to ground that drops by
    // no more than stepHeight (down stairs / slopes), so it doesn't flicker into "falling" every step.
    const rising = this.vel[1] > 0;
    // Safety net (rise bug 2026-10-04): a grounded character that did not move horizontally this step cannot keep
    // gaining height. A surface that follows the feet (it was the player's own contact-shadow blob being collided
    // with) otherwise lifts it by a few mm every tick, forever. One still step-up is allowed (a spawn settling onto a
    // kerb, ground that landed under the feet); the next ones in a row are held at the current height.
    const stillStep = wasGrounded && !jumped && groundY > preY + 1e-6 && this.pos[0] === prevX && this.pos[2] === prevZ;
    if (!stillStep) this._stillRises = 0;
    if (stillStep && CharacterController.stillRiseGuard && this._stillRises >= 1) {
      this.pos[1] = preY; this.vel[1] = 0; this.grounded = true; this.stillRisesHeld++;
    } else if (this.pos[1] <= groundY && !(rising && groundY > preY + 1e-6)) {
      if (stillStep) this._stillRises++;
      this.pos[1] = groundY; this.vel[1] = 0; this.grounded = true;
    } else if (wasGrounded && !jumped && groundY <= preY + 1e-6 && preY - groundY <= c.stepHeight) {
      this.pos[1] = groundY; this.vel[1] = 0; this.grounded = true;
    } else {
      this.grounded = false;
    }
    if (this.grounded) {
      if (!wasGrounded && c.jumpSpeed > 0) this.landImpact = Math.min(1.5, Math.max(0, -vyLand / c.jumpSpeed));
      this.airTime = 0; this._inJump = false;
    } else {
      this.airTime += dt;
    }
  }

  /** Feet position interpolated between the last two fixed steps (alpha ∈ [0,1]) — what the render tick draws. */
  renderPos(alpha: number): Vec3 {
    const a = Math.max(0, Math.min(1, alpha)), p = this.prevPos, q = this.pos;
    return [p[0] + (q[0] - p[0]) * a, p[1] + (q[1] - p[1]) * a, p[2] + (q[2] - p[2]) * a];
  }
  /** Body facing interpolated between the last two fixed steps (shortest arc). */
  renderFacing(alpha: number): number {
    const a = Math.max(0, Math.min(1, alpha));
    return wrapAngle(this.prevFacing + wrapAngle(this.facing - this.prevFacing) * a);
  }

  /** Unit forward direction including pitch (points where the camera looks). */
  forwardDir(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp];
  }

  /** The head/eye position (feet + eyeHeight). */
  eyePosition(): Vec3 { return [this.pos[0], this.pos[1] + this.cfg.eyeHeight, this.pos[2]]; }

  /** A point 1 unit ahead of the eye along the look direction — the first-person camera look-at target. Includes
   *  pitch, so at pitch 0 this is level (backward-compatible with the pre-mouse-look behaviour). */
  lookTarget(): Vec3 {
    const eye = this.eyePosition();
    const f = this.forwardDir();
    return [eye[0] + f[0], eye[1] + f[1], eye[2] + f[2]];
  }

  /** The un-smoothed camera eye for the configured cameraMode. Third-person pulls back behind the pivot along the look
   *  direction (so pitch orbits the camera vertically around the character). The Play loop's ThirdPersonCamera adds
   *  follow smoothing, look-ahead and collision on top of this rig. */
  cameraEye(): Vec3 {
    if (this.cfg.cameraMode !== 'third') return this.eyePosition();
    const pivot = this.orbitPivot();
    const f = this.forwardDir();
    const d = this.cfg.thirdPersonDistance;
    return [pivot[0] - f[0] * d, pivot[1] - f[1] * d, pivot[2] - f[2] * d];
  }

  /** The camera look-at target for the configured cameraMode. */
  cameraTarget(): Vec3 {
    if (this.cfg.cameraMode !== 'third') return this.lookTarget();
    return this.orbitPivot();
  }

  /** Third-person orbit pivot: the head raised by thirdPersonHeight (≈ shoulder height by default). */
  orbitPivot(feet: Vec3 = this.pos): Vec3 {
    return [feet[0], feet[1] + this.cfg.eyeHeight + this.cfg.thirdPersonHeight, feet[2]];
  }

  /** Third-person: how far (rad, + = to the left, shortest arc) the body is still turning toward the move direction
   *  after the last step (0 when there is no move input / first-person). The animation's head + chest lead the turn by
   *  it — a turn anticipation (the head looks where the body is about to go). */
  turnRemaining(): number { return this._turnRemaining; }

  /** The current locomotion state — feeds walk/idle/run/jump/fall animation selection (see game/locomotion.ts). */
  locomotion(): LocomotionState {
    const js = this.cfg.jumpSpeed > 0 ? this.cfg.jumpSpeed : 1;
    return {
      planarSpeed: this.lastPlanarSpeed,
      moving: this.lastPlanarSpeed > 1e-3,
      grounded: this.grounded,
      airborne: !this.grounded,
      rising: this.vel[1] > 1e-3,     // moving up = the ascending part of a jump
      sneaking: this.sneaking,
      airPhase: Math.max(0, Math.min(1, 0.5 - (0.5 * this.vel[1]) / js)),
      landImpact: this.landImpact,
      airTime: this.airTime,
      jumped: this._inJump,
      jumpWindup: this._windup >= 0 ? Math.max(1e-3, Math.min(1, 1 - this._windup / Math.max(1e-6, this.cfg.jumpWindup ?? 0))) : 0,
      jumpHeld: this._jumpHeld,
    };
  }
}
