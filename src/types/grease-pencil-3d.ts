/**
 * Grease Pencil 3D types.
 *
 * Grease Pencil strokes are 2D lines drawn in 3D world space. Each stroke is a
 * polyline of GpPoints (position + pressure + opacity). Strokes are organized
 * into GpLayer3D (with optional keyframe overrides) and grouped into GpObject3D.
 *
 * Rendering is handled by GpRenderer3D, which expands each segment to a screen-
 * space quad strip in the vertex shader. Closed strokes with a fillColor are
 * ear-clip triangulated for a flat fill pass drawn before the outline.
 *
 * Bone parenting: if stroke.parentJoint is set, the stroke's points are
 * transformed by that joint's world matrix every frame (zero CPU cost — done
 * in the vertex shader via the skeleton's skinMatrices buffer).
 */

/** One point in a grease pencil stroke. */
export interface GpPoint {
  /** World-space X position. */
  x: number;
  /** World-space Y position. */
  y: number;
  /** World-space Z position. */
  z: number;
  /** 0–1 pen pressure — scales local stroke width. */
  pressure: number;
  /** 0–1 per-point opacity multiplier. */
  opacity: number;
}

/** A single drawn stroke. */
export interface GpStroke3D {
  /** Stable UUID. */
  id: string;
  /** Stroke points in world space. */
  points: GpPoint[];
  /** RGBA stroke color (0–1 each channel). */
  color: { r: number; g: number; b: number; a: number };
  /** If set, the interior of a closed stroke is filled with this color. */
  fillColor?: { r: number; g: number; b: number; a: number };
  /** Base half-width of the stroke in world units. Scaled by point pressure. */
  baseWidth: number;
  /**
   * Joint name from the associated Skeleton3D. When set, the vertex shader
   * transforms the stroke's points by that joint's world matrix each frame,
   * so the stroke follows bone movement with zero CPU overhead.
   */
  parentJoint?: string;
  /** If true, the last point connects back to the first (closed loop). */
  closed: boolean;
}

/**
 * A layer within a GpObject3D — the primary organizational unit.
 * Mirrors the raster layer concept but for 3D strokes.
 */
export interface GpLayer3D {
  /** Stable UUID. */
  id: string;
  /** Display name, e.g. "Outlines". */
  name: string;
  /** Strokes active on this layer (not frame-specific). */
  strokes: GpStroke3D[];
  /** Whether this layer renders. */
  visible: boolean;
  /** Layer-level opacity multiplier (0–1). */
  opacity: number;
  /**
   * Keyframe overrides: at frame N, the layer's strokes are replaced by this
   * list rather than the base strokes array. Frames not listed fall back to
   * the base strokes.
   */
  keyframes: Record<number, GpStroke3D[]>;
}

/**
 * A Grease Pencil object — groups layers and optionally associates them with
 * a character's skeleton for bone-parented strokes.
 */
export interface GpObject3DData {
  /** Stable UUID. */
  id: string;
  /** Display name, e.g. "Hero outlines". */
  name: string;
  /** Ordered list of layers (bottom to top). */
  layers: GpLayer3D[];
  /**
   * Optional ID of the CharacterData this GP object is associated with.
   * Used to find the skeleton for bone-parented strokes.
   */
  characterId?: string;
  /**
   * ID of the Skeleton3D that drives parentJoint references.
   * Set automatically when a characterId is provided; can also be set directly
   * for GP objects associated with a standalone skeleton.
   */
  skeletonId?: string;
}
