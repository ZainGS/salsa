/**
 * character-v2.ts — the Character v2 runtime (docs/specs/character-v2.md Phase 1 item 6 + "body-v2@2 review fixes, G4").
 *
 * A v2 character = the frozen `body-v2@2` asset on the SAME 20-joint skeleton v1 uses (so the default gait, Play,
 * retargeting and spring bones work unchanged), with its sliders as blend weights + bone offsets:
 *   • a slider change NEVER calls the generator: blend weights (Mesh3D.blendShapes / applyBlendWeights, the public
 *     API) + joint rest local positions + recomputed inverse binds;
 *   • the body's MESH-SPACE ORIGIN IS ITS SOLES: a runtime 'v2:lift' shape (a uniform +Y delta) keeps the lowest vertex
 *     at y = 0 through every shape / proportion slider (the root joint is lifted with it). So NO shape slider ever
 *     writes the node transform — Play's Stop, a gizmo undo and a reload can never put the feet through the floor
 *     (review runtime#2) — and the saved transform is asset-independent (a future asset bump keeps the feet planted);
 *   • `height` is the body's uniform NODE scale about that origin (= the soles), applied through the engine's character
 *     scale when the host has it (the Play snapshot + the running avatar follow — review runtime#2);
 *   • persistence is a MARKER: a root MeshGroup3D (thin wrapper, documentSkipChildren, hidden from the outliner) whose
 *     LIVE `worldParams` getter writes `{ kind: 'characterV2', v: 2, asset, base, sliders, transform, name, meshId,
 *     skeletonId, parentId?, mesh?, rig }`. The body mesh + skeleton are runtime (excludeFromDocument): load re-bakes the
 *     asset (deterministic) and rebuilds them FROM the marker with the SAME ids (the Play binding, scripts, paint keys
 *     and the gait seed stay valid) and the user's per-body state — the pose, clips, IK chains, NLA, springs, added
 *     joints (the `rig`, via the engine's own skeleton save), name, visibility, lock, outline, material overrides,
 *     transform keyframes, camera-block mode and the parent group (review runtime#1).
 * v2 never touches v1 character files (scene3d-character / clothing / hair / face): it is not an `isProceduralBody`,
 * so no v1-PARAMS path (setBodyParams3D regen, overlay fits, the v1 body save) adopts it. The character-level engine
 * features (outlines, character scale, the gait seed) key on the shared "is a character body" predicate instead
 * (`characterKind = 'v2'`, runtime-only, set here).
 */
import type { GltfSkinnedResult } from '../renderer/3d/gltf-importer';
import { Mesh3D, type BlendShape } from '../scene-graph/shapes/mesh-3d';
import type { SkinnedMesh3D } from '../scene-graph/shapes/skinned-mesh-3d';
import { Skeleton3D } from '../scene-graph/shapes/skeleton-3d';
import type { MeshGroup3D } from '../scene-graph/shapes/mesh-group-3d';
import type { Joint3D, SkeletonData, IKChain } from '../types/armature-3d';
import { buildDefaultClips, buildDefaultPoses } from '../services/managers/default-animations';
import {
  BODY_V2_ASSET, BODY_V2_COMPATIBLE, BODY_V2_HEIGHT_RANGE, BODY_V2_SLIDER_NAMES, getBodyV2AssetAsync, bodyV2Weights, bodyV2JointLocal,
  bodyV2InverseBinds, denseShapeDelta, heightScale, sliderParams, bodyV2SliderTable, coerceBodyV2Slider,
  cleanBodyV2Sliders, editBodyV2Sliders, bodyV2LegacySoleY, type BodyV2Asset, type BodyV2Base, type BodyV2Sliders, type BodyV2SliderName,
} from './body-v2-asset';
import type { BodyV2GenParams } from './body-v2-generator';

export const CHARACTER_V2_KIND = 'characterV2';
/** The marker schema: 2 = feet-origin transform + ids + per-body mesh / rig state. (1 / absent = the first Phase 1
 *  marker: the transform's origin sat at the asset's hips — `transform.soleY` or bodyV2LegacySoleY locates its soles;
 *  migrated on load.) */
export const CHARACTER_V2_MARKER_VERSION = 2;
/** The runtime lift shape's name (a uniform +Y delta that keeps the soles at mesh y = 0). */
export const CHARACTER_V2_LIFT_SHAPE = 'v2:lift';

/** The one character interface (spec §4 rule 4) — Play, the outliner, save/load and the crowd use this, not the kind. */
export interface CharacterHandle {
  kind: 'v1' | 'v2';
  /** The body mesh (what Play binds: setPlayerObject3D(rootId)). */
  rootId: string;
  skeletonId: string;
  /** Every mesh of the character (v2 Phase 1: just the body). */
  partIds: string[];
  /** v2: the persisted marker node's id. */
  markerId?: string;
}

/** The body's user-editable node state the marker persists (only what differs from a fresh v2 body). */
export interface CharacterV2MeshState {
  visible?: false;
  locked?: true;
  outline?: unknown;
  outlineRings?: unknown[];
  /** Material fields that differ from the v2 skin defaults (colour, render style, …). */
  material?: Record<string, unknown>;
  cameraBlock?: string;
  keyframeTracks?: Record<string, unknown>;
  textureLibraryId?: string;
  normalMapLibraryId?: string;
}
/** The skeleton's user state: the engine's own skeleton save (Skeleton3D.toJSON via serializeSkeletonForSave — the
 *  pose, clips, poses, IK chains, NLA, springs, constraints, added joints) with the unedited default clips / poses
 *  stripped (re-installed on load) and the asset joints' inverse binds dropped (derived from the sliders). */
export interface CharacterV2RigState {
  skeleton: Record<string, unknown>;
  /** The asset joints' REST local positions when saved (3 per asset joint, asset order): joint translations (a user
   *  offset, added joints' binds) restore relative to the CURRENT rest, also across an asset bump. */
  rest: number[];
}

/** The persisted marker (MeshGroup3D.worldParams). */
export interface CharacterV2Marker {
  kind: typeof CHARACTER_V2_KIND;
  /** Marker schema (see CHARACTER_V2_MARKER_VERSION). */
  v?: number;
  asset: string;
  base: BodyV2Base;
  sliders: BodyV2Sliders;
  /** The body NODE transform. v ≥ 2: its origin is the SOLES. `s` = the node scaleY (scene scale × user scale × the
   *  height slider); `sx` / `sz` only when they differ (a non-uniform scale reloads as it was shown). v < 2: x/y/z = the
   *  mesh ORIGIN at the saving asset's hips, `soleY` = that asset's rest-sole height (mesh space, before `s`). */
  transform: { x: number; y: number; z: number; rx: number; ry: number; rz: number; s: number; sx?: number; sz?: number; soleY?: number };
  name?: string;
  /** The body was deleted: the marker is dropped on the next load instead of respawning it. */
  removed?: boolean;
  meshId?: string;
  skeletonId?: string;
  /** The body's parent group (absent = the scene root). */
  parentId?: string;
  mesh?: CharacterV2MeshState;
  rig?: CharacterV2RigState;
}

/** What the runtime needs from the scene (Scene3DManager in the app — see scene3dCharacterV2Host; fakes in tests).
 *  Everything past the first block is optional: a minimal host still works (no undo, no Play integration). */
export interface CharacterV2Host {
  /** A rigged SkinnedMesh3D at (x, y, z) + the given Skeleton3D (added to the scene), the mesh id applied BEFORE it
   *  enters the scene (a taken id falls back to a fresh one). */
  createRigged(result: GltfSkinnedResult, x: number, y: number, z: number, name: string, opts: { meshId?: string; skeleton: Skeleton3D }): Promise<{ mesh: SkinnedMesh3D; skeleton: Skeleton3D }>;
  /** A thin-wrapper, documentSkipChildren root MeshGroup3D (the save marker). */
  createMarker(name: string): MeshGroup3D;
  removeMarker(g: MeshGroup3D): void;
  /** Dispose a rig (non-undoable): its runtime state (idle, Play binding) + caches go with it. */
  removeCharacter(mesh: SkinnedMesh3D, skeleton: Skeleton3D): void;
  getRootMeshGroups(): MeshGroup3D[];
  /** Metres per world unit in a city (characters spawn at real size there), else null. */
  sceneMetresPerUnit(): number | null;
  requestRender(): void;

  /** The default stance + default clips / poses on a NEW rig (after it is placed). */
  setupRig?(mesh: SkinnedMesh3D, skeleton: Skeleton3D): Promise<void>;
  /** Backfill the default clips / poses a saved rig had stripped (idempotent by name). */
  installDefaults?(skeleton: Skeleton3D): void;
  /** The engine's skeleton save for a rig (serializeSkeletonForSave: the authored pose, not a transient frame). */
  serializeRig?(skeleton: Skeleton3D): Record<string, unknown>;
  /** Detach without disposing (an undoable delete); returns whether its idle was on. */
  detachCharacter?(mesh: SkinnedMesh3D, skeleton: Skeleton3D): { wasIdle: boolean };
  attachCharacter?(mesh: SkinnedMesh3D, skeleton: Skeleton3D, parent: unknown, opts: { idle?: boolean }): void;
  /** A group by id (re-parenting a restored body). */
  findGroup?(id: string): MeshGroup3D | null;
  /** Is a node id already used in the scene (a pasted / duplicated marker must not steal ids)? */
  isIdTaken?(id: string): boolean;
  pushUndo?(cmd: { description: string; undo(): void; redo(): void }): void;
  /** The description of the command an Undo would undo now (slider-drag coalescing). */
  undoTop?(): string | null;
  /** Uniform node scale of a character body through the engine's character scale (feet kept; the Play snapshot and
   *  the running avatar follow). */
  setCharacterScale?(mesh: SkinnedMesh3D, scale: number): void;
  /** The character's rest changed by `restDelta` (3 floats per skeleton joint): re-bind it if it is the Play avatar. */
  refreshPlayAvatar?(mesh: SkinnedMesh3D, restDelta: Float32Array): void;
  /** Restore a persisted outline exactly; give a new character the characters-only outline when it is on. */
  restoreOutline?(mesh: SkinnedMesh3D, outline: unknown, rings: unknown[] | null): void;
  applyCharacterOutline?(mesh: SkinnedMesh3D): void;
  /** Register this manager as the engine's character provider (outliner delete / Ctrl+D routing, hidden markers). */
  registerProvider?(p: { owns(id: string): boolean; hidden(id: string): boolean; delete(id: string): boolean; duplicate(id: string): boolean }): void;
}

interface Rec {
  marker: MeshGroup3D;
  mesh: SkinnedMesh3D;
  skeleton: Skeleton3D;
  asset: BodyV2Asset;
  sliders: BodyV2Sliders;
  /** The asset joints' rest local positions currently applied (lift included) — the base of the next rest delta. */
  rest: Float32Array;
  /** The mesh-space +Y lift currently applied (the 'v2:lift' weight). */
  lift: number;
  /** The height slider value the node scale currently includes. */
  heightApplied: number;
  /** v2's own shapes on the mesh: the asset's (asset order) + the lift (last). Located by identity — other shapes on
   *  the same mesh keep their weights (review pipeline#5). */
  shapes: BlendShape[];
  slot: Int32Array;
  /** The material right after the build (the marker saves only what differs from it), as JSON per key. */
  defaultMaterial: Record<string, string>;
}

export interface CreateCharacterV2Options {
  base?: BodyV2Base;
  sliders?: BodyV2Sliders;
  /** Where the SOLES stand (default the origin). */
  position?: readonly [number, number, number];
  name?: string;
}

const SLIDER_NAMES = BODY_V2_SLIDER_NAMES;
/** Load-time (create options / restored markers): lenient — bad keys / values drop to the base. Live setters validate
 *  strictly instead (coerceBodyV2Slider / editBodyV2Sliders: a bad value returns false, never a silent reset). */
const cleanSliders = (s: BodyV2Sliders | undefined): BodyV2Sliders => cleanBodyV2Sliders(s);
const sameSliders = (a: BodyV2Sliders, b: BodyV2Sliders): boolean => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k as BodyV2SliderName] === b[k as BodyV2SliderName]);
};
type V2Flagged = { characterKind?: 'v2' };

function maxY(v: ArrayLike<number>): number {
  let hi = -Infinity;
  for (let i = 1; i < v.length; i += 12) if (v[i] > hi) hi = v[i];
  return Number.isFinite(hi) ? hi : 0;
}
/** Structural equality ignoring `id` (an unedited default clip / pose compares equal to a freshly built one). */
function eqNoId(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eqNoId(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter((k) => k !== 'id' && (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => k !== 'id' && (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!eqNoId((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The rest soles (lowest Y) of the asset at `w`, from the shapes' Y deltas only into a per-asset scratch (n floats, no
 *  12-float evaluation, no allocation after the first call — review runtime#9). DETERMINISTIC in the weights (the same
 *  float ops as bodyV2Vertices, so its min exactly), so a restore re-derives the identical lift + bone rest. */
const _soleScratch = new WeakMap<BodyV2Asset, Float32Array>();
function soleOf(asset: BodyV2Asset, w: Float32Array): number {
  const n = asset.vertexCount, V = asset.vertices;
  let y = _soleScratch.get(asset);
  if (!y) { y = new Float32Array(n); _soleScratch.set(asset, y); }
  for (let i = 0; i < n; i++) y[i] = V[i * 12 + 1];
  for (let s = 0; s < asset.shapes.length; s++) {
    const ws = w[s];
    if (!(Math.abs(ws) >= 1e-7)) continue;
    const { idx } = asset.shapes[s], d = denseShapeDelta(asset, s);
    for (let k = 0; k < idx.length; k++) { const vi = idx[k]; y[vi] += ws * d[vi * 6 + 1]; }
  }
  let lo = Infinity;
  for (let i = 0; i < n; i++) if (y[i] < lo) lo = y[i];
  return Number.isFinite(lo) ? lo : 0;
}

/** The lift shape's dense delta per base (0, 1, 0 on every vertex), shared read-only. */
const _liftDelta = new WeakMap<BodyV2Asset, Float32Array>();
function liftDelta(asset: BodyV2Asset): Float32Array {
  let d = _liftDelta.get(asset);
  if (!d) { d = new Float32Array(asset.vertexCount * 6); for (let i = 0; i < asset.vertexCount; i++) d[i * 6 + 1] = 1; _liftDelta.set(asset, d); }
  return d;
}

/** The asset's base as a GltfSkinnedResult (fresh arrays — the asset tables stay immutable). */
export function bodyV2Result(asset: BodyV2Asset): GltfSkinnedResult {
  const jc = asset.jointNames.length;
  const { inverseBind } = bodyV2InverseBinds(asset.jointParents, asset.jointLocal);
  const rot = new Float32Array(jc * 4), scl = new Float32Array(jc * 3);
  for (let i = 0; i < jc; i++) { rot[i * 4 + 3] = 1; scl.set([1, 1, 1], i * 3); }
  return {
    name: 'CharacterV2', geometry: { vertices: new Float32Array(asset.vertices), indices: new Uint32Array(asset.indices), format: '12float' },
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], diffuseImage: null, normalMapImage: null,
    diffuseColor: [0.9, 0.78, 0.72, 1], isTransparent: false, morphTargets: [],
    skinning: {
      jointIndices: new Uint8Array(asset.jointIndices), jointWeights: new Float32Array(asset.jointWeights),
      inverseBindMatrices: inverseBind, jointNames: [...asset.jointNames], skinName: 'character_v2',
      jointParents: new Int16Array(asset.jointParents), jointLocalPositions: new Float32Array(asset.jointLocal),
      jointLocalRotations: rot, jointLocalScales: scl,
    },
  };
}

/** A Skeleton3D from a skinned result (the same construction as Scene3DManager._createSkeletonFromResult). */
export function skeletonFromResult(result: GltfSkinnedResult): Skeleton3D {
  const s = result.skinning, joints: Joint3D[] = [];
  for (let i = 0; i < s.jointNames.length; i++) {
    const t = s.jointLocalPositions.subarray(i * 3, i * 3 + 3), q = s.jointLocalRotations.subarray(i * 4, i * 4 + 4), sc = s.jointLocalScales.subarray(i * 3, i * 3 + 3);
    joints.push({
      index: i, name: s.jointNames[i], parentIndex: s.jointParents[i], children: [],
      localPosition: [t[0], t[1], t[2]], localRotation: [q[0], q[1], q[2], q[3]], localScale: [sc[0], sc[1], sc[2]],
      tailOffset: [0, 0.3, 0], worldMatrix: new Float32Array(16), inverseBindMatrix: new Float32Array(s.inverseBindMatrices.subarray(i * 16, i * 16 + 16)),
    });
  }
  for (const j of joints) if (j.parentIndex >= 0) joints[j.parentIndex].children.push(j.index);
  const data: SkeletonData = { name: s.skinName, joints };
  const sk = new Skeleton3D(data);
  sk.name = s.skinName;
  return sk;
}

/** The disabled limb IK chains a new v2 rig gets (end joint, mid joint, pole offset along the body's forward axis). */
const LIMB_IK: readonly (readonly [string, string, number])[] = [
  ['hand_L', 'lowerarm_L', -0.4], ['hand_R', 'lowerarm_R', -0.4],   // elbows point back
  ['foot_L', 'lowerleg_L', 0.4], ['foot_R', 'lowerleg_R', 0.4],      // knees point forward
];

/** Everything a restore / duplicate rebuilds a character from (a marker, or a live snapshot of one). */
interface Spawn {
  base: BodyV2Base; sliders: BodyV2Sliders; name: string; transform: CharacterV2Marker['transform'];
  meshId?: string; skeletonId?: string; parentId?: string; mesh?: CharacterV2MeshState; rig?: CharacterV2RigState;
  /** A v < 2 marker: the transform's origin sat at the hips of this asset → re-anchor on its soles. */
  legacyAsset?: string;
}

export class CharacterV2Manager {
  private _recs = new Map<string, Rec>();   // keyed by body mesh id
  private _counter = 0;
  /** Load generation: bumped by clearForDocumentLoad; a build that awaited across it is torn down (review runtime#6). */
  private _epoch = 0;
  /** Markers whose rebuild is in flight (a second restoreFromSave skips them). */
  private _inflight = new Map<MeshGroup3D, Promise<Rec | null>>();
  private _restoring: Promise<number> | null = null;
  /** The last slider undo step pushed (consecutive changes of the same sliders coalesce into it). */
  private _lastUndo: { rec: Rec; keys: string; desc: string; before: BodyV2Sliders; after: BodyV2Sliders } | null = null;
  private _undoSeq = 0;

  constructor(private readonly host: CharacterV2Host, opts: { consoleHandle?: boolean } = {}) {
    host.registerProvider?.({
      owns: (id) => !!this._rec(id),
      hidden: (id) => this._isMarkerId(id),
      delete: (id) => this.delete(id),
      duplicate: (id) => { void this.duplicate(id).catch((e) => console.warn('[character-v2] duplicate failed', e)); return true; },
    });
    if (opts.consoleHandle !== false && typeof window !== 'undefined') {
      // DEV console handle (docs/ui/character-v2.md):
      //   const h = await salsaCharV2.create()            → spawn the Persona fem base at the origin
      //   salsaCharV2.set(h.rootId, 'waist', -0.6)         → live slider (normalised −1..1; no regeneration)
      //   salsaCharV2.sliders() / .get(h.rootId) / .params(h.rootId)
      //   sm.enterPlayMode3D({ playerMeshId: h.rootId }) → walk it with the default gait
      (window as unknown as { salsaCharV2?: unknown }).salsaCharV2 = {
        create: (o?: CreateCharacterV2Options) => this.create(o),
        set: (id: string, name: string, v: number) => this.setSlider(id, name, v),
        setMany: (id: string, s: BodyV2Sliders) => this.setSliders(id, s),
        get: (id: string) => this.getSliders(id),
        params: (id: string) => this.getParams(id),
        sliders: (base?: BodyV2Base) => this.sliderDefs(base),
        list: () => this.list(),
        handle: (id: string) => this.toHandle(id),
        duplicate: (id: string) => this.duplicate(id),
        delete: (id: string) => this.delete(id),
        remove: (id: string) => this.remove(id),
        reset: (id: string) => this.setSliders(id, {}, true),
      };
    }
  }

  /** The slider list (normalised −1..1, 0 = base) with the generator value −1 / 0 / +1 stand for ON `base` (the ranges
   *  are per base). */
  sliderDefs(base: BodyV2Base = 'fem'): { name: string; min: number; base: number; max: number; kind: string }[] {
    return [
      { name: 'height', min: BODY_V2_HEIGHT_RANGE.min, base: 1, max: BODY_V2_HEIGHT_RANGE.max, kind: 'scale' },
      ...bodyV2SliderTable(base === 'masc' ? 'masc' : 'fem'),
    ];
  }

  /** Spawn a v2 character (the frozen base body + sliders). Bakes the asset once per session (time-sliced: the thread
   *  is handed back between generator runs — getBodyV2AssetAsync). Rejects if a document load starts meanwhile (the
   *  half-built character is removed — it never lands in the next document). */
  async create(opts: CreateCharacterV2Options = {}): Promise<CharacterHandle> {
    const ep = this._epoch;
    const base: BodyV2Base = opts.base === 'masc' ? 'masc' : 'fem';
    const name = opts.name ?? `Character v2 ${++this._counter}`;
    const p = opts.position ?? [0, 0, 0];
    const rec = await this._build(base, name, cleanSliders(opts.sliders), null, ep, {});
    if (!rec) throw new Error('[character-v2] create() cancelled: the document changed');
    // Place: soles on the requested point (the node origin IS the soles); in a city, real human size (1.7 m) like v1.
    const mpu = this.host.sceneMetresPerUnit();
    if (mpu !== null && mpu > 0) {
      const H = maxY(rec.mesh.geometry.vertices);   // the soles sit at 0
      const k = H > 0 ? (1.7 / mpu) / H : 1;
      if (Number.isFinite(k) && k > 0 && Math.abs(k - 1) > 1e-12) rec.mesh.setScale3D(rec.mesh.scaleX * k, rec.mesh.scaleY * k, rec.mesh.scaleZ * k);
    }
    rec.mesh.setPosition3D(p[0], p[1], p[2]);
    this._syncSkeleton(rec);
    if (!(await this._finishRig(rec, ep, true))) throw new Error('[character-v2] create() cancelled: the document changed');
    this.host.applyCharacterOutline?.(rec.mesh);
    return this.toHandle(rec.mesh.id)!;
  }

  /** Alias of {@link create} (the spec's name). */
  createCharacterV2(opts: CreateCharacterV2Options = {}): Promise<CharacterHandle> { return this.create(opts); }

  private _stale(ep: number, marker: MeshGroup3D | null): boolean { return ep !== this._epoch || (marker !== null && !marker.parent); }

  /** Build the rig (no placement): asset bake, skeleton (a saved rig's, or the asset's), mesh, blend shapes, marker,
   *  record, then the slider state. null = the document changed during an await (everything built is removed). */
  private async _build(base: BodyV2Base, name: string, sliders: BodyV2Sliders, marker: MeshGroup3D | null, ep: number,
    o: { meshId?: string; skeletonId?: string; rig?: CharacterV2RigState }): Promise<Rec | null> {
    const asset = await getBodyV2AssetAsync(base);
    if (this._stale(ep, marker)) return null;
    const result = bodyV2Result(asset);
    const na = asset.jointNames.length;
    let skeleton: Skeleton3D | null = null;
    let rest = new Float32Array(asset.jointLocal);
    if (o.rig?.skeleton) {
      try {
        const sk = Skeleton3D.fromJSON(o.rig.skeleton);
        const byName = new Map(sk.data.joints.map((j) => [j.name, j] as const));
        if (asset.jointNames.every((n) => byName.has(n))) {
          skeleton = sk;
          if (Array.isArray(o.rig.rest) && o.rig.rest.length === na * 3 && o.rig.rest.every(Number.isFinite)) rest = Float32Array.from(o.rig.rest);
          else asset.jointNames.forEach((n, a) => rest.set(byName.get(n)!.localPosition, a * 3));   // no saved rest: no offsets
        } else console.warn('[character-v2] saved rig lacks asset joints: rebuilding the default rig');
      } catch (e) { console.warn('[character-v2] saved rig unreadable: rebuilding the default rig', e); }
    }
    const fresh = !skeleton;
    if (!skeleton) skeleton = skeletonFromResult(result);
    const taken = (id: string | undefined) => !id || (this.host.isIdTaken?.(id) ?? false);
    const skelId = o.skeletonId ?? (o.rig?.skeleton as { id?: string } | undefined)?.id;
    if (skelId && !taken(skelId)) skeleton.id = skelId;
    else if (!fresh) skeleton.id = crypto.randomUUID();   // a pasted / duplicated rig must not share the original's id
    const { mesh } = await this.host.createRigged(result, 0, 0, 0, name, { meshId: taken(o.meshId) ? undefined : o.meshId, skeleton });
    if (this._stale(ep, marker)) { this.host.removeCharacter(mesh, skeleton); return null; }
    mesh.name = name;
    (mesh as V2Flagged).characterKind = 'v2';       // the shared "is a character body" predicate (runtime-only)
    (skeleton as V2Flagged).characterKind = 'v2';
    mesh.excludeFromDocument = true;      // the marker is the save; the body is rebuilt from it
    skeleton.excludeFromDocument = true;
    mesh.transformViaSkeleton = true;     // the body transform drives the skeleton (gizmo moves the character)
    if (fresh) skeleton.skinningMethod = 'dualQuat';   // as v1's new bodies (volume-preserving joints); a saved rig keeps its own
    mesh.material.doubleSided = true;
    mesh.material.metalness = 0; mesh.material.roughness = 0.72; mesh.material.softLighting = true;   // v1 skin look
    const defaultMaterial: Record<string, string> = {};
    for (const [k, v] of Object.entries(mesh.material)) defaultMaterial[k] = JSON.stringify(v);
    // Blend shapes through the PUBLIC Mesh3D API (the renderer makes them fast). The asset holds each shape ONCE, as
    // the dense array Mesh3D takes, shared read-only between every character of the base (no copy). Plus the runtime
    // lift (soles at mesh y = 0).
    mesh.baseVertices = new Float32Array(asset.vertices);
    const shapes: BlendShape[] = asset.shapes.map((s, i) => ({ name: s.name, deltaVertices: denseShapeDelta(asset, i) }));
    shapes.push({ name: CHARACTER_V2_LIFT_SHAPE, deltaVertices: liftDelta(asset) });
    mesh.blendShapes = shapes.slice();
    mesh.blendWeights = new Float32Array(shapes.length);
    const m = marker ?? this.host.createMarker(`${name} (v2 save)`);
    const rec: Rec = {
      marker: m, mesh, skeleton, asset, sliders, rest, lift: 0, heightApplied: 0, shapes,
      slot: Int32Array.from(shapes.map((_, i) => i)), defaultMaterial,
    };
    this._bindMarker(rec);
    this._recs.set(mesh.id, rec);
    this._applyShape(rec, { initial: true });
    return rec;
  }

  /** After placement: a NEW rig gets the default stance + clips (setupRig) and its limb IK chains seeded in the
   *  character's own frame; a restored rig gets its stripped defaults back. False = the document changed meanwhile
   *  (the character was removed). */
  private async _finishRig(r: Rec, ep: number, fresh: boolean): Promise<boolean> {
    if (fresh) {
      await this.host.setupRig?.(r.mesh, r.skeleton);
      if (this._stale(ep, null) || this._recs.get(r.mesh.id) !== r) { this._teardown(r); return false; }
    } else this.host.installDefaults?.(r.skeleton);
    this._syncSkeleton(r);
    if (fresh) this._syncLimbIK(r, true);   // a restored rig keeps its saved chains exactly
    return true;
  }

  private _teardown(r: Rec): void {
    if (this._recs.get(r.mesh.id) === r) this._recs.delete(r.mesh.id);
    this.host.removeCharacter(r.mesh, r.skeleton);
    if (r.marker.parent) this.host.removeMarker(r.marker);
  }

  private _rec(id: string): Rec | null {
    const r = this._recs.get(id);
    if (r) return r;
    for (const x of this._recs.values()) if (x.marker.id === id || x.skeleton.id === id) return x;
    return null;
  }
  private _isMarkerId(id: string): boolean {
    for (const x of this._recs.values()) if (x.marker.id === id) return true;
    for (const g of this._inflight.keys()) if (g.id === id) return true;
    return false;
  }

  /** Set one slider (normalised −1..1, 0 = the base; ±Infinity clamps, a numeric string is accepted). No regeneration.
   *  False — and nothing changes — for an unknown id / slider or a value that is not a number (NaN, null, …).
   *  Undoable (consecutive changes of the same slider coalesce into one step) unless `opts.undo` is false. */
  setSlider(id: string, name: string, value: number, opts?: { undo?: boolean }): boolean {
    if (!SLIDER_NAMES.has(name)) return false;
    if (coerceBodyV2Slider(value) === null) return false;
    const r = this._rec(id);
    if (!r) return false;
    return this.setSliders(id, { [name]: value }, false, opts);
  }

  /** Merge (or with `replace`, set) several sliders at once. No regeneration. ATOMIC: false, and nothing changes, when
   *  any key is unknown or any value is not a number (editBodyV2Sliders). Undoable like setSlider. */
  setSliders(id: string, sliders: BodyV2Sliders, replace = false, opts?: { undo?: boolean }): boolean {
    const r = this._rec(id);
    if (!r) return false;
    const next = editBodyV2Sliders(r.sliders, sliders, replace);
    if (!next) return false;
    const before = { ...r.sliders };
    if (sameSliders(before, next)) return true;
    r.sliders = next;
    this._applyShape(r);
    if (opts?.undo !== false) this._pushSliderUndo(r, before);
    return true;
  }

  getSliders(id: string): BodyV2Sliders | null { const r = this._rec(id); return r ? { ...r.sliders } : null; }
  /** The generator params this slider state is equivalent to (height excluded — it is the node scale). */
  getParams(id: string): BodyV2GenParams | null { const r = this._rec(id); return r ? sliderParams(r.asset.params, r.sliders) : null; }
  getAsset(id: string): BodyV2Asset | null { return this._rec(id)?.asset ?? null; }
  /** The mesh-space lift currently applied (the asset's un-lifted soles sit at −lift) — diagnostics / tests. */
  getLift(id: string): number | null { return this._rec(id)?.lift ?? null; }

  toHandle(id: string): CharacterHandle | null {
    const r = this._rec(id);
    return r ? { kind: 'v2', rootId: r.mesh.id, skeletonId: r.skeleton.id, partIds: [r.mesh.id], markerId: r.marker.id } : null;
  }
  list(): CharacterHandle[] { return [...this._recs.keys()].map((id) => this.toHandle(id)!); }
  isCharacterV2(id: string): boolean { return !!this._rec(id); }

  /** Delete a character as ONE undoable step (body + skeleton + save marker + record; undo re-attaches all four). The
   *  outliner's mesh / group delete and Ctrl+D route here through the engine's character-provider hook. `id` = the
   *  body, skeleton or marker id. */
  delete(id: string): boolean {
    const r = this._rec(id);
    if (!r) return false;
    let st = this._detach(r);
    this.host.pushUndo?.({
      description: 'Delete character',
      undo: () => { this._lastUndo = null; if (!this._recs.has(r.mesh.id)) this._attach(r, st); },
      redo: () => { this._lastUndo = null; if (this._recs.get(r.mesh.id) === r) st = this._detach(r); },
    });
    this.host.requestRender();
    return true;
  }
  private _detach(r: Rec): { meshParent: unknown; markerParent: unknown; wasIdle: boolean } {
    const meshParent = r.mesh.parent, markerParent = r.marker.parent;
    let wasIdle = false;
    if (this.host.detachCharacter) wasIdle = this.host.detachCharacter(r.mesh, r.skeleton).wasIdle;
    else { r.mesh.parent?.removeChild(r.mesh); r.skeleton.parent?.removeChild(r.skeleton); }
    r.marker.parent?.removeChild(r.marker);
    this._recs.delete(r.mesh.id);
    return { meshParent, markerParent, wasIdle };
  }
  private _attach(r: Rec, st: { meshParent: unknown; markerParent: unknown; wasIdle: boolean }): void {
    type P = { addChild(n: unknown): void } | null;
    if (!r.marker.parent) (st.markerParent as P)?.addChild(r.marker);
    if (this.host.attachCharacter) this.host.attachCharacter(r.mesh, r.skeleton, st.meshParent, { idle: st.wasIdle });
    else {
      const root = st.markerParent as P;
      if (!r.skeleton.parent) root?.addChild(r.skeleton);
      if (!r.mesh.parent) ((st.meshParent as P) ?? root)?.addChild(r.mesh);
    }
    this._recs.set(r.mesh.id, r);
    this._syncSkeleton(r);
  }

  /** Remove a character for good (no undo step; the console / API teardown). Prefer {@link delete} from UI. */
  remove(id: string): boolean {
    const r = this._rec(id);
    if (!r) return false;
    this._recs.delete(r.mesh.id);
    if (this._lastUndo?.rec === r) this._lastUndo = null;
    this.host.removeCharacter(r.mesh, r.skeleton);
    this.host.removeMarker(r.marker);
    this.host.requestRender();
    return true;
  }

  /** A REAL copy of a character (Ctrl+D / outliner Duplicate route here): a new body with its own ids, marker and
   *  vertex arrays, the same base, sliders (height included), node scale, rotation, pose, clips, IK and per-body
   *  state, offset sideways. One undo step (undo = delete the copy). */
  async duplicate(id: string): Promise<CharacterHandle | null> {
    const r = this._rec(id);
    if (!r) return null;
    const snap = this._markerOf(r, true);
    const t = { ...snap.transform };
    const off = 0.6 * Math.abs(t.s || 1);   // ~ a body width at this scale
    t.x += off;
    const rig = snap.rig ? plain(snap.rig) : undefined;
    const chains = (rig?.skeleton as { skeletonData?: { ikChains?: IKChain[] } } | undefined)?.skeletonData?.ikChains;
    for (const c of chains ?? []) { c.target[0] += off; if (c.poleTarget) c.poleTarget[0] += off; }   // world points
    const rec = await this._spawn({
      base: snap.base, sliders: snap.sliders, name: `${r.mesh.name} copy`, transform: t,
      mesh: snap.mesh ? plain(snap.mesh) : undefined, rig, parentId: snap.parentId,
    }, null, this._epoch);
    if (!rec) return null;
    let st: ReturnType<CharacterV2Manager['_detach']> | null = null;
    this.host.pushUndo?.({
      description: 'Duplicate character',
      undo: () => { this._lastUndo = null; if (this._recs.get(rec.mesh.id) === rec) st = this._detach(rec); },
      redo: () => { this._lastUndo = null; if (st && !this._recs.has(rec.mesh.id)) this._attach(rec, st); },
    });
    return this.toHandle(rec.mesh.id);
  }

  /** Document-load reset: forget every record and cancel in-flight builds (the load generation moves on); the old
   *  document's bodies are removed if still in the scene. */
  clearForDocumentLoad(): void {
    this._epoch++;
    for (const r of this._recs.values()) if (r.mesh.parent || r.skeleton.parent) this.host.removeCharacter(r.mesh, r.skeleton);
    this._recs.clear(); this._inflight.clear(); this._counter = 0; this._lastUndo = null;
  }

  /** Rebuild every v2 character from the markers a loaded document restored. Returns how many were rebuilt.
   *  Idempotent and safe to call concurrently (hosts call restoreProceduralFromSave3D more than once per load): a
   *  marker already restored or in flight is skipped, and a call made while another runs waits for it, then rescans. */
  async restoreFromSave(): Promise<number> {
    while (this._restoring) { try { await this._restoring; } catch { /* the other call reports its own failure */ } }
    const run = this._restoreOnce(this._epoch);
    this._restoring = run;
    try { return await run; } finally { if (this._restoring === run) this._restoring = null; }
  }
  /** Resolves when no restore is running (callers that must wait for the bodies). */
  async whenRestored(): Promise<void> { while (this._restoring) { try { await this._restoring; } catch { /* reported by its caller */ } } }

  private async _restoreOnce(ep: number): Promise<number> {
    const jobs: Promise<Rec | null>[] = [];
    for (const g of this.host.getRootMeshGroups()) {
      if (this._inflight.has(g) || [...this._recs.values()].some((r) => r.marker === g)) continue;
      const wp = g.worldParams as Partial<CharacterV2Marker> | null;
      if (!wp || wp.kind !== CHARACTER_V2_KIND) continue;
      if (wp.removed) { this.host.removeMarker(g); continue; }
      // Older asset versions with the same semantic sliders (body-v2@1) restore onto the current asset with their slider
      // values (placement migrated in _spawn); the next save writes the current version. Anything else is restored the
      // same way, with a warning.
      if (wp.asset !== BODY_V2_ASSET && !BODY_V2_COMPATIBLE.includes(wp.asset ?? '')) console.warn(`[character-v2] marker asset ${wp.asset} ≠ ${BODY_V2_ASSET}: restoring on the current asset`);
      const t = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1, ...(wp.transform ?? {}) };
      const spawn: Spawn = {
        base: wp.base === 'masc' ? 'masc' : 'fem', sliders: cleanSliders(wp.sliders), transform: t,
        name: wp.name ?? g.name.replace(/ \(v2 save\)$/, ''),
        meshId: wp.meshId, skeletonId: wp.skeletonId, parentId: wp.parentId, mesh: wp.mesh, rig: wp.rig,
        ...((wp.v ?? 1) < CHARACTER_V2_MARKER_VERSION ? { legacyAsset: wp.asset ?? BODY_V2_ASSET } : {}),
      };
      const job = this._spawn(spawn, g, ep);
      this._inflight.set(g, job);
      jobs.push(job.finally(() => { if (this._inflight.get(g) === job) this._inflight.delete(g); }));
    }
    const done = await Promise.all(jobs);
    if (ep === this._epoch) this._counter = Math.max(this._counter, this._recs.size);
    return done.filter((r) => r !== null).length;
  }

  /** Build + place a character from a marker / snapshot (restore and duplicate). */
  private async _spawn(s: Spawn, marker: MeshGroup3D | null, ep: number): Promise<Rec | null> {
    const rec = await this._build(s.base, s.name, s.sliders, marker, ep, { meshId: s.meshId, skeletonId: s.skeletonId, rig: s.rig });
    if (!rec) return null;
    const t = s.transform, mesh = rec.mesh;
    mesh.setScale3D(t.sx ?? t.s, t.s, t.sz ?? t.s);
    mesh.setRotation3D(t.rx, t.ry, t.rz);
    mesh.setPosition3D(t.x, t.y, t.z);
    if (s.legacyAsset) {
      // A v < 2 marker saved the node ORIGIN at the saving asset's hips: its soles sat `soleY` (mesh space) along the
      // body's up axis. The node origin is now the soles: move it there, so the FEET stay where they stood (a v2@1
      // masc otherwise sank 6.4 cm — review pipeline#7). soleY: the marker's own, else rebuilt from that asset.
      const savedSole = typeof t.soleY === 'number' && Number.isFinite(t.soleY) ? t.soleY
        : ((await bodyV2LegacySoleY(s.legacyAsset, s.base, s.sliders).catch(() => null)) ?? -rec.lift);
      if (this._stale(ep, marker) || this._recs.get(mesh.id) !== rec) { this._teardown(rec); return null; }
      const M = mesh.localMatrix;
      mesh.setPosition3D(t.x + M[4] * savedSole, t.y + M[5] * savedSole, t.z + M[6] * savedSole);
    }
    this._applyMeshState(rec, s.mesh);
    if (s.parentId) {
      const pg = this.host.findGroup?.(s.parentId);
      if (pg && pg !== mesh.parent) { mesh.parent?.removeChild(mesh); pg.addChild(mesh); }
    }
    this._syncSkeleton(rec);
    if (!(await this._finishRig(rec, ep, !s.rig?.skeleton))) return null;
    if (s.mesh?.outline || s.mesh?.outlineRings) this.host.restoreOutline?.(mesh, s.mesh.outline ?? null, s.mesh.outlineRings ?? null);
    else this.host.applyCharacterOutline?.(mesh);
    return rec;
  }

  private _applyMeshState(r: Rec, st: CharacterV2MeshState | undefined): void {
    if (!st) return;
    const m = r.mesh;
    if (st.visible === false) m.visible = false;
    if (st.locked === true) m.locked = true;
    if (st.material && typeof st.material === 'object') { Object.assign(m.material, st.material); m.gpuDirty = true; }
    if (typeof st.cameraBlock === 'string' && ['auto', 'block', 'ignore'].includes(st.cameraBlock)) m.cameraBlock = st.cameraBlock as Mesh3D['cameraBlock'];
    if (st.keyframeTracks && typeof st.keyframeTracks === 'object') m.keyframeTracks = plain(st.keyframeTracks) as Mesh3D['keyframeTracks'];
    if (typeof st.textureLibraryId === 'string') m.textureLibraryId = st.textureLibraryId;
    if (typeof st.normalMapLibraryId === 'string') m.normalMapLibraryId = st.normalMapLibraryId;
    if (!this.host.restoreOutline && (st.outline || st.outlineRings)) {   // a minimal host: the node fields only
      m.outline = (st.outline ?? null) as Mesh3D['outline'];
      m.outlineRings = (st.outlineRings ?? null) as Mesh3D['outlineRings'];
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** The ONLY thing a slider does: blend weights (v2's own slots), the soles back at mesh y = 0 (the lift), bone rest
   *  offsets + inverse binds, the height node scale. */
  private _applyShape(r: Rec, o: { initial?: boolean } = {}): void {
    const { mesh, asset } = r;
    const w = bodyV2Weights(asset, r.sliders);
    // Soles back to y = 0: the lift for these weights (Y deltas only — no second full CPU evaluation, review runtime#9),
    // written with the slider weights, ONE blend evaluation.
    r.lift = -soleOf(asset, w);
    this._writeWeights(r, w);
    this._evaluate(mesh);
    // Bones: rest local positions (the lift on the root) + inverse binds; added joints follow (review pipeline#4).
    const J = bodyV2JointLocal(asset, w);
    for (let a = 0; a < asset.jointParents.length; a++) if (asset.jointParents[a] < 0) J[a * 3 + 1] += r.lift;
    const restDelta = this._applyRest(r, J);
    // Height = the uniform node scale about the origin (= the soles): y never moves.
    const f = heightScale(r.sliders.height) / heightScale(r.heightApplied);
    r.heightApplied = r.sliders.height ?? 0;
    if (Math.abs(f - 1) > 1e-12) {
      if (!o.initial && this.host.setCharacterScale) this.host.setCharacterScale(mesh, Math.abs(mesh.scaleY) * f);
      else mesh.setScale3D(mesh.scaleX * f, mesh.scaleY * f, mesh.scaleZ * f);
    }
    (mesh as { calculateBoundingBox?: () => void }).calculateBoundingBox?.();
    this._syncSkeleton(r);
    if (o.initial) return;
    this._syncLimbIK(r, false);
    if (restDelta) this.host.refreshPlayAvatar?.(mesh, restDelta);
  }

  private _evaluate(mesh: SkinnedMesh3D): void {
    // The blend-shape fast path (Phase 1.5, Scene3DBlendShapes.sync semantics for a skinned part): only the CHANGED
    // weights are applied, over each shape's sparse support, and the renderer re-sends the dirty range in place (keyed
    // on blendVersion — no skinDirty, no buffer re-creation). Old path: full evaluation + skinDirty.
    if (Mesh3D.blendFastPath && typeof mesh.applyBlendWeights === 'function') mesh.applyBlendWeights();
    else { mesh.evaluateBlendShapes(); mesh.skinDirty = true; }
  }

  /** Write v2's weights into ITS slots of mesh.blendWeights only (other shapes on the body keep theirs; a generic
   *  add / remove elsewhere in the list shifts nothing; a v2 shape removed by a generic call is put back). */
  private _writeWeights(r: Rec, w: Float32Array): void {
    const mesh = r.mesh;
    let shapes = mesh.blendShapes;
    for (let i = 0; i < r.shapes.length; i++) {
      const want = r.shapes[i].deltaVertices;
      if (shapes[r.slot[i]]?.deltaVertices === want) continue;
      let j = shapes.findIndex((s) => s.deltaVertices === want);
      if (j < 0) { shapes = mesh.blendShapes = [...shapes, r.shapes[i]]; j = shapes.length - 1; }
      r.slot[i] = j;
    }
    if (mesh.blendWeights.length !== shapes.length) {
      const nw = new Float32Array(shapes.length);
      nw.set(mesh.blendWeights.subarray(0, Math.min(nw.length, mesh.blendWeights.length)));
      mesh.blendWeights = nw;
    }
    const bw = mesh.blendWeights, nShapes = r.shapes.length - 1;
    for (let i = 0; i < nShapes; i++) bw[r.slot[i]] = w[i] ?? 0;
    bw[r.slot[nShapes]] = r.lift;
  }

  /** Move the asset joints' rest to `J` (local positions, lift included): each joint keeps its offset from the rest (a
   *  user / animated translation survives), its inverse bind = the new rest; a joint ADDED to the skeleton (spring
   *  chain, charm) keeps its local rest and its inverse bind follows its nearest asset ancestor's rest shift (exact:
   *  asset rest rotations are identity) — it no longer goes NaN (review pipeline#4). Returns the per-SKELETON-joint
   *  rest delta (3 floats each), or null when nothing moved. */
  private _applyRest(r: Rec, J: Float32Array): Float32Array | null {
    const { asset, skeleton } = r;
    const joints = skeleton.data.joints, na = asset.jointNames.length;
    const map = new Int32Array(na).fill(-1), isAsset = new Uint8Array(joints.length);
    const byName = new Map<string, number>();
    joints.forEach((j, i) => { if (!byName.has(j.name)) byName.set(j.name, i); });
    for (let a = 0; a < na; a++) { const i = byName.get(asset.jointNames[a]); if (i !== undefined) { map[a] = i; isAsset[i] = 1; } }
    const prev = r.rest;
    const { world: Wn, inverseBind } = bodyV2InverseBinds(asset.jointParents, J);
    const { world: Wo } = bodyV2InverseBinds(asset.jointParents, prev);
    const delta = new Float32Array(joints.length * 3);
    let moved = false;
    for (let a = 0; a < na; a++) {
      const i = map[a];
      if (i < 0) continue;
      const jt = joints[i], lp = jt.localPosition;
      const dx = J[a * 3] - prev[a * 3], dy = J[a * 3 + 1] - prev[a * 3 + 1], dz = J[a * 3 + 2] - prev[a * 3 + 2];
      if (dx !== 0 || dy !== 0 || dz !== 0) { moved = true; jt.localPosition = [lp[0] + dx, lp[1] + dy, lp[2] + dz]; }
      delta[i * 3] = dx; delta[i * 3 + 1] = dy; delta[i * 3 + 2] = dz;
      jt.inverseBindMatrix.set(inverseBind.subarray(a * 16, a * 16 + 16));
    }
    if (joints.length > na || map.some((i) => i < 0)) {
      const assetOf = new Map<number, number>();
      for (let a = 0; a < na; a++) if (map[a] >= 0) assetOf.set(map[a], a);
      for (let i = 0; i < joints.length; i++) {
        if (isAsset[i]) continue;
        let p = joints[i].parentIndex, guard = 0;
        while (p >= 0 && !isAsset[p] && guard++ < joints.length) p = joints[p].parentIndex;
        const a = p >= 0 ? assetOf.get(p) : undefined;
        if (a === undefined) continue;
        const tx = -(Wn[a * 3] - Wo[a * 3]), ty = -(Wn[a * 3 + 1] - Wo[a * 3 + 1]), tz = -(Wn[a * 3 + 2] - Wo[a * 3 + 2]);
        if (tx === 0 && ty === 0 && tz === 0) continue;
        const m = joints[i].inverseBindMatrix;   // IBM ← IBM · T(−Δrest of the asset ancestor) (column-major)
        m[12] += m[0] * tx + m[4] * ty + m[8] * tz;
        m[13] += m[1] * tx + m[5] * ty + m[9] * tz;
        m[14] += m[2] * tx + m[6] * ty + m[10] * tz;
        m[15] += m[3] * tx + m[7] * ty + m[11] * tz;
      }
    }
    r.rest = J;
    return moved ? delta : null;
  }

  private _syncSkeleton(r: Rec): void {
    r.skeleton.objectTransform.set(r.mesh.localMatrix as unknown as Float32Array);
    r.skeleton.computeWorldMatrices();
    r.skeleton.matricesDirty = true;
    r.mesh.stateDirty = true;
    this.host.requestRender();
  }

  /** The limb IK chains in the CHARACTER's frame (review runtime#8): target = the end joint where it is now (no snap
   *  when a chain is enabled), pole = the mid joint + the body's own forward axis × ±0.4 × its scale (a rotated or
   *  city-scaled character bends its knees forward / elbows back). Only DISABLED chains are re-seeded (an enabled one
   *  is the user's); `create` adds missing chains (a new rig). Written straight into the chain data (no events — this
   *  runs on every slider change). */
  private _syncLimbIK(r: Rec, create: boolean): void {
    const sk = r.skeleton, joints = sk.data.joints;
    sk.computeWorldMatrices();
    const o = sk.objectTransform;
    const sc = Math.hypot(o[8], o[9], o[10]) || 1;
    const fx = o[8] / sc, fy = o[9] / sc, fz = o[10] / sc;
    const idx = (n: string) => joints.findIndex((j) => j.name === n);
    let added = false;
    for (const [end, mid, poleZ] of LIMB_IK) {
      const e = idx(end), m = idx(mid);
      if (e < 0 || m < 0) continue;
      let c = sk.data.ikChains?.find((k) => k.endJointIdx === e);
      if (!c) {
        if (!create) continue;
        c = { id: Math.random().toString(36).slice(2, 10), endJointIdx: e, chainLength: 3, target: [0, 0, 0], blendWeight: 1, enabled: false };
        (sk.data.ikChains ??= []).push(c);
        added = true;
      }
      if (c.enabled) continue;
      const we = joints[e].worldMatrix, wm = joints[m].worldMatrix, d = poleZ * sc;
      c.target = [we[12], we[13], we[14]];
      c.poleTarget = [wm[12] + fx * d, wm[13] + fy * d, wm[14] + fz * d];
    }
    if (added) this.host.requestRender();
  }

  /** The marker's worldParams is LIVE (a getter over the record), so every save writes the current state (sliders, the
   *  gizmo transform, the rig, the node state) with no stamping hooks. */
  private _bindMarker(r: Rec): void {
    const self = this;
    Object.defineProperty(r.marker, 'worldParams', {
      configurable: true, enumerable: true,
      get(): CharacterV2Marker { return self._markerOf(r, false); },
      set(_v: unknown) { /* owned by the CharacterV2Manager */ },
    });
  }
  /** The marker for a record. The light fields are plain; `rig` and `mesh` are LAZY (enumerable getters — JSON /
   *  spread evaluate them, a `worldParams.kind` scan does not). `eager` = plain values (a duplicate snapshot). */
  private _markerOf(r: Rec, eager: boolean): CharacterV2Marker {
    const m = r.mesh;
    const parent = m.parent as { id?: string; parent?: unknown } | null;
    const parentId = parent && parent.parent && typeof parent.id === 'string' && parent !== (r.marker.parent as unknown) ? parent.id : undefined;
    const t: CharacterV2Marker['transform'] = { x: m.x, y: m.y, z: m.z, rx: m.rotationX, ry: m.rotationY, rz: m.rotation, s: m.scaleY };
    if (m.scaleX !== m.scaleY) t.sx = m.scaleX;
    if (m.scaleZ !== m.scaleY) t.sz = m.scaleZ;
    const out: CharacterV2Marker = {
      kind: CHARACTER_V2_KIND, v: CHARACTER_V2_MARKER_VERSION, asset: r.asset.asset, base: r.asset.base, sliders: { ...r.sliders }, name: m.name,
      meshId: m.id, skeletonId: r.skeleton.id, transform: t,
      ...(parentId ? { parentId } : {}),
      ...(this._recs.get(m.id) === r && m.parent ? {} : { removed: true }),
    };
    if (eager) {
      const ms = this._meshStateOf(r);
      if (ms) out.mesh = ms;
      out.rig = this._rigOf(r);
      return out;
    }
    const self = this;
    Object.defineProperty(out, 'mesh', { enumerable: true, configurable: true, get: () => self._meshStateOf(r) });
    Object.defineProperty(out, 'rig', { enumerable: true, configurable: true, get: () => self._rigOf(r) });
    return out;
  }
  private _meshStateOf(r: Rec): CharacterV2MeshState | undefined {
    const m = r.mesh, o: CharacterV2MeshState = {};
    if (!m.visible) o.visible = false;
    if (m.locked) o.locked = true;
    if (m.outline) o.outline = plain(m.outline);
    if (m.outlineRings?.length) o.outlineRings = plain(m.outlineRings);
    const mat: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m.material)) {
      if (k === 'hasTexture' || k === 'hasNormalMap' || v === undefined) continue;   // derived from the bound textures
      const j = JSON.stringify(v);
      if (j !== r.defaultMaterial[k]) mat[k] = JSON.parse(j);
    }
    if (Object.keys(mat).length) o.material = mat;
    if (m.cameraBlock && m.cameraBlock !== 'auto') o.cameraBlock = m.cameraBlock;
    if (m.keyframeTracks && Object.keys(m.keyframeTracks).length) o.keyframeTracks = plain(m.keyframeTracks) as Record<string, unknown>;
    if (m.textureLibraryId) o.textureLibraryId = m.textureLibraryId;
    if (m.normalMapLibraryId) o.normalMapLibraryId = m.normalMapLibraryId;
    return Object.keys(o).length ? o : undefined;
  }
  private _rigOf(r: Rec): CharacterV2RigState {
    const sk = r.skeleton;
    const j = (this.host.serializeRig ? this.host.serializeRig(sk) : sk.toJSON()) as Record<string, unknown> & { skeletonData?: { joints?: Record<string, unknown>[]; clips?: { name: string }[]; poses?: { name: string }[] } };
    const sd = j.skeletonData;
    if (sd) {
      const assetNames = new Set(r.asset.jointNames);
      // Asset joints: the inverse binds are derived from the sliders (the rest) — not saved.
      sd.joints = (sd.joints ?? []).map((jt) => { if (!assetNames.has(jt.name as string)) return jt; const { inverseBindMatrix: _ibm, ...keep } = jt; return keep; });
      // The UNEDITED default clips / poses rebuild deterministically (installDefaults on load) — not saved. Compared on
      // the LIVE objects (as the engine's v1 strip does): Skeleton3D.toJSON drops a clip's faceTrack.
      const dc = new Map(buildDefaultClips(sk.data.joints).map((c) => [c.name, c] as const));
      const dp = new Map(buildDefaultPoses(sk.data.joints).map((p) => [p.name, p] as const));
      const dropC = new Set((sk.data.clips ?? []).filter((c) => { const d = dc.get(c.name); return !!d && eqNoId(c, d); }).map((c) => c.id));
      const dropP = new Set((sk.data.poses ?? []).filter((p) => { const d = dp.get(p.name); return !!d && eqNoId(p, d); }).map((p) => p.id));
      if (sd.clips) sd.clips = sd.clips.filter((c) => !dropC.has((c as { id?: string }).id ?? ''));
      if (sd.poses) sd.poses = sd.poses.filter((p) => !dropP.has((p as { id?: string }).id ?? ''));
    }
    return { skeleton: j, rest: Array.from(r.rest) };
  }

  /** One undo step per slider gesture: consecutive changes of the same slider set on the same character (nothing else
   *  undoable in between) update the step instead of stacking 60 of them per drag. */
  private _pushSliderUndo(r: Rec, before: BodyV2Sliders): void {
    if (!this.host.pushUndo) return;
    const after = { ...r.sliders };
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => before[k as BodyV2SliderName] !== after[k as BodyV2SliderName]).sort().join(',');
    const last = this._lastUndo;
    if (last && last.rec === r && last.keys === keys && this.host.undoTop?.() === last.desc) { last.after = after; return; }
    // The description is unique per step (an invisible suffix) so "is my step still the top one" is exact.
    const entry = { rec: r, keys, desc: `Character slider ${keys}​${(++this._undoSeq).toString(36)}`, before, after };
    this.host.pushUndo({
      description: entry.desc,
      undo: () => { this._lastUndo = null; this._setSliderState(entry.rec, entry.before); },
      redo: () => { this._lastUndo = null; this._setSliderState(entry.rec, entry.after); },
    });
    this._lastUndo = entry;
  }
  private _setSliderState(r: Rec, s: BodyV2Sliders): void {
    if (this._recs.get(r.mesh.id) !== r) return;
    r.sliders = { ...s };
    this._applyShape(r);
  }
}
