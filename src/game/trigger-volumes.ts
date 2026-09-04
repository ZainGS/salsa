/**
 * trigger-volumes — spatial trigger volumes for Play mode (docs/specs/play-mode.md).
 *
 * Zones (box or sphere) in world space that fire enter/exit events as the player moves through them — the primitive
 * that turns "walk around" into "the scene responds": doors, pressure plates, checkpoints, level transitions,
 * pickups. Pure + deterministic so it's unit-testable; the event side is wired by the host (e.g. dispatched into the
 * UI state machine, or straight game logic). Also answers "which triggers am I standing in?" for an interact key.
 */

export type Vec3 = [number, number, number];

export type TriggerShape =
  | { kind: 'box'; min: Vec3; max: Vec3 }
  | { kind: 'sphere'; center: Vec3; radius: number };

export interface TriggerVolume {
  id: string;
  shape: TriggerShape;
  /** Fire `enter` only ONCE (a pickup / one-time checkpoint); inert on re-entry until reset(). Exit still fires. */
  once?: boolean;
}

export type TriggerEventType = 'enter' | 'exit';
export interface TriggerEvent { type: TriggerEventType; id: string; }

/** Is a world point inside the shape? Box = inclusive AABB; sphere = centre + radius. */
export function pointInShape(p: Vec3, s: TriggerShape): boolean {
  if (s.kind === 'box') {
    return p[0] >= s.min[0] && p[0] <= s.max[0] &&
           p[1] >= s.min[1] && p[1] <= s.max[1] &&
           p[2] >= s.min[2] && p[2] <= s.max[2];
  }
  const dx = p[0] - s.center[0], dy = p[1] - s.center[1], dz = p[2] - s.center[2];
  return dx * dx + dy * dy + dz * dz <= s.radius * s.radius;
}

export class TriggerVolumeSystem {
  private _volumes: TriggerVolume[] = [];
  private _inside = new Set<string>();     // ids the tracked point is currently inside
  private _consumed = new Set<string>();   // `once` volumes whose enter already fired

  setVolumes(vols: TriggerVolume[]): void { this._volumes = vols.slice(); }
  get volumes(): readonly TriggerVolume[] { return this._volumes; }

  /**
   * Advance one step for a world point (e.g. the player's feet); returns the enter/exit edges since the last update.
   * Pass a reused `out` array to avoid per-tick allocation. A `once` volume fires `enter` only the first time.
   */
  update(point: Vec3, out: TriggerEvent[] = []): TriggerEvent[] {
    out.length = 0;
    for (const v of this._volumes) {
      const nowIn = pointInShape(point, v.shape);
      const wasIn = this._inside.has(v.id);
      if (nowIn && !wasIn) {
        this._inside.add(v.id);
        if (v.once && this._consumed.has(v.id)) continue;   // one-shot already fired → suppress this enter
        if (v.once) this._consumed.add(v.id);
        out.push({ type: 'enter', id: v.id });
      } else if (!nowIn && wasIn) {
        this._inside.delete(v.id);
        out.push({ type: 'exit', id: v.id });
      }
    }
    return out;
  }

  /** Ids of every volume currently containing the point — for an interact key ("what am I standing in / next to?"). */
  containing(point: Vec3): string[] {
    const ids: string[] = [];
    for (const v of this._volumes) if (pointInShape(point, v.shape)) ids.push(v.id);
    return ids;
  }

  /** Forget enter/exit + one-shot memory (e.g. on Play enter/exit) so the next update re-fires from a clean slate. */
  reset(): void { this._inside.clear(); this._consumed.clear(); }
}
