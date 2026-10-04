/**
 * Play-mode document settings (polish-round-3 T5) — the knobs a Play settings panel edits, persisted with the document
 * in the global-scene blob (`play`), only when they differ from the defaults, so older saves (no `play` key) load with
 * today's behaviour.
 *
 *  - eyeHeight: the FIRST-PERSON player height (camera height above the feet), in WORLD UNITS. null = automatic (the
 *    original behaviour: 1.6 units, or 0.9 × the bound Player avatar's measured height). Units: the Play controller works
 *    in world units, where Creator/character content is 1 unit ≈ 1 metre. A city is built at `cityMetresPerUnit()`
 *    metres per unit (`X*s` = 15·X metres), so a host showing METRES passes that as `metresPerUnit` and the value is
 *    converted (units = metres / metresPerUnit) — the same convention as the decal size APIs.
 *  - autoDefaultPlayer: in THIRD-person Play with no Player set, spawn a runtime default character (play-auto-player.ts).
 *    Default on.
 *  - moveSpeed (Round 4; Round 8 = the RUN speed): the player's full-input RUN speed (Shift toggles into it), in METRES
 *    PER SECOND (scene-scale independent — the Play loop converts it to world units with the scene's metres-per-unit,
 *    so the same value feels the same in a 15 m/unit city and in a 1 m/unit Creator scene). null = the default
 *    DEFAULT_MOVE_SPEED_MS (5.2 m/s since Round 8; it was 3.5, when full input also ran by default). An older document's
 *    stored value keeps meaning "full-input run speed", so it loads unchanged; walking is now its own speed below.
 *  - walkSpeed (Round 8): the full-input WALK speed (the Play default gait), m/s. null = DEFAULT_WALK_SPEED_MS (1.6).
 *    Never faster than the run speed (clamped at use).
 *  - cameraDistance (R6.2): the third-person follow distance in METRES (converted with metres-per-unit like moveSpeed).
 *    null = automatic (1.8 × the avatar's height, or 3 m with no avatar; it was 2.6 × H / 4.5 m before visual-polish #7a).
 *  - fovDeg (R6.2): the third-person vertical field of view in degrees. null = DEFAULT_THIRD_PERSON_FOV_DEG (50°; 72°
 *    before visual-polish #7a).
 *
 *  - jumpVariety (2026-10-03): each jump picks one of the default jump variants (tuck / reach / swing / stride / hop /
 *    the classic) — only for the engine's runtime default jumps, never an authored Jump clip. Default on.
 *  - motionLooseness (2026-10-03): 0..1, how much secondary motion (follow-through, per-cycle variation, head drift)
 *    the default gaits get. Default 0.5; 0 = the clips exactly.
 *  - walkStyle (2026-10-03): which runtime walk the default gait uses — 'natural' (the default Walk: heel-to-toe roll,
 *    the pelvis highest at mid-stance) or 'stomp' (the Stomp clip: the older heavy, flat-footed tread, kept for custom
 *    use such as stomping through swamp water). Only the engine's runtime default Walk is swapped, never an authored one.
 *  - landingDust (2026-10-04): stylised dust puffs on jump landings (sized by the landing: Land / Land Deep / Land
 *    Soft), tiny footstep puffs while running on dry ground, splashes on a wet street. Default on.
 *  - idleVariety (2026-10-04): the default Stand idle plays a random one-shot variant now and then (look around,
 *    stretch, check the wrist, foot tap, adjust glasses with a glasses charm). Only over the runtime Stand idle, never
 *    an authored Idle clip. Default on.
 *
 *  SAVED-SCENE COMPATIBILITY (visual-polish #7a, 2026-10-03): only non-default values are stored, so a document that
 *  SET a follow distance or a FOV keeps it exactly. A document that never set them (no `play.cameraDistance` /
 *  `play.fovDeg`) picks up the new closer framing (FOV 50, 1.8·H, the 0.35 m shoulder offset): that is intended, the
 *  old automatic framing was a placeholder. One edge case: a document whose FOV slider was left at exactly the OLD
 *  default 72 stored nothing (it was the default then), so it also gets 50.
 */

/** Stored form (the `play` key of GlobalScene3DSettings). Every field optional. */
export interface PlaySettingsState {
    /** First-person eye height in world units. Absent = automatic. */
    eyeHeight?: number;
    /** Auto default character in third-person Play. Absent = true. */
    autoDefaultPlayer?: boolean;
    /** Full-input RUN speed in metres / second. Absent = DEFAULT_MOVE_SPEED_MS. */
    moveSpeed?: number;
    /** Full-input WALK speed in metres / second (Round 8). Absent = DEFAULT_WALK_SPEED_MS. */
    walkSpeed?: number;
    /** Third-person follow distance in metres. Absent = automatic. */
    cameraDistance?: number;
    /** Third-person vertical FOV in degrees. Absent = DEFAULT_THIRD_PERSON_FOV_DEG. */
    fovDeg?: number;
    /** Jump variety (2026-10-03). Absent = true. */
    jumpVariety?: boolean;
    /** Motion looseness 0..1 (2026-10-03). Absent = DEFAULT_MOTION_LOOSENESS. */
    motionLooseness?: number;
    /** Walk style (2026-10-03). Absent = 'natural'. */
    walkStyle?: PlayWalkStyle;
    /** Landing dust (2026-10-04). Absent = true. */
    landingDust?: boolean;
    /** Idle variety (2026-10-04). Absent = true. */
    idleVariety?: boolean;
}

/** The default gait's walk style: 'natural' = the runtime Walk clip, 'stomp' = the runtime Stomp clip. */
export type PlayWalkStyle = 'natural' | 'stomp';

/** Default motion looseness (the secondary-motion scale of the default gaits). */
export const DEFAULT_MOTION_LOOSENESS = 0.5;

/** Smallest / largest eye height accepted (world units) — guards a slider at 0 or a typo'd 1e9. */
export const MIN_EYE_HEIGHT = 0.01;
export const MAX_EYE_HEIGHT = 10000;
/** Default full-input RUN speed (m/s) — Round 8 (was 3.5 when full input ran by default). */
export const DEFAULT_MOVE_SPEED_MS = 5.2;
/** Default full-input WALK speed (m/s) — Round 8, the Play default gait (a brisk walk). */
export const DEFAULT_WALK_SPEED_MS = 1.6;
/** Move speed clamp (m/s) — a slider at 0 would freeze the player; 1e9 would tunnel through every wall. */
export const MIN_MOVE_SPEED_MS = 0.1;
export const MAX_MOVE_SPEED_MS = 100;
/** Third-person follow distance clamp (metres). */
export const MIN_CAMERA_DISTANCE_M = 0.5;
export const MAX_CAMERA_DISTANCE_M = 50;
/** Default third-person FOV (degrees) and its clamp. */
export const DEFAULT_THIRD_PERSON_FOV_DEG = 50;   // visual-polish #7a (2026-10-03): was 72
export const MIN_FOV_DEG = 30;
export const MAX_FOV_DEG = 110;

export class PlaySettings {
    private _eyeHeight: number | null = null;
    private _autoDefaultPlayer = true;
    private _moveSpeed: number | null = null;
    private _walkSpeed: number | null = null;
    private _cameraDistance: number | null = null;
    private _fovDeg: number | null = null;
    private _jumpVariety = true;
    private _looseness: number | null = null;
    private _walkStyle: PlayWalkStyle = 'natural';
    private _landingDust = true;
    private _idleVariety = true;
    /** Called after any change (the Play loop applies a new eye height live). */
    onChange: (() => void) | null = null;

    /** Set the first-person eye height. `h` is world units, or METRES when `metresPerUnit` (> 0) is given. null /
     *  non-finite / ≤ 0 = back to automatic. Clamped to [MIN_EYE_HEIGHT, MAX_EYE_HEIGHT] units. */
    setEyeHeight(h: number | null, metresPerUnit?: number): void {
        let v: number | null = null;
        if (h !== null && Number.isFinite(h) && h > 0) {
            const units = metresPerUnit && metresPerUnit > 0 ? h / metresPerUnit : h;
            v = Math.min(MAX_EYE_HEIGHT, Math.max(MIN_EYE_HEIGHT, units));
        }
        if (v === this._eyeHeight) return;
        this._eyeHeight = v;
        this.onChange?.();
    }
    /** The set eye height (world units, or metres when `metresPerUnit` is given), or null = automatic. */
    getEyeHeight(metresPerUnit?: number): number | null {
        if (this._eyeHeight === null) return null;
        return metresPerUnit && metresPerUnit > 0 ? this._eyeHeight * metresPerUnit : this._eyeHeight;
    }

    setAutoDefaultPlayer(on: boolean): void {
        if (on === this._autoDefaultPlayer) return;
        this._autoDefaultPlayer = on;
        this.onChange?.();
    }
    get autoDefaultPlayer(): boolean { return this._autoDefaultPlayer; }

    /** Set the full-input RUN speed in metres / second. null / non-finite / ≤ 0 / exactly the default = back to the
     *  default (so a slider dragged back to 3.5 doesn't write a `moveSpeed` key). Clamped to [MIN, MAX]_MOVE_SPEED_MS. */
    setMoveSpeed(metresPerSecond: number | null): void {
        let v: number | null = null;
        if (metresPerSecond !== null && Number.isFinite(metresPerSecond) && metresPerSecond > 0) {
            v = Math.min(MAX_MOVE_SPEED_MS, Math.max(MIN_MOVE_SPEED_MS, metresPerSecond));
            if (v === DEFAULT_MOVE_SPEED_MS) v = null;
        }
        if (v === this._moveSpeed) return;
        this._moveSpeed = v;
        this.onChange?.();
    }
    /** The effective full-input RUN speed in m/s (the default when unset — never null). */
    getMoveSpeed(): number { return this._moveSpeed ?? DEFAULT_MOVE_SPEED_MS; }
    /** True when the move speed is the default (nothing stored). */
    get moveSpeedIsDefault(): boolean { return this._moveSpeed === null; }

    /** Set the full-input WALK speed in m/s (Round 8). null / non-finite / ≤ 0 / exactly the default = default. Clamped
     *  to [MIN, MAX]_MOVE_SPEED_MS. */
    setWalkSpeed(metresPerSecond: number | null): void {
        let v: number | null = null;
        if (metresPerSecond !== null && Number.isFinite(metresPerSecond) && metresPerSecond > 0) {
            v = Math.min(MAX_MOVE_SPEED_MS, Math.max(MIN_MOVE_SPEED_MS, metresPerSecond));
            if (v === DEFAULT_WALK_SPEED_MS) v = null;
        }
        if (v === this._walkSpeed) return;
        this._walkSpeed = v;
        this.onChange?.();
    }
    /** The effective walk speed in m/s: the setting (or the default), never above the run speed. */
    getWalkSpeed(): number { return Math.min(this._walkSpeed ?? DEFAULT_WALK_SPEED_MS, this.getMoveSpeed()); }

    /** Third-person follow distance in METRES. null / non-finite / ≤ 0 = automatic. Clamped to
     *  [MIN, MAX]_CAMERA_DISTANCE_M. */
    setCameraDistance(metres: number | null): void {
        let v: number | null = null;
        if (metres !== null && Number.isFinite(metres) && metres > 0) v = Math.min(MAX_CAMERA_DISTANCE_M, Math.max(MIN_CAMERA_DISTANCE_M, metres));
        if (v === this._cameraDistance) return;
        this._cameraDistance = v;
        this.onChange?.();
    }
    /** The set follow distance in metres, or null = automatic. */
    getCameraDistance(): number | null { return this._cameraDistance; }

    /** Third-person FOV in degrees. null / non-finite / ≤ 0 / exactly the default = default. Clamped [MIN, MAX]_FOV_DEG. */
    setFov(deg: number | null): void {
        let v: number | null = null;
        if (deg !== null && Number.isFinite(deg) && deg > 0) {
            v = Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, deg));
            if (v === DEFAULT_THIRD_PERSON_FOV_DEG) v = null;
        }
        if (v === this._fovDeg) return;
        this._fovDeg = v;
        this.onChange?.();
    }
    /** The effective third-person FOV in degrees (never null). */
    getFov(): number { return this._fovDeg ?? DEFAULT_THIRD_PERSON_FOV_DEG; }

    /** Jump variety on / off (the default jumps pick a variant per jump). */
    setJumpVariety(on: boolean): void {
        on = !!on;
        if (on === this._jumpVariety) return;
        this._jumpVariety = on;
        this.onChange?.();
    }
    get jumpVariety(): boolean { return this._jumpVariety; }

    /** Motion looseness 0..1. null / non-finite / exactly the default = default. Clamped to [0, 1]. */
    setMotionLooseness(v: number | null): void {
        let x: number | null = null;
        if (v !== null && Number.isFinite(v)) { x = Math.min(1, Math.max(0, v)); if (x === DEFAULT_MOTION_LOOSENESS) x = null; }
        if (x === this._looseness) return;
        this._looseness = x;
        this.onChange?.();
    }
    /** The effective motion looseness (never null). */
    getMotionLooseness(): number { return this._looseness ?? DEFAULT_MOTION_LOOSENESS; }

    /** Walk style ('natural' | 'stomp'); anything else = 'natural'. */
    setWalkStyle(style: PlayWalkStyle | string | null): void {
        const s: PlayWalkStyle = style === 'stomp' ? 'stomp' : 'natural';
        if (s === this._walkStyle) return;
        this._walkStyle = s;
        this.onChange?.();
    }
    get walkStyle(): PlayWalkStyle { return this._walkStyle; }

    /** Landing dust on / off (landing puffs, running footstep puffs, wet splashes). */
    setLandingDust(on: boolean): void {
        on = !!on;
        if (on === this._landingDust) return;
        this._landingDust = on;
        this.onChange?.();
    }
    get landingDust(): boolean { return this._landingDust; }

    /** Idle variety on / off (random one-shot standing idles over the default Stand). */
    setIdleVariety(on: boolean): void {
        on = !!on;
        if (on === this._idleVariety) return;
        this._idleVariety = on;
        this.onChange?.();
    }
    get idleVariety(): boolean { return this._idleVariety; }

    /** The persisted blob, or undefined when everything is default (keeps saves byte-identical to before). */
    serialize(): PlaySettingsState | undefined {
        const s: PlaySettingsState = {};
        if (this._eyeHeight !== null) s.eyeHeight = this._eyeHeight;
        if (!this._autoDefaultPlayer) s.autoDefaultPlayer = false;
        if (this._moveSpeed !== null) s.moveSpeed = this._moveSpeed;
        if (this._walkSpeed !== null) s.walkSpeed = this._walkSpeed;
        if (this._cameraDistance !== null) s.cameraDistance = this._cameraDistance;
        if (this._fovDeg !== null) s.fovDeg = this._fovDeg;
        if (!this._jumpVariety) s.jumpVariety = false;
        if (this._looseness !== null) s.motionLooseness = this._looseness;
        if (this._walkStyle !== 'natural') s.walkStyle = this._walkStyle;
        if (!this._landingDust) s.landingDust = false;
        if (!this._idleVariety) s.idleVariety = false;
        return Object.keys(s).length ? s : undefined;
    }
    /** Restore from a saved blob. ALWAYS resets first (stale-registry rule: a doc without `play` must not inherit the
     *  previous document's settings). Does not fire onChange (a load isn't a live edit). */
    restore(s: PlaySettingsState | null | undefined): void {
        this._eyeHeight = null;
        this._autoDefaultPlayer = true;
        this._moveSpeed = null;
        this._walkSpeed = null;
        this._cameraDistance = null;
        this._fovDeg = null;
        this._jumpVariety = true;
        this._looseness = null;
        this._walkStyle = 'natural';
        this._landingDust = true;
        this._idleVariety = true;
        if (!s) return;
        if (s.landingDust === false) this._landingDust = false;
        if (s.idleVariety === false) this._idleVariety = false;
        if (s.walkStyle === 'stomp') this._walkStyle = 'stomp';
        if (typeof s.eyeHeight === 'number' && Number.isFinite(s.eyeHeight) && s.eyeHeight > 0) {
            this._eyeHeight = Math.min(MAX_EYE_HEIGHT, Math.max(MIN_EYE_HEIGHT, s.eyeHeight));
        }
        if (s.autoDefaultPlayer === false) this._autoDefaultPlayer = false;
        if (typeof s.moveSpeed === 'number' && Number.isFinite(s.moveSpeed) && s.moveSpeed > 0) {
            const v = Math.min(MAX_MOVE_SPEED_MS, Math.max(MIN_MOVE_SPEED_MS, s.moveSpeed));
            this._moveSpeed = v === DEFAULT_MOVE_SPEED_MS ? null : v;
        }
        if (typeof s.walkSpeed === 'number' && Number.isFinite(s.walkSpeed) && s.walkSpeed > 0) {
            const v = Math.min(MAX_MOVE_SPEED_MS, Math.max(MIN_MOVE_SPEED_MS, s.walkSpeed));
            this._walkSpeed = v === DEFAULT_WALK_SPEED_MS ? null : v;
        }
        if (typeof s.cameraDistance === 'number' && Number.isFinite(s.cameraDistance) && s.cameraDistance > 0) {
            this._cameraDistance = Math.min(MAX_CAMERA_DISTANCE_M, Math.max(MIN_CAMERA_DISTANCE_M, s.cameraDistance));
        }
        if (typeof s.fovDeg === 'number' && Number.isFinite(s.fovDeg) && s.fovDeg > 0) {
            const v = Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, s.fovDeg));
            this._fovDeg = v === DEFAULT_THIRD_PERSON_FOV_DEG ? null : v;
        }
        if (s.jumpVariety === false) this._jumpVariety = false;
        if (typeof s.motionLooseness === 'number' && Number.isFinite(s.motionLooseness)) {
            const v = Math.min(1, Math.max(0, s.motionLooseness));
            this._looseness = v === DEFAULT_MOTION_LOOSENESS ? null : v;
        }
    }
}
