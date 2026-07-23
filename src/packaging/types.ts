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
  /** `tuckEnd` template only: `'reverse'` (RTE — tucks open from OPPOSITE faces, the retail
   *  default) or `'straight'` (STE — both tucks on the same face). Default `'reverse'`.
   *  Changing it is a TOPOLOGY change (the bottom closure re-parents) → setDimensions rebuilds. */
  tuckStyle?: 'reverse' | 'straight';
  /** `rollEndMailer` only: corner locking tabs on the front wall (FEFCO 0427 locks). Default true.
   *  Toggling it is a TOPOLOGY change (panel count) → setDimensions rebuilds. */
  lockTabs?: boolean;
  /** `rollEndMailer` only: how far the LID stays open at fold 1 (0 = fully closed — the default;
   *  ~0.25 = the classic mailer presentation with the lid ajar). Scales the lid's target angle,
   *  so it is a dims-only change (in-place fast path). Clamped to [0, 0.95]. */
  restOpenAmount?: number;
  /** `rigidTwoPiece` only: LID tray wall depth in mm. Default = full telescope (the base wall
   *  height). Shallow cap ≈ 15. Dims-only change (in-place fast path). */
  lidDepth?: number;
  /** `rigidTwoPiece` only: rigid board caliper in mm (default 2). Drives the DERIVED lid dims —
   *  lid inner footprint = base outer + 2×boardThickness clearance per axis — and the seated
   *  clearance gap at fold 1. Dims-only change (in-place fast path). */
  boardThickness?: number;
}

/** Line ROLE on the dieline. `cut` = solid cut, `fold` = crease, `slit` = short internal cut
 *  (tuck friction-lock), `perforation` = dashed/tear cut. The manufacturing export maps each to
 *  its spot-color layer; hosts FILTER by type, so new members are non-breaking. */
export type DielineGuideType = 'cut' | 'fold' | 'bleed' | 'safeZone' | 'panel' | 'slit' | 'perforation';

export interface DielineGuide {
  type: DielineGuideType;
  /** Line segments in dieline CANVAS pixel coordinates. */
  segments: [[number, number], [number, number]][];
  /** CSS color for the overlay. */
  color: string;
  /** Optional annotation (e.g. the glue-tab marker guide carries 'Glue Tab'). */
  label?: string;
}

/**
 * One straight-line TRANSLATION segment driven by the SAME global fold scalar as the hinges
 * (M5 — the telescoping-lid "seat onto the base" move; see packaging-templates.md §2 contract).
 * The panel's pivot position is offset by `axis · (from + (to − from) · windowedProgress(t, window))`,
 * summed over all segments, so a multi-segment path (lift → carry over → drop on) chains cleanly.
 *
 *  - `axis` is authored in flat-NET coordinates (x, y = out of the net plane, z) and is applied in
 *    the PARENT's frame — exact net-space semantics for ROOT panels (parent = the package root,
 *    which never rotates: the M5 lid-subgroup case); a non-root panel's offset rides its parent's
 *    folded orientation.
 *  - FLAT-NET INVARIANT: the summed offset must be 0 at fold 0 — author `from: 0`.
 *  - `window` defaults to the panel's `foldWindow` (absent = [0,1]).
 * Implemented IDENTICALLY in setBoxFold (live nodes), computeFoldWorldCorners (the test oracle)
 * and compileFoldMesh (the reference compiler).
 */
export interface FoldTranslateSeg {
  /** Direction in flat-net mm (NOT necessarily unit length). */
  axis: [number, number, number];
  /** Scalar multiple of `axis` at the window's start. Use 0 to keep fold 0 = the flat net. */
  from: number;
  /** Scalar multiple of `axis` at the window's end. */
  to: number;
  /** Phase window (see `windowedProgress`); defaults to the panel's `foldWindow`. */
  window?: [number, number];
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
  /** FOLD-SEQUENCE phase window [start, end] ⊂ [0, 1] within the global fold amount: the panel's
   *  LOCAL fold progress is ((t − start) / (end − start)) clamped to 0..1, so panels can fold in
   *  STAGES (walls → dust flaps → tuck tongue LAST, preventing flap clipping). Omitted = [0, 1]
   *  (the panel tracks the global amount directly — exactly the pre-sequencing behaviour). */
  foldWindow?: [number, number];
  /** FOLD-DRIVEN TRANSLATION segments (see {@link FoldTranslateSeg}) — the M5 telescoping-lid
   *  mechanism. Applied on top of the pivot's rest position by the same global fold scalar.
   *  Omitted (the norm) = pure-hinge panel, bit-for-bit the pre-M5 math. */
  foldTranslate?: FoldTranslateSeg[];
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
