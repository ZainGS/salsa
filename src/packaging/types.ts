/**
 * src/packaging/ — the (optional, feature-flagged) packaging module.
 *
 * Self-contained: imports Salsa core types but core never imports this. Gated by
 * `PACKAGING_ENABLED` (shell-storage.ts). See docs/specs/packaging-system.md.
 *
 * types.ts — the dieline / fold-mesh data model.
 */

/** Outer box dimensions + print params. Millimetres. */
export interface DielineParams {
  /** Box width (X). */
  width: number;
  /** Box height — the wall height; becomes the box's Y when folded. */
  height: number;
  /** Box depth (Z). */
  depth: number;
  /** Bleed margin (mm) — artwork extends this far past the cut line. Default 3. */
  bleed?: number;
  /** DPI for mm → canvas-pixel conversion. Default 300. */
  dpi?: number;
}

export type DielineGuideType = 'cut' | 'fold' | 'bleed' | 'safeZone';

export interface DielineGuide {
  type: DielineGuideType;
  /** Line segments in dieline CANVAS pixel coordinates. */
  segments: [[number, number], [number, number]][];
  /** CSS color for the overlay. */
  color: string;
}

/**
 * One flat panel of the net + its fold relationship to its parent panel. The net
 * is a tree: the root panel stays flat in the XZ plane; every other panel folds
 * around the `hinge` it shares with its parent (and cascades onto its children).
 */
export interface FoldPanel {
  id: string;
  name: string;
  /** Corner positions in flat NET coordinates (mm). Wound consistently per template. */
  corners: [number, number][];
  /** UV (0..1 in the dieline canvas) per corner, parallel to `corners`. */
  uvs: [number, number][];
  /** Parent panel index; -1 for the root (which stays flat). */
  parentPanelIndex: number;
  /** Shared fold edge with the parent, in flat NET coords. null for the root. */
  hinge: [[number, number], [number, number]] | null;
  /** Fully-folded angle (deg) relative to the parent. `foldAmount` scales toward this. */
  targetAngle: number;
}

export interface FoldMeshData {
  panels: FoldPanel[];
  /** Flat net extent (mm) → drives UV normalization + the dieline canvas size. */
  dielineWidth: number;
  dielineHeight: number;
}

/** What a dieline template returns: the foldable net + canvas + guide overlay. */
export interface DielineResult {
  foldMeshData: FoldMeshData;
  /** Dieline raster-canvas size in pixels (at the params' DPI). */
  canvasWidth: number;
  canvasHeight: number;
  /** Cut / fold / bleed guide lines (canvas px) for the overlay. */
  guides: DielineGuide[];
  /** panelId → display name, for the editor UI. */
  panelLabels: Record<string, string>;
}
