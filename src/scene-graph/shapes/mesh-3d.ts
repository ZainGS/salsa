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
import { Material3D, DEFAULT_MATERIAL } from '../../renderer/3d/material-3d';
import { MeshGeometry, FLOATS_PER_VERT, generateBox, generateSphere, generatePlane, generateCylinder, generateTorus, generateSprite, computeTangents } from '../../renderer/3d/mesh-generators';
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

export type MeshPrimitive = 'box' | 'sphere' | 'plane' | 'cylinder' | 'torus' | 'sprite' | 'custom';

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
  /** Custom geometry (overrides primitive). */
  geometry?: MeshGeometry;
  /** Material. */
  material?: Partial<Material3D>;
  /** When true the sprite's model matrix is rebuilt each frame to face the camera. */
  billboard?: boolean;
}

export class Mesh3D extends Shape {
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

  // GPU buffer handles (set by the 3D renderer when uploading)
  public gpuVertexBuffer: GPUBuffer | null = null;
  public gpuIndexBuffer: GPUBuffer | null = null;
  public gpuDirty = true;

  /**
   * True when any save-relevant property has changed since the last cloud/file save.
   * Set by material and geometry setters; cleared by Scene3DManager after a successful save.
   * Starts true so newly created meshes are always included in the first save.
   * NOT set by transform changes during animation playback — only by explicit user edits
   * routed through Scene3DManager (gizmo drags, keyframe ops, cloth config changes, etc.).
   */
  public stateDirty = true;

  /**
   * True when this mesh came from the procedural body generator (createProceduralBody3D). It ships
   * pre-rigged with the generator's tube weights, so UI should NOT offer to (re)bind it — auto-bind
   * would replace those weights with distance-based ones. Surfaced via getAllMeshes3D() so the
   * armature panel can hide "Bind Mesh" for procedural bodies. (Skeleton3D carries the same flag.)
   */
  public isProceduralBody = false;

  /** True for the anime "face decal" quad (eye/expression overlay skinned to the head joint). */
  public isFaceDecal = false;

  /** True for a procedural hair mesh (skinned to the head joint; rebuilt from HairParams). */
  public isHair = false;

  /** True for a procedural garment (top/bottom) skinned to the body's skeleton; rebuilt from params. */
  public isClothing = false;

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

  /**
   * Per-vertex RGBA color data compiled from editMesh. Populated by syncFromEditMesh();
   * null for non-edit meshes. The renderer uploads this to a second vertex buffer slot
   * and switches to the vertex-color pipeline variant.
   */
  public vertexColors: Float32Array | null = null;

  /** When true the renderer overwrites the model matrix each frame so the mesh faces the camera. */
  public billboard: boolean = false;

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
    this._material = { ...DEFAULT_MATERIAL, ...config.material };
    this.billboard = config.billboard ?? false;

    if (config.geometry) {
      this._geometry = config.geometry;
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
  get obbCorners(): [number, number, number][] | null { return this._obbCorners; }
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

  /** Invalidate the modifier-evaluated geometry cache. Call after changing modifiers or source geometry. */
  invalidateModifierCache(): void {
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
    if (!this.baseVertices) return;
    if (this.blendShapes.length === 0) {
      // Restore bind pose
      this._geometry.vertices.set(this.baseVertices);
      this._modifiedGeom = null;
      this.gpuDirty = true;
      return;
    }
    const FPERV = FLOATS_PER_VERT; // 12 floats per vertex
    const nv  = this.baseVertices.length / FPERV;
    const out = this._geometry.vertices;
    out.set(this.baseVertices); // restore bind pose
    for (let si = 0; si < this.blendShapes.length; si++) {
      const w = this.blendWeights[si] ?? 0;
      if (Math.abs(w) < 1e-7) continue;
      const delta = this.blendShapes[si].deltaVertices; // 6 floats per vertex
      for (let vi = 0; vi < nv; vi++) {
        const o12 = vi * FPERV;
        const o6  = vi * 6;
        out[o12]     += w * delta[o6];
        out[o12 + 1] += w * delta[o6 + 1];
        out[o12 + 2] += w * delta[o6 + 2];
        out[o12 + 3] += w * delta[o6 + 3];
        out[o12 + 4] += w * delta[o6 + 4];
        out[o12 + 5] += w * delta[o6 + 5];
      }
    }
    this._modifiedGeom = null;
    this.gpuDirty = true;
  }

  get geometryKey(): string {
    if (this.modifiers.length > 0) return `modifier:${this.id}`;
    if (this._geometryKeyOverride !== null) return this._geometryKeyOverride;
    if (this._meshPrimitive === 'custom') return `custom:${this.id}`;
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
    Object.assign(this._material, mat);
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
      case 'custom':
        // Keep existing geometry
        break;
    }
    this._modifiedGeom = null; // source changed — invalidate modifier cache
    this.gpuDirty = true;
    this.stateDirty = true;
  }

  // ── 3D position convenience ────────────────────────────────────

  setPosition3D(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
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

  protected getScaleFactors(): [number, number] {
    return [this.scaleX, this.scaleY];
  }

  public override updateLocalMatrix(): void {
    super.updateLocalMatrix();
    // Keep the world AABB in sync whenever the transform changes so the
    // selection box always reflects the current mesh position/rotation/scale.
    this.calculateBoundingBox();
  }

  calculateBoundingBox(): void {
    const geom = this.geometry; // use modifier-evaluated geometry for accurate bounds
    if (!geom || geom.vertices.length === 0) {
      this._boundingBox = { x: this._x - 0.5, y: this._y - 0.5, width: 1, height: 1 };
      this._obbCorners = null;
      this._obbLocalCorners = null;
      return;
    }

    // Compute object-space AABB from geometry vertices
    let ox0 = Infinity, oy0 = Infinity, oz0 = Infinity;
    let ox1 = -Infinity, oy1 = -Infinity, oz1 = -Infinity;
    const v = geom.vertices;
    for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
      if (v[i]     < ox0) ox0 = v[i];     if (v[i]     > ox1) ox1 = v[i];
      if (v[i + 1] < oy0) oy0 = v[i + 1]; if (v[i + 1] > oy1) oy1 = v[i + 1];
      if (v[i + 2] < oz0) oz0 = v[i + 2]; if (v[i + 2] > oz1) oz1 = v[i + 2];
    }

    // Build 8 object-space corners (bit-indexed: bit0=X, bit1=Y, bit2=Z; 0=min, 1=max).
    // These stay constant once geometry is set; reused for corner-drag math.
    const local: [number, number, number][] = [];
    for (let ci = 0; ci < 8; ci++) {
      local.push([ci & 1 ? ox1 : ox0, ci & 2 ? oy1 : oy0, ci & 4 ? oz1 : oz0]);
    }
    this._obbLocalCorners = local;

    // Transform each local corner through the world matrix to get OBB world corners.
    // Unlike an AABB, we keep the individual transformed points instead of taking their min/max,
    // so the box stays tightly oriented with the mesh's actual rotation.
    const m = this.localMatrix as unknown as Float32Array;
    const world: [number, number, number][] = local.map(([cx, cy, cz]) => [
      m[0] * cx + m[4] * cy + m[8]  * cz + m[12],
      m[1] * cx + m[5] * cy + m[9]  * cz + m[13],
      m[2] * cx + m[6] * cy + m[10] * cz + m[14],
    ]);
    this._obbCorners = world;

    // 2D bounding box for the renderer is still the world-space AABB of the OBB corners
    let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
    for (const [wx, wy] of world) {
      if (wx < wx0) wx0 = wx; if (wx > wx1) wx1 = wx;
      if (wy < wy0) wy0 = wy; if (wy > wy1) wy1 = wy;
    }
    this._boundingBox = { x: wx0, y: wy0, width: wx1 - wx0, height: wy1 - wy0 };
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
      material: this._material,
      name: this.name,
      keyframeTracks: this.keyframeTracks,
      textureLibraryId: this.textureLibraryId,
      normalMapLibraryId: this.normalMapLibraryId,
      glbMeshIndex: this.glbMeshIndex ?? undefined,
      ...(this.modifiers.length > 0 ? { modifiers: this.modifiers } : {}),
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
