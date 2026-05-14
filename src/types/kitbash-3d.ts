/**
 * Kitbash 3D types — character assembly system.
 *
 * A character is built from a shared canonical skeleton plus one SkinnedMesh3D
 * per slot. All parts are authored against the canonical 26-joint hierarchy
 * defined in docs/specs/kitbash-armature-grease-pencil.md. The CharacterAssembler
 * remaps each part's local joint indices to canonical indices at assembly time.
 */

/** Logical slot a kitbash part occupies on the character. */
export type CharacterSlot =
  | 'base_body'
  | 'hair'
  | 'face_overlay'
  | 'top'
  | 'bottom'
  | 'shoes'
  | 'accessory_head'
  | 'accessory_back'
  | 'accessory_left'
  | 'accessory_right'
  | 'overlay';

/** Metadata for one part in the kitbash library catalog. */
export interface KitbashPartMeta {
  /** Stable UUID for the part across catalog updates. */
  id: string;
  /** Which character slot this part fills. */
  slot: CharacterSlot;
  /** Human-readable name, e.g. "Wavy Bob". */
  name: string;
  /** TextureLibrary ID (or URL) for the small preview thumbnail. */
  thumbnail: string;
  /** URL or bundled path to the part's GLB file. */
  glbUrl: string;
  /** Searchable tags, e.g. ["short", "wavy", "feminine"]. */
  tags: string[];
  /** Style-set identifier for version control, e.g. "frogmarks-v1". */
  styleSet: string;
}

/**
 * Definition for a character instance. Stored on CharacterData and serialized
 * into scene3d.json so the character can be reconstructed from the part catalog.
 */
export interface CharacterDefinition {
  /** Stable ID matching CharacterData.id. */
  id: string;
  /** Display name for the character, e.g. "Hero". */
  name: string;
  /** Maps each filled slot to its part ID in the KitbashLibrary. */
  slots: Partial<Record<CharacterSlot, string>>;
  /** Optional skin-tone diffuse tint applied to the base_body slot. */
  skinTone?: { r: number; g: number; b: number };
  /** Optional hair-color diffuse tint applied to the hair slot. */
  hairColor?: { r: number; g: number; b: number };
}

/**
 * Runtime record stored in Scene3DManager._characterMap.
 * References the live Skeleton3D and SkinnedMesh3D nodes by ID so they can
 * be looked up via the scene graph.
 */
export interface CharacterData {
  /** Stable UUID matching CharacterDefinition.id. */
  id: string;
  /** Full definition used to (re)assemble this character. */
  definition: CharacterDefinition;
  /** ID of the Skeleton3D node that drives all part meshes. */
  skeletonId: string;
  /** Maps each slot to the SkinnedMesh3D.id that fills it. */
  partMeshIds: Map<CharacterSlot, string>;
}
