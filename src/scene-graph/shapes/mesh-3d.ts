/**
 * Mesh3D — 3D mesh scene graph node.
 *
 * Extends the existing Shape base class so it participates in the same
 * scene graph, transforms, selection, and serialization as 2D shapes.
 * But it carries 3D vertex data (position + normal + uv) and a Material3D.
 *
 * Rendering is handled by the 3D pipeline (Pipeline3D), NOT the 2D shape pipeline.
 * The 2D renderer skips Mesh3D nodes; the 3D renderer picks them up.
 */

import { Shape } from './base/shape';
import { InteractionService } from '../../services/interaction-service';
import { Material3D, DEFAULT_MATERIAL, dropRemovedMaterialFields, withoutRemovedMaterialFields } from '../../renderer/3d/material-3d';
import { MeshGeometry, FLOATS_PER_VERT, generateBox, generateSphere, generatePlane, generateCylinder, generateTorus, generateRevolve, generateTube, generateSprite, computeTangents } from '../../renderer/3d/mesh-generators';
import { generateSdfMesh, type SdfBlob } from './sdf-mesh';
import { Modifier, applyModifiers } from './modifiers';
import { RGBA } from '../../types/rgba';
import type { Vec2 } from '../../types/interaction';
import type { Mesh3DKeyframeTracks } from '../../types/keyframe-3d';
import type { EditMesh } from './edit-mesh';

/**
 * A submesh occupies a contiguous index range within the parent mesh's
 * shared geometry and carries its own material, enabling multi-material
 * rendering (one GPU draw call per submesh).
 *
 * `indexOffset` and `indexCount` are element (not byte) offsets into
 * `mesh.geometry.indices`. The submesh's material overrides the mesh-level
 * material for its draw call; the mesh-level material is used for any
 * indices not covered by a submesh.
 */
export interface Submesh3D {
  /** Optional label shown in the material-slot panel (e.g. "Body", "Glass"). */
  label?: string;
  /** Element offset into geometry.indices where this submesh starts (0-based). */
  indexOffset: number;
  /** Number of indices in this submesh. */
  indexCount: number;
  /** Per-submesh material; overrides the mesh-level material for this draw call. */
  material: Material3D;
  /** TextureLibrary ID for the submesh diffuse texture (atlas-mode only). */
  textureLibraryId?: string | null;
  /** TextureLibrary ID for the submesh normal map (atlas-mode only). */
  normalMapLibraryId?: string | null;
}

export type MeshPrimitive = 'box' | 'sphere' | 'plane' | 'cylinder' | 'torus' | 'revolve' | 'tube' | 'metaball' | 'sprite' | 'custom';

/**
 * A blend shape (morph target) stores per-vertex position + normal deltas.
 * deltaVertices layout: 6 floats per vertex — dX, dY, dZ, dNX, dNY, dNZ.
 * Applied on top of baseVertices: finalPos = base + Σ(weight[i] × delta[i]).
 */
export interface BlendShape {
  name: string;
  deltaVertices: Float32Array;
}

export interface Mesh3DConfig {
  primitive?: MeshPrimitive;
  /** Box/plane dimensions. */
  width?: number;
  height?: number;
  depth?: number;
  /** Sphere/cylinder radius. */
  radius?: number;
  /** Cylinder top radius (defaults to radius). */
  radiusTop?: number;
  /** Tesselation. */
  widthSegments?: number;
  heightSegments?: number;
  radialSegments?: number;
  tubularSegments?: number;
  /** Torus tube radius. */
  tubeRadius?: number;
  /** Revolve profile: ordered [radius, y] silhouette points (bottom→top), spun around the Y axis. */
  profile?: [number, number][];
  /** Tube path: the [x,y,z] spine the cross-section is swept along. */
  path?: [number, number, number][];
  /** Tube radius at each path point (padded/clamped to the path length; single value = constant). */
  radii?: number[];
  /** Metaball SDF blobs (spheres/capsules/… that smoothly fuse into an organic surface). */
  blobs?: SdfBlob[];
  /** Metaball polygonization grid resolution (cells per axis; clamped 8..96). */
  resolution?: number;
  /** Metaball QEM decimation: keep this fraction of triangles (0..1). Undefined/≥1 = no decimation. Persisted. */
  decimate?: number;
  /** CINEMATIC CAMERA (docs/specs/cinematic-cameras.md): mark this node as a placeable camera. It's a normal
   *  mesh (a small placeholder marker) whose TRANSFORM defines the camera pose; the system treats it specially
   *  (frustum, look-through, excluded from export). Persisted. */
  isCamera?: boolean;
  cameraSettings?: import('../camera-math').CameraSettings;
  /** Custom geometry (overrides primitive). */
  geometry?: MeshGeometry;
  /** Material. */
  material?: Partial<Material3D>;
  /** When true the sprite's model matrix is rebuilt each frame to face the camera. */
  billboard?: boolean;
}

export class Mesh3D extends Shape {
  /** Step 2: bumped whenever ANY mesh's source or modifier geometry is replaced / invalidated (setGeometry, a
   *  primitive rebuild, invalidateModifierCache). Caches of per-mesh geometry figures (the stats HUD's scene totals)
   *  key on it together with the scene structure version. */
  static geometryEpoch = 0;
  /** P16: bumped with geometryEpoch, for THIS mesh only (the Play collision snapshot trusts a member's footprint while
   *  its own geometry version is unchanged, instead of re-reading every member whenever any mesh got geometry). */
  geometryVersion = 0;
  /** @internal Renderer3D pipeline-prewarm bookkeeping (step 2): the prewarm generation that classified this mesh and
   *  its material variant bits. setMaterial resets it. Not scene state. */
  _pwGen = 0;
  /** @internal See _pwGen. */
  _pwCode = 0;
  private _meshPrimitive: MeshPrimitive;
  private _geometry!: MeshGeometry;
  /** Cached modifier-evaluated geometry. Null when stale; recomputed on first geometry access. */
  private _modifiedGeom: MeshGeometry | null = null;
  private _material: Material3D;
  private _meshConfig: Mesh3DConfig;

  /** Modifier stack applied on top of source geometry before GPU upload. */
  public modifiers: Modifier[] = [];

  /** Eight world-space corners of the oriented bounding box (OBB), bit-indexed:
   *  bit0=X, bit1=Y, bit2=Z  (0=min, 1=max).  Updated on every transform change. */
  private _obbCorners: [number, number, number][] | null = null;
  /** Same 8 corners in object (geometry) space — constant once geometry is set. */
  private _obbLocalCorners: [number, number, number][] | null = null;
  /** The geometry object the cached local corners were computed from (cheapBounds cache key). */
  private _obbGeomRef: object | null = null;
  /** PERF opt-in for meshes that move EVERY FRAME (city traffic movers): reuse the cached object-space
   *  AABB instead of re-scanning every geometry vertex on each transform change. The world-space OBB stays
   *  exact (the 8 cached corners are still re-transformed); only the O(verts) scan is skipped. The cache is
   *  keyed on the geometry object reference, so replacing geometry still triggers a fresh scan — but IN-PLACE
   *  vertex mutation will not, which is why this stays opt-in rather than the default. */
  public cheapBounds = false;
  /** P6 (performance-plan.md): RENDERER-PRIVATE slot — the renderer's world-AABB cache entry for this mesh, held here
   *  so the per-frame cull skips a map lookup. Owned and validated by Renderer3D (never read it elsewhere). */
  public _r3Aabb: unknown = null;
  /** P11 (performance-plan.md): RENDERER-PRIVATE — whether this mesh's name matches the occluder pattern, cached per
   *  pattern object (Renderer3D._beginOcclusion). */
  public _r3Occl: RegExp | null = null;
  public _r3IsOccl = false;
  /** P11: RENDERER-PRIVATE — the sub-mesh cull-range cache (renderer/3d/cull-ranges.ts), owned by Renderer3D. */
  public _r3Ranges: unknown = null;
  /** P9 (performance-plan.md): RENDERER-PRIVATE — the hierarchical cull cluster this mesh belongs to and the matrix
   *  version it joined with (renderer/3d/cull-clusters.ts). Owned and validated by Renderer3D. */
  public _hcC: import('../../renderer/3d/cull-clusters').CullCluster | null = null;
  public _hcVer = -1;
  public _hcTris = 0;
  public _hcB = -1;
  /** P9: renderer-private copies of this mesh's geometry-pool allocation and instance slot, valid while `_r3o` is
   *  that renderer and `_r3g` its map generation (saves two string-keyed Map lookups per mesh per frame). */
  public _r3o: unknown = null;
  public _r3g = -1;
  public _r3GA: unknown = undefined;
  public _r3Slot = -1;
  /** P9: renderer-private frame stamp of the last full draw-list visit (a twin re-seeds its swap state after a gap). */
  public _hcSeen = -1;
  /** P15 (renderer/3d/gpu-scene.ts): RENDERER-PRIVATE — this mesh's GPU-driven main-pass record (owner, index) and the
   *  frame stamps of the last draw-list visit / of the CPU path's "drawn" verdict (forced records). */
  public _gdOwner: unknown = null;
  public _gdRec = -1;
  public _gdSeen = -1;
  public _gdVis = -1;
  public _gdCand = -1;
  public _gdMatF = -1;
  public _gdTaken = -1;
  public _gdGStamp = -1;
  public _gdGList: unknown[] | null = null;
  /** P15: the values the record was last written from (compared in the draw-list loop while this mesh is cache-hot). */
  public _gdKA: unknown = undefined;
  public _gdKS = -2;
  public _gdKM = -1;
  public _gdKD = NaN;
  public _gdKB = NaN;
  public _gdKF = false;
  /** P15 Phase B: the twin parameters the record was written from (role, distances, flags) + the frame stamp of the
   *  last visit past the hierarchical cull (seeds a new record's GD_CTL_VISITED). */
  public _gdKR = 0;
  public _gdKT = 0;
  public _gdKT2 = 0;
  public _gdKX = 0;
  public _gdVisit = -1;
  /** P15 Phase C: the shadowFeatureSize the record was written with. */
  public _gdKSh = NaN;
  /** P15 sub-bundles: the spatial cell the draw rank placed this mesh in (Renderer3D.rankCellM; 0 = none). */
  public _r3RankCell = 0;
  /** Step 8 (renderer/3d/shader-variants.ts): RENDERER-PRIVATE — the shader-variant key read back from this mesh's
   *  instance slot at its last write (the exact material flags, or -1 = the uber-shader). */
  public _r3VF = -1;
  /** Shader split (renderer/3d/mesh-fs-pipelines.ts): RENDERER-PRIVATE — the packed phase-1 fragment-shader key read
   *  back from this mesh's instance slot at its last write (shaders/mesh-fs-key.ts meshFsPhase1Num; -1 = not covered). */
  public _r3FK = -1;
  /** Ray-pickable? Set false for pure DECORATION that is never individually selected (the whole procedural
   *  city — buildings/props/movers). The picker skips these BEFORE the expensive per-mesh BVH build, so hover/
   *  click over a ~700-mesh city costs nothing (previously each pick rebuilt every mesh's BVH after a regen —
   *  smooth on a warm-cache fresh city, but a heavy stall on mouse-move right after any topology change). */
  public pickable = true;
  /** Skip this mesh when auto-framing the camera (frameAllMeshes). Set for FAR decoration that shouldn't drag
   *  the view out — the void grid / border glow / terrain apron extend well past the city but must not shrink it. */
  public frameExclude = false;
  /** Skip this mesh when SERIALIZING the document (getScene3DNodeStates). Set for PROCEDURAL content (the whole
   *  city) that regenerates from world params on load — persisting its baked geometry is waste AND the per-mesh
   *  toJSON over thousands of them is a periodic autosave FREEZE. Same principle as params-only characters. */
  public excludeFromDocument = false;
  /** When this mesh is the SOURCE of an ArrayGroup, let its instances cast shadows and feed the outline
   *  pass. Instanced draws are excluded from those passes by default because the original instanced
   *  content was centimetre-scale building trim, where the cost (thousands of extra instances redrawn into
   *  the shadow map) buys nothing visible. Set it for instanced content big enough to read — the city's
   *  trees, which otherwise cast no shadow at all. */
  public castsInstancedShadow = false;
  /** PROCEDURAL-GROUND uv-scale sample (world/chunking.ts): when a city ground layer is split into spatial chunks,
   *  every chunk carries the UNSPLIT layer's sample triangles here, and the renderer derives the world-units-per-uv
   *  from them instead of from this mesh's own geometry — so all chunks get the identical scale (no seam). Runtime
   *  only (city meshes are never serialized). */
  public groundUvSample: MeshGeometry | null = null;
  /** DISTANCE LOD (polish-round-3 R6.1): world-unit distance from the CAMERA to this mesh's world AABB (for an
   *  ArrayGroup source: to the group's box) past which the renderer stops drawing it — main pass and shadow alike.
   *  0 = no limit. Hysteretic: hides past `drawDistance`, shows again inside 0.9 × it (`lodHidden` holds the state).
   *  Perspective only (an ortho camera's distance is not its zoom). Set by the city on its fine-detail layers;
   *  runtime only (never serialized). */
  public drawDistance = 0;
  /** P7: fraction (0..1) of the renderer's AERIAL bias (`Renderer3D.distanceLodBias`, the camera's distance to the
   *  city volume) added to `drawDistance`. 1 = the R6.1 rule (aerial overviews keep this detail: facade texture,
   *  trees); 0 = plain camera distance (sub-metre clutter — crowds, cans, sign lettering, wires, small street
   *  furniture — is only a pixel or two from the air, so it drops by true distance there too). Street level is
   *  unaffected (the bias is ~0 there). Runtime only (never serialized). */
  public drawDistanceBias = 1;
  /** Renderer-owned hysteresis state for `drawDistance` (true = currently beyond it, not drawn). */
  public lodHidden = false;
  /** E2 NEAR/FAR TWIN role (persona-polish-plan.md E2): 0 = none · 1 = NEAR twin (drawn only while the camera is
   *  within `lodTwinDist` of this mesh's box — the chipped edges) · 2 = FAR twin (drawn otherwise — the clean piece).
   *  Both twins of a chunk share the same box, the same threshold and the same hysteresis rule, so exactly one of them
   *  draws. Distance LOD off / ortho → far twins only. Runtime only (never serialized).
   *  P9 three-tier families (the static crowd): 3 = MID (drawn between `lodTwinDist` and `lodTwinDist2`; also the
   *  one drawn with distance LOD off) · 4 = XFAR (drawn past `lodTwinDist2`; never with distance LOD off). */
  public lodTwinRole: 0 | 1 | 2 | 3 | 4 = 0;
  /** E2: twin threshold in world units (scaled by the renderer's lens / quality scale, not by the aerial bias). */
  public lodTwinDist = 0;
  /** Renderer-owned E2 twin hysteresis state: true = the camera is currently NEAR (near twin drawn, far twin hidden). */
  public lodTwinNear = false;
  /** P8: this twin is the SOURCE (instance 0) of an instanced twin pair — the far tree crowns (Renderer3D.groupTwins
   *  switches it with its ArrayGroup). Runtime only. */
  public lodTwinInstanced = false;
  /** P9: the second threshold of a three-tier family (roles 3 / 4), world units. */
  public lodTwinDist2 = 0;
  /** Renderer-owned P9 hysteresis state for `lodTwinDist2`: true = the camera is within it (mid drawn, xfar hidden). */
  public lodTwinNear2 = true;
  /** P9: the FAR twin is a degraded copy of the near one (the prop far twins), so distance LOD off draws the NEAR
   *  twin instead (the pre-twin look). */
  public lodTwinOffNear = false;
  /** P12 EXTERNALLY DRIVEN twin (the instanced crowd, world-crowd.ts): the owner writes `lodTwinNear` / `lodTwinNear2`
   *  itself (it knows which tier of a cell is resident); the renderer only applies them (twinDraws) — it never updates,
   *  re-seeds or LOD-off-resets them. On an ArrayGroup source it drives the whole group. Runtime only. */
  public lodTwinExternal = false;
  /** P12: this mesh exists only as an ArrayGroup SOURCE (the instanced crowd's per-cell variant groups — every person is
   *  a copy): it owns the group's instance slot + material but is never drawn itself (no camera / shadow / outline list),
   *  never collided with. Runtime only. */
  public arraySourceOnly = false;
  /** VISUAL ONLY (rise bug 2026-10-04): never Play collision — not ground, not a wall, not a camera obstacle. For
   *  overlays drawn on / above real surfaces: contact-shadow blobs, light pools, decals, particles. A radialFade
   *  material counts as visual-only too (isVisualOnlyMesh). The player's moving contact blob was collided with: the
   *  ground ray stood the feet on it, the blob followed the feet up, and the player rose forever. Runtime only. */
  public noCollide = false;
  /** P8 SHADOW LOD: the size (world units) of this mesh's smallest shadow-relevant feature — a pole's width, a
   *  person's footprint. A shadow map whose texel is coarser than `Renderer3D.SHADOW_LOD_TEXELS` × this cannot resolve
   *  the shadow, so the renderer leaves the mesh out of that map's caster list (the far map and each near cascade
   *  separately). 0 = always cast. Set by the city's distance tiers; runtime only (never serialized). */
  public shadowFeatureSize = 0;
  /** FOG HORIZON class (docs/specs/fog-horizon.md; stamped by the city from its distance tiers): 0 = building shell or
   *  anything untiered (always drawn) · 1 = building attachment (signs, awnings, facade trim, rooftop equipment) ·
   *  2 = everything else (props, trees, cars, crowd, street furniture, paving). With "Buildings only in fog" on (and
   *  Hard edge + linear fog) classes 2 and, unless attachments are included, 1 stop drawing past the fog's Far.
   *  Runtime only (never serialized). */
  public fogClass: 0 | 1 | 2 = 0;
  /** Step 3 (fog class 'overlay'): a class-2 mesh that is CULLED past the fog's Far like any class 2 but does NOT
   *  dissolve over the fade band (road paint, road wear, gutters, storefronts: they lie on a building-class surface that
   *  fogs normally, so they keep its look up to Far, where both are pure fog colour). Runtime only. */
  public fogNoFade = false;
  /** Renderer-owned: true while the fog-horizon CPU cull drops this mesh (its whole box past the fog's Far; updated
   *  whenever the draw-list build reaches the fog test, like `lodHidden`). Read by CPU work that only matters for a
   *  drawn mesh (the walkers' pose gate). Runtime only (never serialized). */
  public fogHidden = false;
  /** Play third-person camera occluder override (src/game/camera-occluders.ts): 'block' = a HARD occluder (the camera
   *  pulls in in front of it, like a wall), 'ignore' = SOFT (the camera passes through it, like a lamp post), 'auto' =
   *  the rules (city family / fog class / size: large = hard, small or thin = soft). Serialized when not 'auto'. */
  public cameraBlock: 'auto' | 'block' | 'ignore' = 'auto';
  /** P17 HLOD cross-fade (material-3d.ts flags2 bit 5): the screen-door coverage 0..1 while a streamed HLOD tile
   *  dissolves in / out over its tier swap; -1 = not fading (drawn whole). Set by the city each frame of a fade (with
   *  materialDirty: the slot rewrite carries it). Runtime only (never serialized). */
  public hlodFade = -1;

  // GPU buffer handles (set by the 3D renderer when uploading)
  public gpuVertexBuffer: GPUBuffer | null = null;
  public gpuIndexBuffer: GPUBuffer | null = null;
  public gpuDirty = true;
  /** MATERIAL-ONLY change (colour/emissive/roughness/pattern params): repack this mesh's instance slot next
   *  frame WITHOUT the geometry-pool + texture-atlas rebuilds that `gpuDirty` implies. The city's night-glow
   *  walk touches every mesh's material — flagging that as gpuDirty re-uploaded the whole city's geometry. */
  public materialDirty = false;

  /**
   * True when any save-relevant property has changed since the last cloud/file save.
   * Set by material and geometry setters; cleared by Scene3DManager after a successful save.
   * Starts true so newly created meshes are always included in the first save.
   * NOT set by transform changes during animation playback — only by explicit user edits
   * routed through Scene3DManager (gizmo drags, keyframe ops, cloth config changes, etc.).
   *
   * An accessor (not a plain field) so every `= true` also bumps {@link stateVersion}: a save snapshots
   * (id, version) and afterwards clears ONLY meshes whose version didn't move — an edit that lands while the
   * async write is in flight stays dirty and is saved next time (audit 2026-09-28 P5).
   */
  get stateDirty(): boolean { return this._stateDirty; }
  set stateDirty(v: boolean) {
    if (v) this._stateVersion = (this._stateVersion | 0) + 1;
    this._stateDirty = v;
  }
  /** Monotonic count of `stateDirty = true` writes — the save race guard (see stateDirty). */
  get stateVersion(): number { return this._stateVersion; }
  private _stateDirty = true;
  private _stateVersion = 0;

  /**
   * True when this mesh came from the procedural body generator (createProceduralBody3D). It ships
   * pre-rigged with the generator's tube weights, so UI should NOT offer to (re)bind it — auto-bind
   * would replace those weights with distance-based ones. Surfaced via getAllMeshes3D() so the
   * armature panel can hide "Bind Mesh" for procedural bodies. (Skeleton3D carries the same flag.)
   */
  public isProceduralBody = false;

  /** True for the anime "face decal" quad (eye/expression overlay skinned to the head joint). */
  public isFaceDecal = false;

  /** FACE KIT (face-features.ts): a face-features overlay (brows / mouth / nose / blush / hair shadow). Also
   *  isFaceDecal (same persistence + style exclusions). The renderer draws it AFTER the opaque skinned parts with a
   *  MULTIPLY blend (its texture is a premultiplied multiplier over the lit skin), no depth write, no shadow. */
  public isFaceFeatures = false;
  /** FACE KIT: pull this mesh's depth toward the camera by this many LOCAL units in the skinned VS (flags2 bit 6,
   *  instance float 30) — the screen position is unchanged, so brows draw through the hair fringe in front of them
   *  but not through anything further away. 0 = off (every other mesh). */
  public faceDepthPull = 0;

  /** True for a procedural hair mesh (skinned to the head joint; rebuilt from HairParams). */
  public isHair = false;

  /** True for a procedural garment (top/bottom) skinned to the body's skeleton; rebuilt from params. */
  public isClothing = false;

  /** True for a procedural charm/accessory (chain/pocket/pendant) skinned to a body joint; rebuilt from params. */
  public isAttachment = false;

  /** When true, this skinned mesh's OBJECT transform lives on its skeleton (Skeleton3D.objectTransform),
   *  so the renderer uses an IDENTITY model matrix — applying localMatrix too would double-transform.
   *  Set on procedural-character meshes so the whole character (meshes + bones) moves as one via the
   *  skeleton. See docs/specs/character-transform-on-skeleton.md. */
  public transformViaSkeleton = false;

  // Optional: diffuse texture
  public diffuseTexture: GPUTexture | null = null;

  // Optional: normal map texture (enables per-pixel Phong lighting)
  public normalMapTexture: GPUTexture | null = null;

  // ── Mesh painting ────────────────────────────────────────────────────────────

  /**
   * GPU texture for the paint layer. Created by MeshPaintManager on first
   * paint; null until the user enters mesh-paint mode on this mesh.
   */
  public paintTexture: GPUTexture | null = null;

  /**
   * CPU-side RGBA8 buffer backing paintTexture. Same dimensions as the GPU
   * texture (paintTexSize × paintTexSize × 4 bytes). MeshPaintManager writes
   * brush dabs here then uploads dirty rects via writeTexture.
   */
  public paintBuffer: Uint8Array | null = null;

  /**
   * Edge length of the square paint texture in texels.
   * 0 means no paint texture has been allocated yet.
   */
  public paintTexSize = 0;

  /** Per-property keyframe tracks for 3D animation. */
  public keyframeTracks: Mesh3DKeyframeTracks = {};

  /**
   * Multi-material submesh slots. When non-empty the mesh-level `material` is
   * ignored; each submesh drives its own GPU draw call with its own material.
   * Each submesh covers a contiguous index range within the shared geometry.
   */
  public submeshes: Submesh3D[] = [];

  /** ID of the texture entry in the TextureLibrary (if using the library). */
  public textureLibraryId: string | null = null;

  /** ID of the normal map entry in the TextureLibrary (if using the library). */
  public normalMapLibraryId: string | null = null;

  /** Persistent per-object OUTLINE style (user-assigned; null = no outline). Shape matches the renderer's
   *  HighlightStyle (color/width/patternMode/patternColor/freq/speed/glow + thicknessPx). Serialized here; the
   *  renderer's runtime outline cache is mirrored from this by Scene3DManager on set + restore. */
  public outline: import('../../renderer/3d/mesh-highlight-pass').HighlightStyle | null = null;
  /** Extra outline RINGS stacked OUTSIDE `outline`, inner → outer (e.g. a red outline, then a white ring around it).
   *  Each ring's `width` is ITS OWN band thickness (added onto everything inside it). Drawn only while `outline` is
   *  set; null/empty = a single outline (the original behaviour). Persisted with the mesh. */
  public outlineRings: import('../../renderer/3d/mesh-highlight-pass').HighlightStyle[] | null = null;

  /** GARP (docs/specs/city-props-garp.md §2): when set (and material.garpTex is true), this mesh's per-instance
   *  textureIndex is forced to this DEDICATED-GARP-atlas layer instead of the diffuse-atlas lookup. Session-local
   *  (a GARP atlas layer index — NEVER serialise it; resolve from the pool's skin each session). */
  public garpLayer?: number;

  /**
   * Index of this mesh within the source GLB's parsed mesh array.
   * Set by Scene3DManager on import; serialized so texture restore can use
   * index-based lookup instead of name-based (names are often all 'defaultMaterial').
   */
  public glbMeshIndex: number | null = null;

  /** EditMesh authoring structure. Present when this mesh was created via makeEditable(). */
  public editMesh: EditMesh | null = null;

  /**
   * Forces a specific geometry pool key for this mesh, overriding the default derived key.
   * Used by ArrayGroup3D copies to share the source mesh's pool slot: all copies and the
   * source are assigned "array-src:{sourceId}" so they draw from a single VB/IB upload.
   * Set to null to revert to the normal key.
   */
  private _geometryKeyOverride: string | null = null;
  /** P6: memo of `custom:${id}` for geometryKey (re-derived if the id ever changes). */
  private _customKeyId: string | null = null;
  private _customKey = '';

  /**
   * Per-vertex RGBA color data compiled from editMesh. Populated by syncFromEditMesh();
   * null for non-edit meshes. The renderer uploads this to a second vertex buffer slot
   * and switches to the vertex-color pipeline variant.
   */
  public vertexColors: Float32Array | null = null;

  /** When true the renderer overwrites the model matrix each frame so the mesh faces the camera. */
  public billboard: boolean = false;

  /** When true the mesh draws LAST with depthCompare 'always' — never occluded (the landmark info card / overlays). */
  public alwaysOnTop: boolean = false;

  /** Extra rotation (radians) about the billboard's local UP axis, applied on top of the face-camera basis. 0 = a
   *  normal billboard. Used for the info-card intro "spin-in" that decays to 0 → settles perfectly flat-on/readable.
   *  Only consulted when `billboard` is true. */
  public billboardSpinY: number = 0;

  /** Billboard-OVERLAY child: the mesh whose billboard basis this mesh rides on (e.g. the info-card's header pill
   *  riding the card). When set, the renderer IGNORES this mesh's own transform and positions it as
   *  parentBillboard × translate(billboardOffset) — so it faces the camera, spins, and grows in lockstep with the
   *  parent while sitting at a fixed offset in the parent's local frame (and may overhang the parent). */
  public billboardParent: Mesh3D | null = null;
  /** Offset (in the parent's local frame, world units at scale 1) for a billboard-overlay child — see billboardParent. */
  public billboardOffset: [number, number, number] = [0, 0, 0];

  /** Extra uniform scale for a BILLBOARD (or the parent a billboard-child rides), multiplied into the face-camera
   *  basis. 1 = normal. Used for the info-card "grow" intro WITHOUT touching localMatrix — so the animation can be
   *  pushed to just this mesh's instance slot (refreshBillboards) instead of dirtying it into a full instance repack. */
  public billboardScale: number = 1;

  // ── Blend shapes (morph targets) ────────────────────────────────────────────

  /** All blend shapes attached to this mesh. */
  public blendShapes: BlendShape[] = [];
  /** Per-shape blend weights (parallel to blendShapes). Values in 0–1 range. */
  public blendWeights: Float32Array = new Float32Array(0);
  /**
   * Snapshot of _geometry.vertices taken when the first blend shape is added.
   * evaluateBlendShapes() always starts from this bind-pose snapshot so weights
   * are independent of each other and evaluation is idempotent.
   */
  public baseVertices: Float32Array | null = null;
  /**
   * Bumped on EVERY blend-shape evaluation (evaluateBlendShapes / applyBlendWeights). Consumers that mirror the morphed
   * vertices key on it: the renderer re-sends a skinned part's dirty vertex range when it differs from the version it
   * uploaded (no buffer re-creation, no index upload), and the picker / skinned cull radii re-derive lazily.
   */
  public blendVersion = 0;
  /** @internal Dirty vertex range [lo, hi) of the last 8 blend versions (slot (v & 7) * 2). See blendRangeSince. */
  public readonly _blendRangeLog = new Int32Array(16);
  /** Incremental-evaluation state: the weights currently baked into _geometry.vertices, and the identities they
   *  were baked against (base snapshot, vertex array, delta arrays). Any mismatch falls back to a full evaluation. */
  private _bsApplied: Float32Array | null = null;
  private _bsDeltas: Float32Array[] = [];
  private _bsBase: Float32Array | null = null;
  private _bsOut: Float32Array | null = null;
  private _bsIncCount = 0;

  /** A/B switch (Character v2 Phase 1.5). true = the fast path: a weight change through the blend-shape API applies
   *  only the CHANGED shapes' deltas over their sparse vertex support and the renderer updates the existing GPU
   *  buffers in place over the dirty range. false = the old path: a full CPU evaluation + skinDirty (a skinned part
   *  rebuilt and re-created its VB + IB) / gpuDirty (a static mesh rebuilt the whole geometry pool). */
  static blendFastPath = true;
  /** Incremental updates accumulate float rounding; after this many a full evaluation from the base re-anchors. */
  static BLEND_REBASE_EVERY = 64;
  /** The weight range the blend-shape API clamps to. [0, 1] by default (backward compatible); a host may widen it
   *  (e.g. [-1, 2] for over-driven sliders). A min / max shape pair stays the recommended slider pattern. */
  static blendWeightMin = 0;
  static blendWeightMax = 1;

  constructor(
    interactionService: InteractionService,
    x: number, y: number, z: number,
    config: Mesh3DConfig = {},
  ) {
    const defaultColor: RGBA = { r: 0.8, g: 0.8, b: 0.8, a: 1 };
    super(defaultColor, defaultColor, 1, interactionService);
    this._x = x;
    this._y = y;
    this._z = z;
    this._name = 'Mesh3D';
    this._meshPrimitive = config.primitive ?? 'box';
    this._meshConfig = { ...config };
    // dropRemovedMaterialFields: an old save's sparkleEnabled / sparkleStar (removed 2026-10-07) are ignored.
    this._material = dropRemovedMaterialFields({ ...DEFAULT_MATERIAL, ...config.material });
    this.billboard = config.billboard ?? false;

    if (config.geometry) {
      // Route through setGeometry so the FORMAT is normalized ('8float' → computeTangents → 12-float).
      // Assigning raw here left 8-float geometry in a renderer that assumes 12-float stride — positions/
      // normals/UVs misaligned → garbled triangles (caught by box-hierarchy.nodes.test.ts: a 4-corner
      // panel read back as "3 vertices"). setGeometry also keeps _meshConfig in sync.
      this.setGeometry(config.geometry);
      this._meshPrimitive = 'custom';
    } else {
      this.rebuildGeometry();
    }

    // Recompute localMatrix with the actual x/y/z — super() ran updateLocalMatrix()
    // before _x/_y/_z were set (direct assignment bypasses setters), so we fix it here.
    this.updateLocalMatrix();
  }

  // ── Getters ────────────────────────────────────────────────────

  get meshPrimitive(): MeshPrimitive { return this._meshPrimitive; }
  /** A sprite's quad size [width, height] (model units), or null for any other primitive. */
  get spriteSize(): [number, number] | null {
    return this._meshPrimitive === 'sprite' ? [this._meshConfig.width ?? 1, this._meshConfig.height ?? 1] : null;
  }

  /** CINEMATIC CAMERA: this node is a placeable camera (its transform = the camera pose). See cinematic-cameras.md. */
  get isCamera(): boolean { return this._meshConfig.isCamera === true; }
  get cameraSettings(): import('../camera-math').CameraSettings | undefined { return this._meshConfig.cameraSettings; }
  setCameraSettings(s: import('../camera-math').CameraSettings): void { this._meshConfig.cameraSettings = { ...s }; this.stateDirty = true; }

  /** Returns modifier-evaluated geometry when modifiers are present; raw source geometry otherwise. */
  get geometry(): MeshGeometry {
    if (this.modifiers?.length > 0) {
      if (!this._modifiedGeom) this._modifiedGeom = applyModifiers(this._geometry, this.modifiers);
      return this._modifiedGeom;
    }
    return this._geometry;
  }

  get material(): Material3D { return this._material; }
  get vertexCount(): number { return this._geometry.vertices.length / FLOATS_PER_VERT; }
  get indexCount(): number { return this._geometry.indices.length; }
  get triangleCount(): number { return this._geometry.indices.length / 3; }
  /** Eight world-space OBB corners (bit-indexed: bit0=X, bit1=Y, bit2=Z; 0=min,1=max). */
  get obbCorners(): [number, number, number][] | null { if (this._bbStale) this.calculateBoundingBox(); return this._obbCorners; }
  /** cheapBounds meshes defer the per-transform bounds refresh until something READS the bounds (see
   *  updateLocalMatrix) — city movers are re-posed every frame, but their OBB / 2D box is almost never read. */
  private _bbStale = false;
  override get boundingBox() { if (this._bbStale) this.calculateBoundingBox(); return this._boundingBox; }
  override set boundingBox(value: { x: number; y: number; width: number; height: number; vertices?: [number, number][] }) { this._bbStale = false; this._boundingBox = value; }
  /** Same corners in object (geometry) space — unaffected by transform. */
  get obbLocalCorners(): [number, number, number][] | null { return this._obbLocalCorners; }

  /**
   * Stable string key that identifies the geometry produced by this mesh's current
   * primitive type and generation parameters. Two meshes with the same key produce
   * byte-for-byte identical vertex/index data and can share one pool slot.
   *
   * Custom/imported meshes always return a unique key (their mesh ID) so they are
   * never deduplicated — their geometry is unknown to the pool.
   */
  setGeometryKeyOverride(key: string | null): void {
    this._geometryKeyOverride = key;
    this.gpuDirty = true;
  }

  /**
   * ★ A PARENT moved ⇒ this mesh's WORLD matrix changed, so its instance slot is stale.
   *
   * The base implementation only drops the cached parent-chain matrix; `localMatrixVersion` stayed put, and the
   * renderer's per-mesh "did it move?" test (and the array-group source-moved test) is exactly that version — so
   * a mesh parented under a moved node kept STALE model matrices until something forced a full repack. That is
   * what lets ground scatter be parented to its ground mesh and follow it automatically.
   */
  public override markParentChainDirty(): void {
    super.markParentChainDirty();
    this.bumpMatrixVersion();
  }

  /** Invalidate the modifier-evaluated geometry cache. Call after changing modifiers or source geometry. */
  invalidateModifierCache(): void {
    Mesh3D.geometryEpoch++; this.geometryVersion++;
    this._modifiedGeom = null;
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  /**
   * Apply blend shape weights to produce the final deformed geometry.
   * Writes result into _geometry.vertices starting from baseVertices (bind pose),
   * then invalidates the modifier cache and marks gpuDirty.
   * No-op when no blend shapes are attached.
   */
  evaluateBlendShapes(): void {
    if (!this._evaluateBlendFull()) return;
    this.gpuDirty = true;
  }

  /**
   * FAST blend evaluation (Character v2 Phase 1.5): brings _geometry.vertices to base + Σ w·delta like
   * evaluateBlendShapes, but INCREMENTALLY — only shapes whose weight changed since the last evaluation are applied
   * (as (w − wApplied)·delta over the shape's sparse vertex support), and it does NOT set gpuDirty. Returns the dirty
   * vertex range [lo, hi) (null = nothing to do), also logged under the bumped blendVersion for the renderer.
   * Falls back to a full evaluation (from baseVertices) when the base / vertex array / shape list changed since the
   * last evaluation, and every BLEND_REBASE_EVERY incremental updates (bounds float drift; results stay within ~1e-6
   * of the full evaluation). Callers that write _geometry.vertices directly must call evaluateBlendShapes() after.
   * Static meshes: the caller re-sends the range (Renderer3D.patchMeshVertices) or sets gpuDirty itself.
   */
  applyBlendWeights(): [number, number] | null {
    const base = this.baseVertices;
    if (!base) return null;
    const out = this._geometry.vertices, shapes = this.blendShapes, w = this.blendWeights, applied = this._bsApplied;
    let ok = this._bsBase === base && this._bsOut === out && out.length === base.length && applied !== null
      && applied.length === shapes.length && this._bsDeltas.length === shapes.length && this._bsIncCount < Mesh3D.BLEND_REBASE_EVERY;
    for (let si = 0; ok && si < shapes.length; si++) if (this._bsDeltas[si] !== shapes[si].deltaVertices) ok = false;
    if (!ok) {
      if (!this._evaluateBlendFull()) return null;
      return [0, base.length / FLOATS_PER_VERT];
    }
    const nv = base.length / FLOATS_PER_VERT;
    let lo = nv, hi = 0, anyLive = false;
    for (let si = 0; si < shapes.length; si++) { if (effWeight(w[si] ?? 0) !== 0) { anyLive = true; break; } }
    if (!anyLive) {
      // Every weight back at zero: restore the base EXACTLY (no drift) over the union of what was applied.
      for (let si = 0; si < shapes.length; si++) {
        if (applied![si] === 0) continue;
        const sup = blendSupport(shapes[si].deltaVertices, nv);
        if (sup.lo < lo) lo = sup.lo; if (sup.hi > hi) hi = sup.hi;
        applied![si] = 0;
      }
      if (hi <= lo) return null;
      out.set(base.subarray(lo * FLOATS_PER_VERT, hi * FLOATS_PER_VERT), lo * FLOATS_PER_VERT);
      this._bsIncCount = 0;
      return this._noteBlendRange(lo, hi);
    }
    for (let si = 0; si < shapes.length; si++) {
      const wt = effWeight(w[si] ?? 0), dw = wt - applied![si];
      if (dw === 0) continue;
      const delta = shapes[si].deltaVertices, sup = blendSupport(delta, nv), idx = sup.idx;
      for (let k = 0; k < idx.length; k++) {
        const vi = idx[k], o12 = vi * FLOATS_PER_VERT, o6 = vi * 6;
        out[o12]     += dw * delta[o6];
        out[o12 + 1] += dw * delta[o6 + 1];
        out[o12 + 2] += dw * delta[o6 + 2];
        out[o12 + 3] += dw * delta[o6 + 3];
        out[o12 + 4] += dw * delta[o6 + 4];
        out[o12 + 5] += dw * delta[o6 + 5];
      }
      applied![si] = wt;
      if (sup.lo < lo) lo = sup.lo; if (sup.hi > hi) hi = sup.hi;
    }
    if (hi <= lo) return null;
    this._bsIncCount++;
    return this._noteBlendRange(lo, hi);
  }

  /** The union dirty vertex range [lo, hi) of every blend evaluation after version `since` (into `out`), or false
   *  when it is not known (more than 8 versions ago) and the caller must treat the whole mesh as dirty. */
  blendRangeSince(since: number, out: Int32Array | number[]): boolean {
    const v = this.blendVersion;
    if (since >= v) { out[0] = 0; out[1] = 0; return true; }
    if (v - since > 8) return false;
    let lo = 0x7fffffff, hi = 0;
    for (let k = since + 1; k <= v; k++) {
      const s = (k & 7) * 2, a = this._blendRangeLog[s], b = this._blendRangeLog[s + 1];
      if (a < lo) lo = a; if (b > hi) hi = b;
    }
    out[0] = lo; out[1] = Math.max(lo, hi);
    return true;
  }

  /** Forget the cached sparse supports / incremental state: call after editing a shape's deltaVertices IN PLACE
   *  (replacing the array needs nothing). The next evaluation is a full one. */
  invalidateBlendShapeCache(): void {
    for (const s of this.blendShapes) BLEND_SUPPORT.delete(s.deltaVertices);
    this._bsApplied = null;
  }

  /** Full evaluation from baseVertices (the original semantics; bit-identical to the old dense loop — the sparse
   *  support only skips vertices whose 6 deltas are all zero). Returns false when there is no base. */
  private _evaluateBlendFull(): boolean {
    const base = this.baseVertices;
    if (!base) return false;
    const out = this._geometry.vertices;
    const nv = base.length / FLOATS_PER_VERT;
    const shapes = this.blendShapes;
    out.set(base); // restore bind pose
    const applied = new Float32Array(shapes.length);
    for (let si = 0; si < shapes.length; si++) {
      const w = effWeight(this.blendWeights[si] ?? 0);
      applied[si] = w;
      if (w === 0) continue;
      const delta = shapes[si].deltaVertices; // 6 floats per vertex
      const idx = blendSupport(delta, nv).idx;
      for (let k = 0; k < idx.length; k++) {
        const vi = idx[k], o12 = vi * FLOATS_PER_VERT, o6 = vi * 6;
        out[o12]     += w * delta[o6];
        out[o12 + 1] += w * delta[o6 + 1];
        out[o12 + 2] += w * delta[o6 + 2];
        out[o12 + 3] += w * delta[o6 + 3];
        out[o12 + 4] += w * delta[o6 + 4];
        out[o12 + 5] += w * delta[o6 + 5];
      }
    }
    this._bsApplied = applied;
    this._bsDeltas = shapes.map((s) => s.deltaVertices);
    this._bsBase = base;
    this._bsOut = out;
    this._bsIncCount = 0;
    this._noteBlendRange(0, Math.min(nv, out.length / FLOATS_PER_VERT));
    return true;
  }

  private _noteBlendRange(lo: number, hi: number): [number, number] {
    const v = ++this.blendVersion, s = (v & 7) * 2;
    this._blendRangeLog[s] = lo; this._blendRangeLog[s + 1] = hi;
    this._modifiedGeom = null;
    return [lo, hi];
  }

  get geometryKey(): string {
    if (this.modifiers.length > 0) return `modifier:${this.id}`;
    if (this._geometryKeyOverride !== null) return this._geometryKeyOverride;
    if (this._meshPrimitive === 'custom') {
      // P6 (performance-plan.md): cached — the renderer reads this per draw entry per frame (run batching, pool
      // lookups), and the template string was a fresh allocation every time (~80 MB/10 s of garbage in a city).
      const id = this.id;
      if (this._customKeyId !== id) { this._customKeyId = id; this._customKey = `custom:${id}`; }
      return this._customKey;
    }
    const c = this._meshConfig;
    switch (this._meshPrimitive) {
      case 'box':
        return `box:${c.width ?? 1}:${c.height ?? 1}:${c.depth ?? 1}`;
      case 'sphere':
        return `sphere:${c.radius ?? 0.5}:${c.widthSegments ?? 16}:${c.heightSegments ?? 12}`;
      case 'plane':
        return `plane:${c.width ?? 1}:${c.height ?? 1}:${c.widthSegments ?? 1}:${c.heightSegments ?? 1}`;
      case 'sprite':
        return `sprite:${c.width ?? 1}:${c.height ?? 1}`;
      case 'cylinder':
        return `cylinder:${c.radiusTop ?? c.radius ?? 0.5}:${c.radius ?? 0.5}:${c.height ?? 1}:${c.radialSegments ?? 16}`;
      case 'torus':
        return `torus:${c.radius ?? 0.5}:${c.tubeRadius ?? 0.2}:${c.radialSegments ?? 16}:${c.tubularSegments ?? 24}`;
      case 'revolve':
        return `revolve:${c.radialSegments ?? 24}:${(c.profile ?? []).map(p => `${p[0]},${p[1]}`).join(';')}`;
      case 'tube':
        return `tube:${c.radialSegments ?? 12}:${(c.path ?? []).map(p => `${p[0]},${p[1]},${p[2]}`).join(';')}:${(c.radii ?? []).join(',')}`;
      case 'metaball':
        return `metaball:${c.resolution ?? 48}:${c.decimate ?? 0}:${JSON.stringify(c.blobs ?? [])}`;
      default:
        return `custom:${this.id}`;
    }
  }

  // ── Type identification ────────────────────────────────────────

  getType(): string {
    return '3DMesh';
  }

  // ── Material setters ───────────────────────────────────────────

  setDiffuseColor(r: number, g: number, b: number, a = 1): void {
    this._material.diffuse = { r, g, b, a };
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  setSpecularColor(r: number, g: number, b: number, shininess?: number): void {
    this._material.specular = { r, g, b, a: shininess ?? this._material.shininess };
    if (shininess !== undefined) this._material.shininess = shininess;
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  setEmissiveColor(r: number, g: number, b: number): void {
    this._material.emissive = { r, g, b, a: this._material.emissive.a };
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  setShininess(value: number): void {
    this._material.shininess = value;
    this._material.specular.a = value;
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  setOpacity(value: number): void {
    this._material.opacity = value;
    this._material.diffuse.a = value;
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  setMaterial(mat: Partial<Material3D>): void {
    this._pwGen = 0;   // re-classify for the pipeline prewarm
    dropRemovedMaterialFields(Object.assign(this._material, mat));
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  // ── Geometry ───────────────────────────────────────────────────

  setGeometry(geom: MeshGeometry): void {
    if (geom.format === '8float') {
      this._geometry = computeTangents(geom);
    } else if (geom.format === '12float') {
      this._geometry = geom;
    } else {
      // No format tag: infer from stride for backward compat with untagged legacy geometry.
      // Prefer tagging geometry at the source with format: '8float' | '12float'.
      const needsTangents = geom.vertices.length % FLOATS_PER_VERT !== 0 && geom.vertices.length % 8 === 0;
      this._geometry = needsTangents ? computeTangents(geom) : geom;
    }
    // Keep _meshConfig in sync so toJSON() embeds the geometry.
    // This lets cloud/JSON-only save paths restore custom/GLTF meshes
    // without needing a separate GLB buffer.
    this._meshConfig.geometry = this._geometry;
    this._meshPrimitive = 'custom';
    Mesh3D.geometryEpoch++; this.geometryVersion++;
    this._modifiedGeom = null; // source changed — invalidate modifier cache
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  /**
   * Recompile `editMesh` → GPU geometry. Call after any destructive edit operation.
   * No-op if `editMesh` is null.
   */
  syncFromEditMesh(): void {
    if (!this.editMesh) return;
    const geom = this.editMesh.compile();
    this.vertexColors = geom.vertexColors ?? null;
    this.setGeometry(geom);  // sets gpuDirty = true, signals renderer to re-upload VC buffers
  }

  /**
   * mobile-parity 7.3d — Mesh Edit vertex-drag FAST PATH: bring the compiled geometry in line with `editMesh`'s vertex
   * POSITIONS in place (EditMesh.patchCompiledPositions: only the triangles around moved vertices are rewritten, bit-
   * identical to a recompile) instead of syncFromEditMesh's full compile + new geometry + pool rebuild. Applies only
   * while the geometry is the editMesh's last compile with the same topology / UVs / colours, and the mesh has no
   * modifier stack or blend shapes of its own. Returns the rewritten vertex spans as flat [start, count, ...] ([] =
   * nothing moved), or null → the caller does syncFromEditMesh(). Does NOT set gpuDirty: the caller re-sends the spans
   * (Renderer3D.patchMeshVertices) or sets gpuDirty itself. Bumps geometryVersion (geometry-derived caches re-key).
   */
  patchFromEditMesh(): number[] | null {
    if (!this.editMesh || this.modifiers.length > 0 || this.baseVertices) return null;
    const spans = this.editMesh.patchCompiledPositions(this._geometry);
    if (spans && spans.length > 0) { Mesh3D.geometryEpoch++; this.geometryVersion++; }
    return spans;
  }

  setPrimitive(primitive: MeshPrimitive, config?: Partial<Mesh3DConfig>): void {
    this._meshPrimitive = primitive;
    if (config) Object.assign(this._meshConfig, config);
    this.rebuildGeometry();
  }

  private rebuildGeometry(): void {
    const c = this._meshConfig;
    switch (this._meshPrimitive) {
      case 'box':
        this._geometry = generateBox(c.width ?? 1, c.height ?? 1, c.depth ?? 1);
        break;
      case 'sphere':
        this._geometry = generateSphere(c.radius ?? 0.5, c.widthSegments ?? 16, c.heightSegments ?? 12);
        break;
      case 'plane':
        this._geometry = generatePlane(c.width ?? 1, c.height ?? 1, c.widthSegments ?? 1, c.heightSegments ?? 1);
        break;
      case 'sprite':
        this._geometry = generateSprite(c.width ?? 1, c.height ?? 1);
        break;
      case 'cylinder':
        this._geometry = generateCylinder(
          c.radiusTop ?? c.radius ?? 0.5,
          c.radius ?? 0.5,
          c.height ?? 1,
          c.radialSegments ?? 16,
        );
        break;
      case 'torus':
        this._geometry = generateTorus(c.radius ?? 0.5, c.tubeRadius ?? 0.2, c.radialSegments ?? 16, c.tubularSegments ?? 24);
        break;
      case 'revolve':
        this._geometry = generateRevolve(c.profile ?? [[0.5, -0.5], [0.5, 0.5]], c.radialSegments ?? 24);
        break;
      case 'tube':
        this._geometry = generateTube(c.path ?? [[0, -0.5, 0], [0, 0.5, 0]], c.radii ?? [0.1], c.radialSegments ?? 12);
        break;
      case 'metaball':
        // generateSdfMesh is the ONE generator that returns 8-float (pos+normal+uv, no tangent) — every
        // other case here returns 12-float. Must expand to 12-float or the renderer reads it at 12-float
        // stride and garbles every triangle into radial spikes (the exact trap flagged at setGeometry).
        this._geometry = computeTangents(generateSdfMesh(c.blobs ?? [{ shape: 'sphere', a: [0, 0, 0], radius: 0.5 }], c.resolution ?? 48, c.decimate));
        break;
      case 'custom':
        // Keep existing geometry
        break;
    }
    Mesh3D.geometryEpoch++; this.geometryVersion++;
    this._modifiedGeom = null; // source changed — invalidate modifier cache
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  // ── 3D position convenience ────────────────────────────────────

  setPosition3D(x: number, y: number, z: number): void {
    // §3.4: setXYZ assigns all three components with ONE local-matrix rebuild + ONE
    // subtree dirty walk — the individual x/y/z setters each did both (3× per move,
    // per frame for every city mover).
    this.setXYZ(x, y, z);
  }

  setRotation3D(rx: number, ry: number, rz: number): void {
    this.rotationX = rx;
    this.rotationY = ry;
    this.rotation = rz;
  }

  setScale3D(sx: number, sy: number, sz: number): void {
    this.scaleX = sx;
    this.scaleY = sy;
    this.scaleZ = sz;
  }

  // ── Shape overrides ────────────────────────────────────────────

  // Lazy-init (NOT a field initializer): the base constructor calls updateLocalMatrix → getScaleFactors before
  // Mesh3D's field initializers run, so the array must be created on first use.
  private _scaleFactors?: [number, number];
  protected getScaleFactors(): [number, number] {
    // Reused array (the base updateLocalMatrix destructures it immediately) — avoids a per-frame alloc for
    // every moving mesh.
    const sf = this._scaleFactors ??= [1, 1];
    sf[0] = this.scaleX; sf[1] = this.scaleY;
    return sf;
  }

  public override updateLocalMatrix(): void {
    super.updateLocalMatrix();
    // Keep the world AABB in sync whenever the transform changes so the
    // selection box always reflects the current mesh position/rotation/scale.
    // ★ T7.3: cheapBounds meshes (per-frame city movers) mark the bounds STALE instead — recomputed lazily on the
    // next read (boundingBox / obbCorners). The renderer's frustum cull uses its own cached AABB, not these.
    if (this.cheapBounds) { this._bbStale = true; return; }
    this.calculateBoundingBox();
  }

  calculateBoundingBox(): void {
    this._bbStale = false;
    const geom = this.geometry; // use modifier-evaluated geometry for accurate bounds
    if (!geom || geom.vertices.length === 0) {
      this._boundingBox = { x: this._x - 0.5, y: this._y - 0.5, width: 1, height: 1 };
      this._obbCorners = null;
      this._obbLocalCorners = null;
      return;
    }

    // Object-space AABB: depends only on the GEOMETRY, not the transform. Meshes that move every frame
    // (cheapBounds — city traffic movers) reuse the cached corners; everything else re-scans as before.
    let local = this.cheapBounds && this._obbGeomRef === geom ? this._obbLocalCorners : null;
    if (!local) {
      let ox0 = Infinity, oy0 = Infinity, oz0 = Infinity;
      let ox1 = -Infinity, oy1 = -Infinity, oz1 = -Infinity;
      // PRECOMPUTED bounds (streamed tiles: the Worker attaches [minX,minY,minZ,maxX,maxY,maxZ] to the geometry
      // after draping) — skips the O(verts) scan. Every constructed Mesh3D pays this scan otherwise, and the
      // instanced layers construct HUNDREDS of meshes over the same shared canonical geometry.
      const pre = (geom as { bounds?: ArrayLike<number> }).bounds;
      if (pre && pre.length === 6) {
        ox0 = pre[0]; oy0 = pre[1]; oz0 = pre[2]; ox1 = pre[3]; oy1 = pre[4]; oz1 = pre[5];
      } else {
      const v = geom.vertices;
      for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
        if (v[i]     < ox0) ox0 = v[i];     if (v[i]     > ox1) ox1 = v[i];
        if (v[i + 1] < oy0) oy0 = v[i + 1]; if (v[i + 1] > oy1) oy1 = v[i + 1];
        if (v[i + 2] < oz0) oz0 = v[i + 2]; if (v[i + 2] > oz1) oz1 = v[i + 2];
      }
      }

      // Build 8 object-space corners (bit-indexed: bit0=X, bit1=Y, bit2=Z; 0=min, 1=max).
      // These stay constant once geometry is set; reused for corner-drag math.
      local = [];
      for (let ci = 0; ci < 8; ci++) {
        local.push([ci & 1 ? ox1 : ox0, ci & 2 ? oy1 : oy0, ci & 4 ? oz1 : oz0]);
      }
      this._obbGeomRef = geom;
    }
    this._obbLocalCorners = local;

    // Transform each local corner through the world matrix to get OBB world corners.
    // Unlike an AABB, we keep the individual transformed points instead of taking their min/max,
    // so the box stays tightly oriented with the mesh's actual rotation.
    // ALLOCATION-FREE: mutate persistent corner arrays in place — this runs for EVERY moving mesh EVERY frame
    // (city traffic), and the old `local.map(...)` allocated 9 arrays + an object per call (~300k allocs/sec
    // across the crowd → GC hitches). Same result, zero garbage.
    let world = this._obbCorners;
    if (!world || world.length !== 8) {
      world = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
      this._obbCorners = world;
    }
    const m = this.localMatrix as unknown as Float32Array;
    let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
    for (let ci = 0; ci < 8; ci++) {
      const c = local[ci], w = world[ci];
      const X = m[0] * c[0] + m[4] * c[1] + m[8]  * c[2] + m[12];
      const Y = m[1] * c[0] + m[5] * c[1] + m[9]  * c[2] + m[13];
      w[0] = X; w[1] = Y; w[2] = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
      if (X < wx0) wx0 = X; if (X > wx1) wx1 = X;
      if (Y < wy0) wy0 = Y; if (Y > wy1) wy1 = Y;
    }

    // 2D bounding box (world-space AABB of the OBB corners) — mutate the existing object in place.
    if (this._boundingBox) {
      this._boundingBox.x = wx0; this._boundingBox.y = wy0;
      this._boundingBox.width = wx1 - wx0; this._boundingBox.height = wy1 - wy0;
    } else {
      this._boundingBox = { x: wx0, y: wy0, width: wx1 - wx0, height: wy1 - wy0 };
    }
  }

  /**
   * Return empty array so the 2D view-frustum culler always includes Mesh3D nodes.
   * 3D meshes don't have meaningful 2D bounding boxes — their visibility is
   * determined by the 3D camera's frustum, not the 2D viewport AABB.
   */
  getWorldSpaceBoundingBoxPolygon(): Vec2[] {
    return [];
  }

  getGeometryVertices(): Float32Array | null {
    return null; // 3D geometry handled by Renderer3D, not the 2D cache
  }

  getGeometryIndices(): Uint16Array | null {
    return null; // 3D geometry handled by Renderer3D, not the 2D cache
  }

  // ── Serialization ──────────────────────────────────────────────

  toJSON(): any {
    // Serialize config — convert typed arrays to plain arrays for JSON safety
    const config: any = { ...this._meshConfig };
    // Materials never write the removed sparkle keys (REMOVED_MATERIAL_KEYS, 2026-10-07): the construction-time
    // config copy, the live material (Object.assign load paths can re-add them) and the submesh slots.
    if (config.material) config.material = withoutRemovedMaterialFields(config.material);
    if (config.geometry) {
      config.geometry = {
        vertices: Array.from(this._meshConfig.geometry!.vertices),
        indices:  Array.from(this._meshConfig.geometry!.indices),
      };
    } else if (this.editMesh && this._geometry?.vertices?.length) {
      // The mesh has been made editable (e.g. UV-unwrapped + painted), so its parametric
      // primitive params ('box' width/height/depth) no longer describe its actual geometry
      // or UVs. Persist the current geometry so reload restores the edited topology + the
      // unwrapped UVs (createCustomMesh path); otherwise reload rebuilds a fresh primitive
      // with default UVs and the painted texture maps to the wrong places — the paint
      // appears lost. (Seams aren't persisted; re-unwrapping after reload re-derives them.)
      config.geometry = {
        vertices: Array.from(this._geometry.vertices),
        indices:  Array.from(this._geometry.indices),
      };
    }

    return {
      type:   '3DMesh',
      id: this.id,
      x: this.x,
      y: this.y,
      z: this.z,
      rotationX: this.rotationX,
      rotationY: this.rotationY,
      rotation: this.rotation,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      scaleZ: this.scaleZ,
      primitive: this._meshPrimitive,
      config,
      material: withoutRemovedMaterialFields(this._material),
      name: this.name,
      keyframeTracks: this.keyframeTracks,
      textureLibraryId: this.textureLibraryId,
      normalMapLibraryId: this.normalMapLibraryId,
      ...(this.outline ? { outline: this.outline } : {}),
      ...(this.outlineRings?.length ? { outlineRings: this.outlineRings } : {}),
      ...(this.cameraBlock !== 'auto' ? { cameraBlock: this.cameraBlock } : {}),
      // Multi-material slots (audit 2026-09-28 P8) — were never serialized, so per-slot materials reset on reload.
      ...(this.submeshes.length > 0 ? { submeshes: this.submeshes.map((s) => {
        const mt = withoutRemovedMaterialFields(s.material);
        return mt === s.material ? s : { ...s, material: mt };
      }) } : {}),
      glbMeshIndex: this.glbMeshIndex ?? undefined,
      ...(this.modifiers.length > 0 ? { modifiers: this.modifiers } : {}),
      // ATTACHED DECALS (P6, 2026-09-15): a decal container rides as a CHILD of its target mesh,
      // but Mesh3D.toJSON historically emitted no children at all — so attached decals never
      // survived a save. Serialize ONLY decal marker containers; other mesh children (charm
      // attachments, procedural extras) regenerate through their own systems.
      ...((): object => {
        const decals = this.children.filter(
          (c) => (c as { worldParams?: { kind?: string } | null }).worldParams?.kind === 'decal');
        return decals.length ? { children: decals.map((c) => c.toJSON()) } : {};
      })(),
      ...(this.blendShapes.length > 0 ? {
        blendShapes: this.blendShapes.map(s => ({
          name: s.name,
          deltaVerticesB64: float32ToBase64(s.deltaVertices),
        })),
        blendWeights: Array.from(this.blendWeights),
        baseVerticesB64: this.baseVertices ? float32ToBase64(this.baseVertices) : undefined,
      } : {}),
    };
  }

}

// ── Blend-shape sparse supports (Character v2 Phase 1.5) ────────────────────

/** A weight below 1e-7 in magnitude contributes nothing (the original evaluateBlendShapes skip). */
function effWeight(w: number): number { return Math.abs(w) < 1e-7 ? 0 : w; }

/** The vertices a shape moves (any of its 6 deltas non-zero) and their [lo, hi) span. Cached per delta array. */
export interface BlendSupport { idx: Uint32Array; lo: number; hi: number }
const BLEND_SUPPORT = new WeakMap<Float32Array, BlendSupport>();

/** The sparse support of a delta array over `nv` vertices (cached by array identity; built once, O(nv)). */
export function blendSupport(delta: Float32Array, nv: number): BlendSupport {
  const c = BLEND_SUPPORT.get(delta);
  if (c && (c.idx.length === 0 || c.idx[c.idx.length - 1] < nv)) return c;
  const n = Math.min(nv, Math.floor(delta.length / 6));
  let count = 0;
  const tmp = new Uint32Array(n);
  for (let v = 0; v < n; v++) {
    const o = v * 6;
    if (delta[o] !== 0 || delta[o + 1] !== 0 || delta[o + 2] !== 0 || delta[o + 3] !== 0 || delta[o + 4] !== 0 || delta[o + 5] !== 0) tmp[count++] = v;
  }
  const idx = tmp.slice(0, count);
  const s: BlendSupport = { idx, lo: count ? idx[0] : 0, hi: count ? idx[count - 1] + 1 : 0 };
  BLEND_SUPPORT.set(delta, s);
  return s;
}

// ── Base64 helpers for blend shape serialization ────────────────────────────

export function float32ToBase64(arr: Float32Array): string {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const u8  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}
