/**
 * ENGINE-ROADMAP STEP 7 (docs/specs/performance-plan.md P14): the pure parts of the shadow caching.
 *
 * - ShadowRunTester: the run test for the far shadow map's sub-mesh cull ranges (P11 cull-ranges.ts). The far map's
 *   casters are culled against the LIGHT box (the hardware clip of the shadow pass: exact) and, on the direct path,
 *   against the shadow REACH (the run's box swept along the sun down to the scene floor must touch the camera
 *   frustum, frustum-culler.ts shadowReachesView). A whole streamed-tile layer (one 420 m mesh) then submits only the
 *   runs that can cast into the receiving area.
 * - CasterSig: the order-independent static-set signature (the same mix as Renderer3D._sigMix).
 * - Near-cascade box HOLD: a cascade keeps its light-space box (and so its matrix and its cached static layer) while
 *   the wanted box stays within a texel-snapped slack of it and inside its depth range (P6's far-map slack, applied to
 *   the cascades). A re-centre pads the depth range so ordinary walking does not leave it at once.
 * - cascadeRefresh: what a cascade layer needs this frame (static re-render / composite of static + dynamic casters).
 * - stepSunDirection: the shadow light direction follows the sun in steps of a small angle, so a running day cycle
 *   re-renders the shadow maps at a bounded rate instead of every frame.
 */
import { FrustumCuller, shadowReachesView } from './frustum-culler';
import type { BoxTester } from './cull-ranges';
import type { CascadeLightBox } from './scene-uniforms';

/** Light box ∩ shadow reach, as a cull-ranges BoxTester. `reach` null = the light box alone (the static far map). */
export class ShadowRunTester implements BoxTester {
  light: FrustumCuller | null = null;
  reach: FrustumCuller | null = null;
  dir: ArrayLike<number> = [0, -1, 0];
  floorY = NaN;
  set(light: FrustumCuller | null, reach: FrustumCuller | null, dir: ArrayLike<number>, floorY: number): this {
    this.light = light; this.reach = reach; this.dir = dir; this.floorY = floorY;
    return this;
  }
  /** Whether the reach test can drop anything (shadowReachesView passes everything at a low sun / unknown floor). */
  get reachActive(): boolean { return !!this.reach && this.dir[1] < -0.05 && Number.isFinite(this.floorY); }
  testAABB(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    if (this.light && !this.light.testAABB(minX, minY, minZ, maxX, maxY, maxZ)) return false;
    if (this.reach && !shadowReachesView(this.reach, this.dir, this.floorY, minX, minY, minZ, maxX, maxY, maxZ)) return false;
    return true;
  }
  /** Wholly kept: inside the light box and (when the reach test is live) inside the view, so every sub-box reaches. */
  containsAABB(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    if (this.light && !this.light.containsAABB(minX, minY, minZ, maxX, maxY, maxZ)) return false;
    if (this.reachActive && !this.reach!.containsAABB(minX, minY, minZ, maxX, maxY, maxZ)) return false;
    return true;
  }
}

/** Order-independent signature of a caster set (sum + xor of a 32-bit mix per member, plus the count). */
export class CasterSig {
  sum = 0;
  xor = 0;
  n = 0;
  reset(): void { this.sum = 0; this.xor = 0; this.n = 0; }
  mix(a: number, b: number, c: number): void {
    const k = (Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x7F4A7C15, 0x85EBCA77) ^ Math.imul((c | 0) + 1, 0xC2B2AE3D)) | 0;
    this.sum = (this.sum + k) | 0;
    this.xor = (this.xor ^ Math.imul(k, 0x27D4EB2F)) | 0;
    this.n++;
  }
  get value(): number { return (this.sum ^ Math.imul(this.xor, 31) ^ Math.imul(this.n, 0x01000193)) | 0; }
}

/**
 * Which casters a cached STATIC layer holds (P14 tile-attach handling). A static caster that is not in the drawn layer
 * yet is a JOINER (a streamed tile's mesh after its probation, a crowd cell, a parked car): instead of re-rendering the
 * static layer for it at once, it is drawn with the dynamic casters (the map is the same: the per-texel minimum over the
 * same casters) until the joiners pass a triangle budget or have waited a while, and then the static layer re-renders
 * with all of them. A drawn member that leaves (removed, hidden, started moving) still changes the kept signature and
 * re-renders at once: the static layer must never hold a shadow that is gone.
 */
export class StaticLayerMembers {
  private readonly drawn = new Set<object>();
  joinTris = 0;
  joiners = 0;
  private joinSince = -1;
  get size(): number { return this.drawn.size; }
  beginFrame(): void { this.joinTris = 0; this.joiners = 0; }
  has(key: object): boolean { return this.drawn.has(key); }
  join(tris: number, frame: number): void { this.joinTris += tris; this.joiners++; if (this.joinSince < 0) this.joinSince = frame; }
  endFrame(): void { if (this.joiners === 0) this.joinSince = -1; }
  /** The joiners should go into the static layer now (over `maxTris`, or the first one waited `maxFrames`). */
  due(frame: number, maxTris: number, maxFrames: number): boolean {
    return this.joiners > 0 && (this.joinTris >= maxTris || frame - this.joinSince >= maxFrames);
  }
  /** The static layer was just drawn with exactly these casters. */
  drawnWith(keys: readonly object[]): void { this.drawn.clear(); for (let i = 0; i < keys.length; i++) this.drawn.add(keys[i]); this.joinSince = -1; }
  clear(): void { this.drawn.clear(); this.joinSince = -1; this.joinTris = 0; this.joiners = 0; }
}

/** Copy a cascade box. */
export function copyCascadeBox(dst: CascadeLightBox, src: CascadeLightBox): CascadeLightBox {
  dst.dx = src.dx; dst.dy = src.dy; dst.dz = src.dz; dst.he = src.he; dst.size = src.size;
  dst.sx = src.sx; dst.sy = src.sy; dst.zn = src.zn; dst.zf = src.zf;
  return dst;
}

/**
 * Whether a cascade may keep its `held` box instead of the `want`ed one: same light direction, half-width and map size
 * (so the same texel lattice), the snapped centre within `slack` world units on both light-space axes, and the wanted
 * depth range inside the held one (every caster the wanted box would catch is caught). `slack` 0 = never hold.
 */
export function cascadeBoxHolds(held: CascadeLightBox, want: CascadeLightBox, slack: number): boolean {
  if (!(slack > 0)) return false;
  if (held.he !== want.he || held.size !== want.size || held.dx !== want.dx || held.dy !== want.dy || held.dz !== want.dz) return false;
  if (Math.abs(want.sx - held.sx) > slack || Math.abs(want.sy - held.sy) > slack) return false;
  return want.zn >= held.zn && want.zf <= held.zf;
}

/** Pad a fresh (re-centred) box's depth range by `margin` at both ends, so moving within the slack keeps the wanted
 *  range inside it. A horizontal move of h shifts light-space depth by at most h·|d_h| while it shifts the centre
 *  across the light by at least h·|d_y|, so `slack · horizontal/vertical` (capped like the cascade depth slope) covers
 *  every move the centre test allows. */
export function cascadeDepthMargin(slack: number, dy: number): number {
  if (!(slack > 0)) return 0;
  const ay = Math.abs(dy), ah = Math.sqrt(Math.max(0, 1 - dy * dy));
  return slack * Math.min(8, ah / Math.max(1e-3, ay)) + slack;
}

/** One cascade layer's cache state. */
export interface CascadeCacheState {
  /** The static layer texture holds the static casters of the current box at `sigDrawn`. */
  valid: boolean;
  sigDrawn: number;
  /** The sampled layer currently includes dynamic casters (so it must be re-composited when they vanish). */
  dynInMap: boolean;
}
export function newCascadeCacheState(): CascadeCacheState { return { valid: false, sigDrawn: NaN, dynInMap: false }; }

/**
 * What one cascade layer needs this frame:
 * - renderStatic: (re)draw the static casters into the static layer — cold cache, the box moved, a drawn member changed
 *   or left (`sig`: the signature of the static casters already in the layer), a structural change (`stale`: geometry,
 *   materials, settings), or its joiners are due (`joinDue`, StaticLayerMembers);
 * - composite: copy static → sampled layer, then draw the dynamic casters on top — after a static re-render, when the
 *   dynamic layer is due (`dynDue`: the throttle or a skinned pose change) and there are dynamic casters, or once to
 *   clear dynamic casters that have gone.
 * Nothing at all when the static set is unchanged and there is no dynamic caster in or entering the map.
 */
export function cascadeRefresh(st: CascadeCacheState, boxChanged: boolean, sig: number, stale: boolean, hasDyn: boolean, dynDue: boolean, joinDue = false): { renderStatic: boolean; composite: boolean } {
  const renderStatic = !st.valid || boxChanged || stale || sig !== st.sigDrawn || joinDue;
  const composite = renderStatic || (hasDyn ? dynDue : st.dynInMap);
  return { renderStatic, composite };
}

/**
 * The shadow light direction (`cur`, unit, updated in place) follows the sun (`next`, unit) once it has turned by at
 * least `stepDeg` degrees from it (0 = on every change, the old behaviour). Returns whether `cur` changed. A day cycle
 * (3 deg/s at a 120 s day) then moves the shadow maps ~20 times a second at 0.15 deg instead of on every frame; the
 * lighting itself keeps the exact sun.
 */
export function stepSunDirection(cur: [number, number, number], next: ArrayLike<number>, stepDeg: number): boolean {
  if (cur[0] === next[0] && cur[1] === next[1] && cur[2] === next[2]) return false;
  if (stepDeg > 0) {
    const lc = Math.hypot(cur[0], cur[1], cur[2]), ln = Math.hypot(next[0], next[1], next[2]);
    const dot = cur[0] * next[0] + cur[1] * next[1] + cur[2] * next[2];
    // (a non-unit `cur` — the renderer's raw default before any sun was set — always takes the first real sun)
    if (Math.abs(lc - ln) < 1e-9 && dot / (lc * ln || 1) > Math.cos(stepDeg * Math.PI / 180)) return false;
  }
  cur[0] = next[0]; cur[1] = next[1]; cur[2] = next[2];
  return true;
}
