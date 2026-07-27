/**
 * src/packaging/packaging-manager.ts — lifecycle + fold control for packaging meshes.
 *
 * Decoupled from the engine via a small `PackagingHost` interface (ShapeManager supplies
 * the adapter), so this module stays removable. v1: one box style, create / setDimensions /
 * setFoldAmount / fold / unfold (tweened) / get / remove.
 */

import type { DielineParams, DielineResult, DielineGuide, FoldMeshData, FoldPanel } from './types';
import { buildBoxNodes, setBoxFold, updateBoxDimensions, computeFoldWorldCorners, type PackagingBox, type BoxNodeHost } from './box-hierarchy';
import { simpleBox } from './templates/simple-box';
import { tuckEnd } from './templates/tuck-end';
import { sleeve } from './templates/sleeve';
import { rollEndMailer } from './templates/roll-end-mailer';
import { rigidTwoPiece } from './templates/rigid-two-piece';
// Type-only (erased at compile) — keeps the packaging module free of runtime service imports.
import type { UVCanvasRenderer } from '../services/managers/uv-canvas-renderer';

/**
 * What the host (ShapeManager → Scene3DManager) must provide. Extends {@link BoxNodeHost} (the
 * scene-node hooks the rigid-panel hierarchy folds through) with live-texture + editor hooks.
 */
export interface PackagingHost extends BoxNodeHost {
  /** Live-texture: keep a raster layer in sync with a panel mesh's diffuse (draw the dieline → it
   *  appears on the box; the net UVs handle the correspondence). Reuses Salsa's LiveTextureMode.
   *  Called PER PANEL — each panel samples its own UV region of the shared dieline layer. */
  linkLiveTexture(meshId: string, layerId: string): void;
  unlinkLiveTexture(meshId: string): void;
  /** Export a raster layer as a PNG blob (for the print-ready dieline export). */
  exportLayerPng(layerId: string): Promise<Blob | null>;
  scheduleRender(): void;

  // ── 3D-PAINT editor hooks (compose the box + dieline into one paint editor) ──
  /** Size the illustration document to the dieline canvas so flat artwork lands 1:1 on the net. */
  setDocSize(width: number, height: number): void;
  /** Ensure a dieline raster layer exists (reuse `existingLayerId` if still present, else create one).
   *  Returns the layer id, or null if the host has no raster document. */
  ensureDielineLayer(existingLayerId?: string): string | null;
  /** Frame the camera on the box's ROOT container + enable ALT-orbit (left-drag paints, alt+left-drag orbits). */
  frameAndOrbit(rootNodeId: string): void;
  /** Leave the editor: disable orbit controls. */
  stopOrbit(): void;
  /** Arm 3D-surface painting across ALL panel meshes — a click raycasts whichever panel is hit → its
   *  net UV → the SAME dieline raster layer that flat drawing writes (single source of truth). */
  armSurfacePaint(meshIds: string[], layerId: string): boolean;
  /** Tear down 3D-surface painting. */
  disarmSurfacePaint(): void;

  // ── CREATOR-MODE hooks (all optional — legacy hosts keep working) ──
  /** Like {@link ensureDielineLayer} but reports whether the layer was FRESHLY created. A fresh layer
   *  stays TRANSPARENT — the panel material composites it over the kraft base (texOverBase), so empty
   *  = blank cardboard and strokes paint directly onto it. Hosts should also reuse an existing layer
   *  NAMED 'Dieline' here (fresh:false) so re-entering never duplicates layers, and should create the
   *  layer composite-hidden + system-tagged (it's an internal paint surface, not an artboard layer).
   *  `packageId` (newer callers) scopes the by-NAME reuse: a 'Dieline' already OWNED by a DIFFERENT
   *  package (`packageOwnerId` set) must be skipped — reusing it would splice one box's stack base
   *  into another box (paint bleeding across packages). Untagged/legacy layers are still adopted. */
  ensureDielineLayerInfo?(existing?: string, packageId?: string): { layerId: string; fresh: boolean } | null;
  /** Fill a raster layer opaque white. OPTIONAL utility kept for hosts — the manager no longer calls
   *  it (fresh dieline layers stay transparent; a white background is the user's own fill). */
  fillLayerWhite?(layerId: string): void;
  /** True if a scene node still exists — guards a stale creator box handle across document switches. */
  nodeExists?(id: string): boolean;
  /** Extra mode hygiene on enter (city-mode style): suppress box-select, clear hover/selection, view gizmo. */
  beginCreatorStage?(): void;
  /** Undo {@link beginCreatorStage} on exit. */
  endCreatorStage?(): void;
  /** RE-APPLY the packaging panel material contract to a panel mesh (board base + `texOverBase`
   *  compositing). Called for EVERY panel whenever it is (re)linked to the dieline layer
   *  ({@link PackagingManager.setDielineLayer} — i.e. on every `enterCreatorMode`, both create-or-reuse
   *  and `{packageId}` adoption), and on create / board-preset / re-dimension. Panels created before
   *  the contract existed, or RESTORED from a saved document (materials persist wholesale via
   *  Mesh3D.toJSON), otherwise keep the legacy multiply material — a transparent dieline texture then
   *  renders the box near-BLACK instead of kraft. `board` (newer hosts, §4.2) carries the preset's
   *  base colour + the per-panel paper-grain / edge-rim shading params — hosts translate it to the
   *  boardShade material fields; legacy hosts that ignore it keep the plain white-board look. */
  applyPanelMaterial?(meshId: string, board?: PanelBoardMaterial): void;
  /** §4.1 STUDIO STAGE — swap the mode's focus background (the armature-bg system's option shape).
   *  The manager captures the previous value via {@link getStageBackground} on enter and restores it
   *  on exit; a host theme choice made through {@link PackagingManager.setStageBackground} is applied
   *  live. Optional (legacy hosts keep whatever background they had). */
  setStageBackground?(opts: StageBackgroundOpts): void;
  /** Read the current focus-background options (pairs with {@link setStageBackground} so exit can
   *  RESTORE the user's own background, not a hardcoded default). */
  getStageBackground?(): StageBackgroundOpts;
  /** §4.1 CONTACT SHADOW — create the soft dark ground blob under the box as a child of the package
   *  ROOT (group-local units; the root is scale-1/identity while staged). The host must make it
   *  non-pickable, frame-excluded and serialize-excluded (a stage prop, not content). Returns the
   *  node id, or null. */
  createStageShadow?(parentNodeId: string, placement: StageShadowPlacement): string | null;
  /** Re-place/re-size the contact shadow (fold scrub + re-dimension track the live footprint). */
  updateStageShadow?(nodeId: string, placement: StageShadowPlacement): void;
  /** Remove the contact shadow node (mode exit). */
  removeStageShadow?(nodeId: string): void;
  /** Set a node's (subtree-effective) visible flag — creator-mode ISOLATION hides every OTHER
   *  package's root container while the mode is active and restores them on exit. Optional. */
  setNodeVisible?(nodeId: string, visible: boolean): void;
  /** Read a node's visible flag (pairs with {@link setNodeVisible} so isolation can RESTORE the
   *  previous visibility on exit, not blanket-show). Optional; missing → treated as visible. */
  isNodeVisible?(nodeId: string): boolean;

  // ── FIRST-CLASS SCENE OBJECT hooks (addPackage / Outliner integration — optional) ──
  /** Create the package ROOT container the SAME way Building/Foliage/Block do — a thin-wrapper at the
   *  scene root, `documentSkipChildren` + a `worldParams.kind` marker so the City manager never adopts
   *  it, added to the graph and ANNOUNCED (scene-graph-changed) IMMEDIATELY as an empty container.
   *  {@link PackagingManager.create} builds the panels UNDER this pre-made root (via buildBoxNodes
   *  `existingRootId`), so the Outliner shows the "Package" node the instant it is added — not only
   *  after the next unrelated scene change. Returns the root node id. Legacy hosts without this hook
   *  fall back to buildBoxNodes minting a plain root (old behaviour). */
  createUnitRoot?(name: string): string;
  /** Mark the box's ROOT container as a select-as-a-UNIT wrapper (the City thin-wrapper pattern):
   *  clicking ANY panel resolves selection to the root, the gizmo moves the whole box, and the
   *  outliner shows ONE node. `localBounds` (group-local AABB across the fold range) sizes the
   *  selection box/gizmo without per-child scans (the cachedBounds pattern). Safe to re-call with
   *  fresh bounds after a re-dimension — hosts should only re-notify the scene graph when the
   *  wrapper flag actually flips. */
  markUnitWrapper?(rootNodeId: string, localBounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): void;
  /** Fire the host's scene-graph-changed notification (the event the Outliner listens to). Called
   *  ONCE at the END of every node-ASSEMBLY path (create/addPackage, the setDimensions rebuild,
   *  re-adoption) so the fully assembled package is announced as a unit — without it a freshly
   *  added package only surfaced in the Outliner when the NEXT unrelated scene change emitted.
   *  Per-node create hooks may emit too (harmless); this is the guaranteed final flush. */
  notifySceneGraphChanged?(): void;
  /** COALESCE the scene-graph-changed emits fired DURING package node assembly. The manager wraps
   *  every assembly path (create/addPackage, the setDimensions rebuild, regeneration, re-adoption)
   *  in begin/end so the ~13 per-node emits (createGroup/createPanelMesh) + the markUnitWrapper
   *  flag-flip emit collapse into ONE scene-graph-changed at the very END, carrying the FULLY
   *  assembled + thin-wrapper-marked tree. This is the robust fix for "addPackage doesn't appear in
   *  the Outliner until the next mesh is added": a host outliner that latches the FIRST emit of a
   *  burst (or renders the pre-mark partial tree) now receives a single, final, correct emit. Wire
   *  to the host's existing scene-graph batch counter (Salsa: beginSceneGraphBatch3D/end…). Optional
   *  — legacy hosts without it keep the harmless per-node emit behaviour. Must be balanced. */
  beginSceneGraphBatch?(): void;
  endSceneGraphBatch?(): void;
  /** Attach a UV pane renderer to the ACTIVE surface-paint session so pane strokes paint the SAME
   *  dieline layer as 3D box strokes (no second paint path). Returns a UV[0,1]→pane-canvas-px mapper
   *  (for the host's guide overlay) or null if no packaging paint session is active. `onResize`
   *  (optional, newer hosts) is invoked after a pane LAYOUT resize re-synced the backing store and
   *  re-rendered the pane — the manager routes it to {@link DielinePaneHandle.onPaneResize}. */
  attachPaintPane?(uvRenderer: UVCanvasRenderer, onResize?: () => void): ((u: number, v: number) => [number, number]) | null;
  /** Detach the pane wired by {@link attachPaintPane}. 3D box painting stays armed. */
  detachPaintPane?(): void;

  // ── RE-ADOPTION hooks (reload persistence — all optional; legacy hosts keep working) ──
  /** Stamp/refresh the SELF-DESCRIBING marker on a package's ROOT container's `worldParams`
   *  (`{ kind:'packaging', entry }`) so the package round-trips through sceneGraphJSON and is
   *  re-adoptable from the scene graph alone — exactly how Buildings/Foliage persist. Called on
   *  EVERY state change (create / dimension / style / fold / board / dieline / layer-stack). The
   *  root is a `documentSkipChildren` thin-wrapper, so worldParams serializes but its children do
   *  not (the panels regenerate from the entry's params on load). Optional — a legacy host that
   *  only persists the scene3dJSON packaging array keeps working. */
  stampMarker?(rootNodeId: string, entry: PackagingPersistEntry): void;
  /** Scan the scene ROOT for package markers (root MeshGroups whose `worldParams.kind==='packaging'`).
   *  Returns each root's id + its stamped `entry` (null for a legacy marker without one). Drives
   *  {@link PackagingManager.restoreFromSave} — eager, array-independent re-adoption on document
   *  load, mirroring building-manager's `restoreFromSave` scan. */
  findPackageMarkers?(): { rootId: string; entry: PackagingPersistEntry | null }[];
  /** Read a package ROOT container's current local 3D transform (position + Euler rotation + scale)
   *  so {@link PackagingManager.serialize} + the self-describing marker capture the LIVE transform on
   *  every call — a whole-box gizmo move/rotate/scale (which calls NO packaging API) is then persisted
   *  and re-applied on reload (recreateNode does not restore a MeshGroup marker's transform). Returns
   *  null when the node is gone; absent hook (legacy) → no transform persistence. */
  getNodeTransform?(id: string): PackagingTransform | null;
  /** ISOLATE the whole 3D scene to the creator target: hide EVERY other top-level scene object —
   *  other packages AND non-package meshes / characters / city — remembering prior visibility, so the
   *  stage shows ONLY the box being edited. The host restores on {@link restoreSceneIsolation}. This
   *  SUPERSEDES the manager's package-only isolation; a legacy host without this hook falls back to
   *  hiding just other packages. Idempotent: re-call on a target switch restores the prior set first. */
  isolateSceneToPackage?(keepRootId: string): void;
  /** Undo {@link isolateSceneToPackage} — restore every object it hid to its prior visibility. */
  restoreSceneIsolation?(): void;
  /** Move an existing node under a new parent (no-op when already there). Re-adoption uses it to
   *  repair panel meshes the document-restore pass left at the scene root (the group-repopulation
   *  step only maps ONE level of nesting; package panel meshes sit two levels deep). */
  reparentNode?(childId: string, parentId: string): void;
  /** True when a raster layer id resolves to a REAL paint layer (has a texture). Gates re-linking
   *  a persisted dielineLayerId on restore. Missing hook → link optimistically. */
  layerExists?(layerId: string): boolean;
  /** Discover the packaging node structure under a root container: every '<Panel> Hinge' pivot
   *  group (any depth) with its Mesh3D child and its panel name ('Bottom', 'Lid', …). Used to
   *  re-bind persisted panels whose mesh ids drifted, and to ADOPT orphaned roots. */
  getPackageStructure?(rootId: string): { pivotNodeId: string; meshId: string | null; name: string }[] | null;
  /** Scene-wide scan for package-shaped roots NOT in `knownIds` (persisted marker: a thin-wrapper /
   *  'Package'-named group containing '* Hinge' pivot groups with panel meshes). The defensive
   *  dedupe: enterCreatorMode adopts such an orphan instead of creating an overlapping second box. */
  findOrphanPackageRoots?(knownIds: string[]): string[];
  /** LEGACY-SAVE CLEANUP: delete stray package panel nodes a PRE-`documentSkipChildren` save left
   *  LOOSE at the scene ROOT (panels serialized as normal nodes that the document-restore pass
   *  floated up as siblings of — or duplicates of — the real package). Removes any TOP-LEVEL
   *  '<Name> Hinge' pivot group (with a panel-mesh descendant) whose id is NOT in `keepIds` (the
   *  live packages' own root/pivot/mesh ids). A top-level '* Hinge' group is unambiguously a package
   *  leftover — real package pivots always nest under their 'Package' root — so this can never touch
   *  legitimate content. Returns the count removed. Called after {@link restoreFromJSON} adoption so
   *  a legacy reload collapses to exactly ONE 'Package' outliner node instead of loose
   *  Package/Front/Right/Back/Left siblings. Optional (legacy hosts skip the cleanup). */
  pruneLoosePackageNodes?(keepIds: string[]): number;

  // ── PACKAGE LAYER STACK hooks (Parts 1/2 — all optional; legacy hosts keep the single dieline) ──
  /** Layer-stack operations, implemented by the host over its raster-layer system + the shared 2D
   *  compositor. The MANAGER owns the stack ORDER + the active layer (persisted params); the host
   *  owns layer content/metadata (ordinary doc layers tagged `{systemOwner:'packaging',
   *  packageOwnerId}`, hidden from the host Layers panel exactly like the dieline) and the
   *  offscreen COMPOSITE the panels live-texture from. */
  stack?: {
    /** Create a new tagged, composite-hidden RASTER paint layer for `packageId`. */
    addRasterLayer(packageId: string, name: string): string | null;
    /** Create a new tagged VECTOR layer for `packageId` (ephemera/text/logos placed with the normal
     *  illustration tools; rendered into the composite via a raster proxy). */
    addVectorLayer(packageId: string, name: string): string | null;
    /** Adopt an EXISTING layer into `packageId`'s stack (tag `packageOwnerId` — the legacy-dieline
     *  migration path). */
    adopt(packageId: string, layerId: string): void;
    /** Layer metadata for the stack readout. Null when the layer no longer exists. */
    info(layerId: string): { name: string; visible: boolean; opacity: number; kind: 'raster' | 'vector' } | null;
    setVisible(layerId: string, visible: boolean): void;
    setOpacity(layerId: string, opacity: number): void;
    rename(layerId: string, name: string): void;
    /** Delete the layer outright (the manager has already removed it from the stack order). */
    remove(layerId: string): boolean;
    /** (Re)wire `packageId`'s panels to live-texture from a COMPOSITE of the ordered stack
     *  (`getStack` is LIVE — order/visibility/opacity are re-read on every recomposite). Also
     *  recomposites immediately. Safe to re-call after panel rebuilds or stack changes. */
    linkComposite(packageId: string, panelMeshIds: string[], getStack: () => { layerIds: string[] }): void;
    /** Drop the composite wiring for `packageId` (panels fall back to their layer link, if any). */
    unlinkComposite(packageId: string): void;
    /** Recomposite `packageId`'s stack into its composite target now. */
    recomposite(packageId: string): void;
    /** Export the FLATTENED stack composite as a PNG (the print/export surface). */
    exportPng(packageId: string): Promise<Blob | null>;
  };
}

/** §4.1 stage-background options — structurally identical to the engine's ArmatureBgOptions (the
 *  focus-background system the mode reuses); declared locally so the packaging module stays free of
 *  engine imports. The host's theme picker offers: 'gradient' (the studio default), 'wavy' (the
 *  signature animated bg), 'solid', 'checkers', 'dim', 'none'. */
export interface StageBackgroundOpts {
  mode: 'wavy' | 'solid' | 'gradient' | 'checkers' | 'dim' | 'none';
  /** Primary colour [r,g,b,a] — background / top of gradient / wave colour 1. */
  color1?: [number, number, number, number];
  /** Secondary colour [r,g,b,a] — stripe / bottom of gradient / wave colour 2. */
  color2?: [number, number, number, number];
  /** Darkness for 'dim' mode, 0–1. */
  dimStrength?: number;
}

/** The neutral STUDIO default (§4.1): a soft light-grey vertical gradient — product-shot lighting,
 *  nothing competing with the box. The wavy background becomes an opt-in theme. */
export const STUDIO_STAGE_BG: StageBackgroundOpts = {
  mode: 'gradient',
  color1: [0.945, 0.950, 0.965, 1],   // near-white cool grey (top)
  color2: [0.775, 0.795, 0.835, 1],   // soft slate grey (bottom — subtle vertical falloff)
};

/** §4.1 contact-shadow placement, in package-ROOT group-local units (the root stays scale 1 —
 *  mm→world is baked into the panels, so these are computeFoldWorldCorners(…, MM_TO_WORLD) units). */
export interface StageShadowPlacement {
  x: number; y: number; z: number;
  radiusX: number; radiusZ: number;
}

/** §4.2 board presets. */
export type BoardPresetId = 'white' | 'kraft';

/** What {@link PackagingHost.applyPanelMaterial} receives per panel (§4.2): the preset's base colour
 *  plus the boardShade shading params (paper grain under the artwork; darkened rim at the panel's
 *  UV-rect borders so panels read as thick board). */
export interface PanelBoardMaterial {
  preset: BoardPresetId;
  diffuse: { r: number; g: number; b: number };
  /** Fiber-grain amplitude 0..1 (modulates the BASE colour only, never the painted artwork). */
  grain: number;
  /** Edge-rim darkening 0..1 at the very panel border. */
  rimStrength: number;
  /** This panel's axis-aligned bounds in the dieline texture UV — [u0, v0, u1, v1]. */
  uvRect: [number, number, number, number];
  /** Rim width in dieline-UV units per axis (≈{@link BOARD_RIM_MM} mm over the net extent). */
  rimUV: [number, number];
}

/** Board-edge rim width (mm) translated into UV units per panel. */
const BOARD_RIM_MM = 1.6;

const BOARD_PRESETS: Record<BoardPresetId, { diffuse: { r: number; g: number; b: number }; grain: number; rimStrength: number }> = {
  // White coated (SBS) — the existing default base, faint grain, gentle rim.
  white: { diffuse: { r: 0.96, g: 0.95, b: 0.93 }, grain: 0.06, rimStrength: 0.10 },
  // Kraft — the original kraft brown, visibly more fiber + a firmer edge.
  kraft: { diffuse: { r: 0.66, g: 0.50, b: 0.34 }, grain: 0.16, rimStrength: 0.16 },
};

/** easeInOutCubic — the §4.3 motion easing (fold/unfold tween + the host camera drift-in). */
export function easeInOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Params-only persisted form of one package (rides in the document's scene3d JSON — the
 *  characters/buildings pattern: geometry/nodes persist via the scene graph, this re-binds them). */
export interface PackagingPersistEntry {
  /** Root container node id (== package id). */
  id: string;
  style: BoxStyle;
  params: DielineParams;
  foldAmount: number;
  dielineLayerId?: string;
  /** Template-ordered panel node ids (index-aligned with the style template's panel list). */
  panels: { meshId: string; pivotNodeId: string }[];
  /** True when this package was the CREATOR box (enterCreatorMode's reuse handle) at save time —
   *  restore re-establishes the handle so re-entering the mode reuses this box, never a duplicate. */
  wasCreator?: boolean;
  /** Ordered LAYER STACK (bottom→top; raster + vector layer ids). The layers themselves persist as
   *  ordinary doc layers (tagged); this is only the package's ORDER over them. Absent = legacy
   *  single-dieline package (a stack is bootstrapped from `dielineLayerId` on next creator enter). */
  layers?: string[];
  /** The stack layer painting targets (must be a RASTER layer to be paintable). */
  activeLayerId?: string;
  /** §4.2 board preset (absent = 'white', the historical default). */
  board?: BoardPresetId;
  /** The package ROOT container's FULL local 3D transform (position + Euler rotation + scale) at save
   *  time. The root is a `documentSkipChildren` procedural marker, and recreateNode's '3DMeshGroup'
   *  branch does NOT restore a MeshGroup's transform (unlike buildings, which re-apply theirs) — so a
   *  moved/rotated/scaled package would snap back to the origin on reload without this. Read LIVE from
   *  the node on every {@link PackagingManager.serialize}/marker stamp (so a bare gizmo drag persists),
   *  and re-applied to the root on restore. Absent/identity = no-op (back-compat with older saves). */
  transform?: PackagingTransform;
}

/** A package ROOT container's local 3D transform (mirrors the fields MeshGroup3D exposes). */
export interface PackagingTransform {
  x: number; y: number; z: number;
  /** Euler rotations (radians). `rotation` is the Z rotation, matching MeshGroup3D's field naming. */
  rotationX: number; rotationY: number; rotation: number;
  scaleX: number; scaleY: number; scaleZ: number;
}

/** True for the do-nothing transform (origin, no rotation, unit scale) — omitted from entries + a
 *  no-op on restore so older saves and unmoved packages carry no transform field. */
function isIdentityPackagingTransform(t: PackagingTransform): boolean {
  return t.x === 0 && t.y === 0 && t.z === 0 &&
         t.rotationX === 0 && t.rotationY === 0 && t.rotation === 0 &&
         t.scaleX === 1 && t.scaleY === 1 && t.scaleZ === 1;
}

/**
 * The SELF-DESCRIBING marker stamped onto a package ROOT container's `worldParams` (the
 * Building/Foliage pattern). It rides through the document's sceneGraphJSON on the
 * `documentSkipChildren` thin-wrapper root, so a reloaded package is re-adoptable from the scene
 * graph ALONE — no separate persisted array required. `entry` carries everything
 * {@link PackagingManager.serialize} emits per package; a legacy marker may carry only `kind` (it
 * falls back to the structural orphan sweep on restore).
 */
export interface PackagingMarker {
  kind: 'packaging';
  entry?: PackagingPersistEntry;
}

export type BoxStyle = 'simpleBox' | 'tuckEnd' | 'sleeve' | 'rollEndMailer' | 'rigidTwoPiece';

const TEMPLATES: Record<BoxStyle, (p: DielineParams) => DielineResult> =
  { simpleBox, tuckEnd, sleeve, rollEndMailer, rigidTwoPiece };

/** Same panel-set TOPOLOGY? (count + ids + parent links + corner counts.) The in-place
 *  re-dimension fast path is only safe when the node hierarchy SHAPE is unchanged — a template
 *  param that re-parents a panel (tuckEnd's `tuckStyle` flips the bottom closure front↔back)
 *  keeps the panel COUNT identical, so length alone would fast-path onto stale node parenting. */
function sameTopology(a: FoldPanel[], b: FoldPanel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].parentPanelIndex !== b[i].parentPanelIndex ||
        a[i].corners.length !== b[i].corners.length) return false;
  }
  return true;
}

export interface PackagingState {
  /** Packaging id — equals the box's root container node id. */
  id: string;
  /** The box's root container node id (== id). Kept as `meshId` for the debug/host readout. */
  meshId: string;
  /** The rigid-panel node hierarchy (root container + per-panel pivot/mesh ids). */
  box: PackagingBox;
  style: BoxStyle;
  params: DielineParams;
  foldMeshData: FoldMeshData;
  /** 0 = flat dieline, 1 = closed box. */
  foldAmount: number;
  /** Dieline canvas size (px) — the editor sizes the document to this. */
  canvasWidth: number;
  canvasHeight: number;
  /** Cut / fold / bleed guide lines (canvas px) for the editor overlay. */
  guides: DielineGuide[];
  /** panelId → display name. */
  panelLabels: Record<string, string>;
  /** The raster layer live-textured onto the box (the dieline canvas), if linked. With a layer
   *  STACK this is kept pointing at the stack's base (first) RASTER layer for back-compat. */
  dielineLayerId?: string;
  /** Ordered layer stack (bottom→top). Undefined until the stack is bootstrapped (legacy path). */
  layers?: string[];
  /** The paint-target stack layer. Vector layers can be active too ('place' mode) — painting is
   *  then disarmed and the box click-pick suppression lifts (see isActiveLayerPaintable). */
  activeLayerId?: string | null;
  /** §4.2 board preset ('white' default). Persisted with the package params. */
  board?: BoardPresetId;
}

/** Options for {@link PackagingManager.enterEditor}. */
export interface EnterEditorOpts {
  /** Existing dieline raster layer id to reuse on restore. Omit → a fresh "Dieline" layer is created. */
  layerId?: string;
  /** Frame + orbit the box on open (default true). Pass false to keep the current camera. */
  frame?: boolean;
}

/** What {@link PackagingManager.enterEditor} hands back to the host to drive the editor UI. */
export interface EditorHandle {
  /** The box's root container node id (frame/orbit target). */
  meshId: string;
  /** Dieline canvas size (px) — size the document + guide overlay to this. */
  canvasWidth: number;
  canvasHeight: number;
  /** The linked dieline raster layer (draw here on the flat artboard; also painted from the 3D box). */
  dielineLayerId: string | null;
  guides: DielineGuide[];
}

/** Options for {@link PackagingManager.enterCreatorMode}. */
export interface CreatorModeOpts {
  /** Box dimensions. Fresh enter: the box is created with these. Re-enter: the box is re-dimensioned. */
  params?: DielineParams;
  /** Box style. Fresh enter: the box is created with it (default 'simpleBox'). Re-enter/targeting an
   *  EXISTING box with a DIFFERENT style: the box is CONVERTED via {@link PackagingManager.setStyle}
   *  (topology rebuild — the package id changes; artwork layers are kept but remap onto the new net's
   *  UVs). Same style (or omitted) = no-op. */
  style?: BoxStyle;
  /** Enter the mode targeting THIS existing package (e.g. an {@link PackagingManager.addPackage} box the
   *  user selected — resolve the selection via {@link PackagingManager.isPackageNode}) instead of
   *  create-or-reuse-the-previous-creator-box. Unknown/stale ids are ignored (normal enter). */
  packageId?: string;
}

/** One panel's identity + UV rect for the host's pane overlay (labels / dim-outside-the-net). */
export interface DielinePanePanel {
  id: string;
  /** Display name ("Front", "Lid", …) from the template's panelLabels. */
  label: string;
  /** The panel's axis-aligned UV bounds in the dieline texture, all within [0,1]. */
  uvRect: { u0: number; v0: number; u1: number; v1: number };
}

/** What {@link PackagingManager.attachDielinePane} hands back for the host's pane overlay.
 *
 *  LIVE handle: `uvToCanvas` is a closure over the CURRENT pane state (pan/zoom/letterbox/canvas
 *  size — never captured values), and `guides` / `panels` / `canvasWidth/Height` are getters over
 *  the current package state, so the same handle stays correct across pane resizes and
 *  `setDimensions`. The HOST must REDRAW its overlay after a pane-canvas resize and after
 *  `setDimensions` (the mapping/guides changed — the handle is current, the host's pixels aren't). */
export interface DielinePaneHandle {
  /** UV [0,1] → pane canvas BACKING-STORE px (honours the pane's pan/zoom + letterbox). Guide
   *  points are dieline-canvas px, so: `uvToCanvas(px / canvasWidth, py / canvasHeight)`.
   *  LIVE — reads the pane's current state on every call; safe to keep across resizes. */
  uvToCanvas: (u: number, v: number) => [number, number];
  /** Cut / fold / bleed / panel guides (dieline-canvas px) to overlay on the pane. LIVE getter. */
  readonly guides: DielineGuide[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Per-panel UV rects + labels (LIVE getter) — draw panel names on the pane and/or dim outside
   *  the net so the pane reads as the package shape. */
  readonly panels: DielinePanePanel[];
  /** OPTIONAL host hook — set it to be notified after the pane canvas was LAYOUT-resized (view-mode
   *  switch 3D↔Split↔2D, panel resize): the backing store has been re-synced and the pane re-rendered
   *  by the time it fires, so REDRAW YOUR OVERLAY in it (`uvToCanvas` is live — the mapping already
   *  moved; your previously drawn pixels did not). No-op if left unset. */
  onPaneResize?: () => void;
}

/** Snapshot for the host's Package Creator panel — see {@link PackagingManager.getCreatorState}. */
export interface CreatorState {
  /** True while creator mode is entered (orbit + surface paint armed). */
  active: boolean;
  /** The creator box's packaging id (persists across exit so re-enter reuses it), or null. */
  packageId: string | null;
  /** The creator box's template style (any {@link BoxStyle}), or null. */
  style: BoxStyle | null;
  params: DielineParams | null;
  foldAmount: number;
  dielineLayerId: string | null;
  guides: DielineGuide[];
}

/** mm → world-unit scale applied to the box's ROOT container (all panels inherit it). */
const MM_TO_WORLD = 0.02;

/** Default box for `enterCreatorMode()` with no params (mm). */
const DEFAULT_CREATOR_PARAMS: DielineParams = { width: 80, height: 60, depth: 40, bleed: 3 };

export class PackagingManager {
  private items = new Map<string, PackagingState>();
  private anim = new Map<string, number>();   // id → rAF handle
  private creatorId: string | null = null;    // the creator-mode box (survives exit → re-enter reuses)
  private creatorActive = false;
  /** The creator target's scene ROTATION, captured on enter and ZEROED (lay the box flat for editing);
   *  restored on exit. Position/scale are left as placed. null when not flattened. */
  private _creatorSavedRot: { rootId: string; rotationX: number; rotationY: number; rotation: number } | null = null;
  /** Creator-mode ISOLATION: packageId → its visibility BEFORE the mode hid it (restored on exit). */
  private isolationPrev = new Map<string, boolean>();
  /** §4.1 stage THEME the host picked via {@link setStageBackground} (null = the studio default). */
  private stageBgTheme: StageBackgroundOpts | null = null;
  /** The user's background BEFORE the mode swapped it in — restored on exit. */
  private stagePrevBg: StageBackgroundOpts | null = null;
  /** §4.1 contact-shadow node (creator-mode stage prop; one, under the creator target's root). */
  private stageShadowId: string | null = null;
  private stageShadowPkg: string | null = null;

  constructor(private host: PackagingHost) {}

  // ── §4.1 Studio stage: background + contact shadow ─────────────────────────────────────────────

  /** Pick the stage background THEME (studio gradient by default; offer 'wavy'/'checkers'/'solid'…
   *  — see {@link StageBackgroundOpts}). Applied immediately while the mode is active, remembered
   *  for future enters. The user's own background is still restored on exit. */
  setStageBackground(opts: StageBackgroundOpts): void {
    this.stageBgTheme = { ...opts };
    if (this.creatorActive) this.host.setStageBackground?.(this.stageBgTheme);
  }

  /** The stage theme currently in effect (the studio default until the host picks one). */
  getStageBackground(): StageBackgroundOpts {
    return { ...(this.stageBgTheme ?? STUDIO_STAGE_BG) };
  }

  /** Apply the stage background on mode enter, capturing the user's background ONCE per mode
   *  session (a target switch while active must not capture the studio bg as "previous"). */
  private _applyStageBg(): void {
    if (!this.host.setStageBackground) return;
    if (!this.creatorActive) this.stagePrevBg = this.host.getStageBackground?.() ?? { mode: 'wavy' };
    this.host.setStageBackground(this.stageBgTheme ?? STUDIO_STAGE_BG);
  }

  private _restoreStageBg(): void {
    if (this.stagePrevBg) this.host.setStageBackground?.(this.stagePrevBg);
    this.stagePrevBg = null;
  }

  /** Contact-shadow placement from the CURRENT fold pose's footprint (group-local units): at fold 0
   *  it hugs the flat net, at fold 1 the closed box — the blob tracks whatever is on the ground. */
  private _shadowPlacement(s: PackagingState): StageShadowPlacement {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const corners of computeFoldWorldCorners(s.foldMeshData.panels, s.foldAmount, MM_TO_WORLD)) {
      for (const [x, y, z] of corners) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    }
    if (x0 > x1) return { x: 0, y: -0.012, z: 0, radiusX: 1, radiusZ: 1 };
    const pad = 6 * MM_TO_WORLD;   // soft spill past the footprint (the penumbra allowance)
    return {
      x: (x0 + x1) / 2, y: y0 - 0.012, z: (z0 + z1) / 2,   // just under the lowest point (no z-fight)
      radiusX: (x1 - x0) / 2 * 1.18 + pad,
      radiusZ: (z1 - z0) / 2 * 1.18 + pad,
    };
  }

  /** Create/refresh the contact shadow for the ACTIVE creator target (no-op otherwise). */
  private _syncStageShadow(s: PackagingState): void {
    if (!this.creatorActive || this.creatorId !== s.id || !this.host.createStageShadow) return;
    if (this.stageShadowId && this.stageShadowPkg !== s.id) this._removeStageShadow();   // target switched
    const p = this._shadowPlacement(s);
    if (!this.stageShadowId) {
      this.stageShadowId = this.host.createStageShadow(s.box.rootGroupId, p);
      this.stageShadowPkg = this.stageShadowId ? s.id : null;
    } else {
      this.host.updateStageShadow?.(this.stageShadowId, p);
    }
  }

  private _removeStageShadow(): void {
    if (this.stageShadowId) this.host.removeStageShadow?.(this.stageShadowId);
    this.stageShadowId = null;
    this.stageShadowPkg = null;
  }

  // ── §4.2 Board material ────────────────────────────────────────────────────────────────────────

  /** Choose the board stock ('white' coated | 'kraft'). Live re-tint + grain/rim update on every
   *  panel; persisted with the package params. */
  setBoardPreset(id: string, preset: BoardPresetId): boolean {
    const s = this.items.get(id);
    if (!s || !BOARD_PRESETS[preset]) return false;
    s.board = preset;
    this._applyBoardMaterials(s);
    this._stampMarker(s);   // §4.2 board preset persisted in the marker
    this.host.scheduleRender();
    return true;
  }

  getBoardPreset(id: string): BoardPresetId | null {
    const s = this.items.get(id);
    return s ? (s.board ?? 'white') : null;
  }

  /** The §4.2 per-panel material payload (preset base + grain + edge-rim over this panel's UV rect). */
  private _boardMaterial(s: PackagingState, panelIndex: number): PanelBoardMaterial {
    const preset = s.board ?? 'white';
    const b = BOARD_PRESETS[preset];
    const p = s.foldMeshData.panels[panelIndex];
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const [u, v] of p?.uvs ?? []) {
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    if (u0 > u1) { u0 = 0; v0 = 0; u1 = 1; v1 = 1; }
    return {
      preset, diffuse: b.diffuse, grain: b.grain, rimStrength: b.rimStrength,
      uvRect: [u0, v0, u1, v1],
      rimUV: [BOARD_RIM_MM / Math.max(s.foldMeshData.dielineWidth, 1e-3),
              BOARD_RIM_MM / Math.max(s.foldMeshData.dielineHeight, 1e-3)],
    };
  }

  /** (Re-)assert the board material on every panel (create, preset change, re-dimension — the UV
   *  rects move with the net, so the rim/grain params must track it). */
  private _applyBoardMaterials(s: PackagingState): void {
    if (!this.host.applyPanelMaterial) return;
    for (let i = 0; i < s.box.panels.length; i++) {
      this.host.applyPanelMaterial(s.box.panels[i].meshId, this._boardMaterial(s, i));
    }
  }

  /**
   * Add a package to the scene as a FIRST-CLASS OBJECT — the Outliner "Add Mesh > Package…" entry.
   * Creates the box hierarchy WITHOUT entering creator mode (no framing, no stage, no paint arming,
   * no dieline layer). The root behaves like the City thin-wrapper: ONE outliner node, clicking any
   * panel selects the package as a unit, the gizmo moves the whole box. To edit/paint it later, call
   * {@link enterCreatorMode} with `{ packageId: state.id }`.
   */
  addPackage(params?: DielineParams, style: BoxStyle = 'simpleBox'): PackagingState {
    const s = this.create(style, params ?? { ...DEFAULT_CREATOR_PARAMS });
    // §4.2: an Outliner-added box gets the board read immediately (no dieline link to carry it —
    // enterCreatorMode's link path re-asserts it there, exactly once per (re)link).
    this._applyBoardMaterials(s);
    // Start CLOSED so the box reads as a 3D object the moment it's added: the flat net (fold 0) is a
    // paper-thin sheet that's edge-on / invisible at the illustration camera angle. The user scrubs
    // to unfold; creator mode frames it either way.
    this.setFoldAmount(s.id, 1);
    return s;
  }

  /**
   * Resolve ANY node id inside a package (panel mesh, hinge pivot, or the root container) to its
   * package id — null for non-package nodes. Lets the host answer "is the current selection a
   * package?" (selection resolves to the ROOT via the thin-wrapper walk, but panel/pivot ids from
   * other paths resolve too) and show its "Package Mode" button.
   */
  isPackageNode(nodeId: string): string | null {
    if (!nodeId) return null;
    for (const s of this.items.values()) {
      if (s.box.rootGroupId === nodeId) return s.id;
      for (const p of s.box.panels) if (p.meshId === nodeId || p.pivotNodeId === nodeId) return s.id;
    }
    return null;
  }

  /** Group-local AABB of the geometry AT THE CURRENT FOLD POSE — sizes the unit-wrapper selection
   *  box/gizmo TIGHT to what is actually on screen (the City cachedBounds pattern). A package has
   *  only ~10-13 panels, so this per-pose closed-form scan is cheap enough to refresh on every fold
   *  scrub / re-dimension. This replaces the old whole-fold-range UNION, which unioned the FLAT NET
   *  extent (huge — the unfolded dieline spans W+2H etc.) into the bounds, so a folded box showed a
   *  net-sized selection box (the "massive bounding box" bug). For `rigidTwoPiece` this still spans
   *  BOTH trays (all panels of both hierarchies share the one panel list). The root group sits at
   *  identity/scale 1 (the mm→world scale is baked into the panels), so net space IS group-local. */
  private poseBounds(panels: FoldPanel[], amount: number): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const corners of computeFoldWorldCorners(panels, Math.max(0, Math.min(1, amount)), MM_TO_WORLD)) {
      for (const [x, y, z] of corners) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    if (minX > maxX) return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  /** Refresh the unit-wrapper's cached selection/gizmo bounds to the CURRENT fold pose (BUG 2). The
   *  host's markUnitWrapper only re-notifies the scene graph on the thin-wrapper flag FLIP, so a
   *  bounds-only refresh here is cheap — safe to call on every fold/dimension change. */
  private _refreshUnitBounds(s: PackagingState): void {
    this.host.markUnitWrapper?.(s.box.rootGroupId, this.poseBounds(s.foldMeshData.panels, s.foldAmount));
  }

  /** Create a packaging box from a style + dimensions (starts flat) as a rigid-panel node hierarchy. */
  create(style: BoxStyle, params: DielineParams, name = 'Package'): PackagingState {
    const r = TEMPLATES[style](params);
    // BUG 1 (addPackage invisible in the Outliner until the next mesh) — match how Building/Foliage/
    // Block work: create the ROOT thin-wrapper FIRST and let the host ANNOUNCE it immediately as an
    // empty container (createUnitRoot → createCityContainer + scene-graph-changed), so the Outliner
    // shows "Package" right away. The ~13 panels are then built UNDER that existing root, batched into
    // ONE further emit so the per-node adds don't thrash the list.
    const preRootId = this.host.createUnitRoot?.(name);
    this.host.beginSceneGraphBatch?.();
    let state: PackagingState;
    try {
      const box = buildBoxNodes(r.foldMeshData.panels, this.host, { name, scale: MM_TO_WORLD, existingRootId: preRootId });
      // Every package is a select-as-a-unit wrapper (City pattern) — one outliner node, whole-box gizmo.
      // Bounds are TIGHT to the flat (fold 0) pose the box starts in (BUG 2 — no net-union blowup).
      this.host.markUnitWrapper?.(box.rootGroupId, this.poseBounds(r.foldMeshData.panels, 0));
      state = {
        id: box.rootGroupId, meshId: box.rootGroupId, box, style, params, foldMeshData: r.foldMeshData, foldAmount: 0,
        canvasWidth: r.canvasWidth, canvasHeight: r.canvasHeight, guides: r.guides, panelLabels: r.panelLabels,
      };
      this.items.set(state.id, state);
      this._stampMarker(state);   // self-describing marker in place from the very first frame
      // Final flush of the batched panel adds (the pre-root already announced the node itself).
      this.host.notifySceneGraphChanged?.();
    } finally {
      this.host.endSceneGraphBatch?.();   // fires the single coalesced emit
    }
    this.host.scheduleRender();
    return state;
  }

  /** Regenerate the net at new dimensions, preserving the current fold amount (the procedural slider path).
   *  Panel geometry changes with W/H/D, so this rebuilds the hierarchy (remove old subtree → build new).
   *  Returns the updated state (new guides + canvas size) so the host can redraw the overlay immediately. */
  setDimensions(id: string, params: DielineParams): PackagingState | null {
    const s = this.items.get(id);
    if (!s) return null;
    // FAST PATH — same style/topology: swap panel geometry + pivot placements IN PLACE (no node teardown,
    // no outliner/picker churn — the slider-drag lag fix). Ids + live-texture links all stay valid.
    // DIELINE↔MESH SYNC: net + UVs + guides + panelLabels regenerate TOGETHER from the one template
    // call, so the overlay/pane and the 3D box can never disagree. A topology change (e.g. tuckStyle)
    // falls through to the clean rebuild below.
    {
      const r2 = TEMPLATES[s.style](params);
      if (this.host.setPanelGeometry &&
          sameTopology(s.foldMeshData.panels, r2.foldMeshData.panels) &&
          updateBoxDimensions(s.box, r2.foldMeshData.panels, this.host, { scale: MM_TO_WORLD })) {
        s.params = params;
        s.foldMeshData = r2.foldMeshData;
        s.canvasWidth = r2.canvasWidth; s.canvasHeight = r2.canvasHeight; s.guides = r2.guides; s.panelLabels = r2.panelLabels;
        setBoxFold(s.box, s.foldAmount, this.host);   // keep the current fold on the new dimensions
        this._refreshUnitBounds(s);                    // refresh gizmo bounds at the CURRENT pose (flag already set → no re-notify)
        this._applyBoardMaterials(s);                 // §4.2: panel UV rects moved with the net
        this._syncStageShadow(s);                     // §4.1: footprint tracks the new dims
        this._stampMarker(s);                         // refresh the marker with the new dims
        this.host.scheduleRender();
        return s;
      }
    }
    return this._rebuild(s, params);
  }

  /**
   * Convert an EXISTING package to a different box STYLE — the host style-dropdown path (there was
   * previously NO style-change API: `setDimensions` regenerates with the stored style and the enter
   * option was create-time only). A style change is a TOPOLOGY change by definition, so it always
   * takes the clean-rebuild path (same contract as a tuckStyle/lockTabs flip): the old node
   * hierarchy is fully removed, a new one is built, **the package id changes** (use the returned
   * state's `id`), the dieline layer + layer-stack composite re-link, surface paint re-arms if
   * creator mode is live on this box, and the thin-wrapper/unit bounds re-mark. The fold amount is
   * PRESERVED (the global fold scalar is style-agnostic — every template stages itself over the
   * same 0..1); artwork layers are kept as-is, but placement WILL remap since the new net authors
   * different UVs (inherent to changing the dieline). Returns null for unknown ids/styles.
   */
  setStyle(id: string, style: BoxStyle): PackagingState | null {
    const s = this.items.get(id);
    if (!s || !TEMPLATES[style]) return null;
    if (s.style === style) return s;
    s.style = style;
    return this._rebuild(s, s.params);
  }

  /** The CLEAN-REBUILD path shared by setDimensions (topology change) and setStyle: tear down the
   *  old hierarchy, build a fresh one from the current style + `params`, re-link everything. */
  private _rebuild(s: PackagingState, params: DielineParams): PackagingState {
    const dielineLayerId = s.dielineLayerId;
    const oldId = s.id;
    // BUG 1: coalesce the teardown + rebuild emit storm into ONE final scene-graph-changed.
    this.host.beginSceneGraphBatch?.();
    // Tear down the old hierarchy (unlink live textures first) and build a fresh one for the new dims.
    if (dielineLayerId) for (const p of s.box.panels) this.host.unlinkLiveTexture(p.meshId);
    this.host.removeNode(s.box.rootGroupId);
    this.items.delete(s.id);
    // §4.1: the contact shadow was a child of the removed root — its node died with the subtree.
    if (this.stageShadowPkg === oldId) { this.stageShadowId = null; this.stageShadowPkg = null; }

    s.params = params;
    const r = TEMPLATES[s.style](params);
    s.foldMeshData = r.foldMeshData;
    s.canvasWidth = r.canvasWidth; s.canvasHeight = r.canvasHeight; s.guides = r.guides; s.panelLabels = r.panelLabels;
    s.box = buildBoxNodes(r.foldMeshData.panels, this.host, { name: 'Package', scale: MM_TO_WORLD });
    this.host.markUnitWrapper?.(s.box.rootGroupId, this.poseBounds(r.foldMeshData.panels, s.foldAmount));
    s.id = s.box.rootGroupId; s.meshId = s.box.rootGroupId;
    this.items.set(s.id, s);
    if (this.creatorId === oldId) this.creatorId = s.id;   // keep the creator handle tracking the rebuilt box
    // Keep isolation bookkeeping tracking the rebuilt box (a hidden package re-dimensioned mid-mode).
    if (this.isolationPrev.has(oldId)) {
      this.isolationPrev.set(s.id, this.isolationPrev.get(oldId)!);
      this.isolationPrev.delete(oldId);
    }
    // Re-apply the current fold + re-link the dieline layer onto the new panel meshes.
    setBoxFold(s.box, s.foldAmount, this.host);
    if (dielineLayerId) { s.dielineLayerId = dielineLayerId; for (const p of s.box.panels) this.host.linkLiveTexture(p.meshId, dielineLayerId); }
    this._applyBoardMaterials(s);            // §4.2: fresh panel meshes need the board contract
    // Layer stack: the composite was keyed by the OLD package id and wired to the OLD panel
    // meshes — re-key + re-link against the rebuilt hierarchy. ★Re-tag every stack layer's
    // packageOwnerId to the NEW id too: the host's vector-layer change subscription
    // (_pkgVectorLayerDirty) resolves the package via the layer's packageOwnerId, so a stale
    // (old-id) owner after a dims/style rebuild would silently stop vector placements from
    // recompositing onto the box (the composite is now keyed by the new id).
    if (s.layers?.length && this.host.stack) {
      this.host.stack.unlinkComposite(oldId);
      for (const layerId of s.layers) this.host.stack.adopt(s.id, layerId);
      this._linkStackComposite(s);
    }
    // Creator mode live on this box → RE-ARM surface painting on the NEW panel meshes (the old
    // arming pointed at the removed meshes — a tuckStyle rebuild mid-mode would leave paint dead).
    this._syncPaintArm(s);
    this._syncStageShadow(s);                // §4.1: recreate the shadow under the NEW root
    this._stampMarker(s);                    // marker carries the new style/params + fresh panel ids
    this.host.notifySceneGraphChanged?.();   // rebuilt hierarchy = new nodes — announce the final tree
    this.host.endSceneGraphBatch?.();        // fires the single coalesced emit
    this.host.scheduleRender();
    return s;
  }

  /** Set the fold position directly (0 flat → 1 folded) — pivot TRANSFORMS only, no geometry rebuild. */
  setFoldAmount(id: string, amount: number): void {
    const s = this.items.get(id);
    if (!s) return;
    s.foldAmount = Math.max(0, Math.min(1, amount));
    setBoxFold(s.box, s.foldAmount, this.host);
    this._refreshUnitBounds(s);   // BUG 2: selection/gizmo bounds track the LIVE fold pose (tight, not the net union)
    this._syncStageShadow(s);   // §4.1: the ground blob tracks the fold pose's footprint (cheap closed form)
    this._stampMarker(s);       // persist the new fold in the self-describing marker
    this.host.scheduleRender();
  }

  /** Live-texture a raster layer (the dieline canvas) onto EVERY panel → drawing on it shows on the box,
   *  flat OR folded (the net UVs map the canvas to each panel). Host syncs after strokes. */
  setDielineLayer(id: string, layerId: string): void {
    const s = this.items.get(id);
    if (!s) return;
    if (s.dielineLayerId) for (const p of s.box.panels) this.host.unlinkLiveTexture(p.meshId);
    s.dielineLayerId = layerId;
    for (let i = 0; i < s.box.panels.length; i++) {
      this.host.linkLiveTexture(s.box.panels[i].meshId, layerId);
      // Re-assert the panel material contract (board base + texOverBase + §4.2 grain/rim) on every
      // (re)link: panels restored from a saved document — or created before the contract existed —
      // keep whatever material was persisted, and the legacy multiply path renders a transparent
      // dieline BLACK.
      this.host.applyPanelMaterial?.(s.box.panels[i].meshId, this._boardMaterial(s, i));
    }
    this._stampMarker(s);   // dielineLayerId changed
    this.host.scheduleRender();
  }

  clearDielineLayer(id: string): void {
    const s = this.items.get(id);
    if (!s || !s.dielineLayerId) return;
    for (const p of s.box.panels) this.host.unlinkLiveTexture(p.meshId);
    s.dielineLayerId = undefined;
    this._stampMarker(s);
    this.host.scheduleRender();
  }

  // ── PACKAGE LAYER STACK (Part 1: raster stack · Part 2: vector layers) ─────────────────────────
  // The manager owns the ORDER (bottom→top) + the active layer; the host owns layer content and the
  // offscreen composite the panels live-texture from. The legacy single 'Dieline' layer becomes the
  // stack's BASE layer on first use (migration is lazy + idempotent). Without the optional
  // `host.stack` hooks everything below no-ops and the single-dieline path keeps working.

  /** Bootstrap the stack from the legacy dieline (idempotent). False when unsupported. */
  private _ensureStack(s: PackagingState): boolean {
    const st = this.host.stack;
    if (!st) return false;
    if (!s.layers || s.layers.length === 0) {
      if (!s.dielineLayerId) return false;              // no base yet (never linked)
      s.layers = [s.dielineLayerId];
      s.activeLayerId = s.dielineLayerId;
      st.adopt(s.id, s.dielineLayerId);                 // tag packageOwnerId on the legacy layer
    }
    return true;
  }

  /** Prune dead layer ids + repair the base/active invariants (dieline = first RASTER layer;
   *  active must be a member — defaults to the top-most raster layer). */
  private _normalizeStack(s: PackagingState): void {
    const st = this.host.stack;
    if (!st || !s.layers) return;
    s.layers = s.layers.filter(l => st.info(l) !== null);
    const rasters = s.layers.filter(l => st.info(l)?.kind === 'raster');
    s.dielineLayerId = rasters[0] ?? s.dielineLayerId;
    if (!s.activeLayerId || !s.layers.includes(s.activeLayerId)) {
      s.activeLayerId = rasters.length ? rasters[rasters.length - 1] : (s.layers[0] ?? null);
    }
  }

  /** Wire the panels to the live stack COMPOSITE (also recomposites). Keyed by the CURRENT s.id. */
  private _linkStackComposite(s: PackagingState): void {
    const st = this.host.stack;
    if (!st || !s.layers?.length) return;
    st.linkComposite(s.id, s.box.panels.map(p => p.meshId), () => ({ layerIds: (s.layers ?? []).slice() }));
  }

  /** The stack layer painting should target: the ACTIVE layer when it is raster; null while a
   *  VECTOR layer is active ('place' mode — surface paint disarms so the illustration tools own
   *  the pointer). Legacy (no stack): the dieline. */
  private _paintLayerId(s: PackagingState): string | null {
    if (s.layers?.length) {
      const a = s.activeLayerId;
      return a && s.layers.includes(a) && this.host.stack?.info(a)?.kind === 'raster' ? a : null;
    }
    return s.dielineLayerId ?? null;
  }

  /** Re-arm (or disarm) surface painting to match the active layer — only while creator mode is
   *  live on this package. */
  private _syncPaintArm(s: PackagingState): void {
    if (!this.creatorActive || this.creatorId !== s.id) return;
    const paintId = this._paintLayerId(s);
    if (paintId) this.host.armSurfacePaint(s.box.panels.map(p => p.meshId), paintId);
    else this.host.disarmSurfacePaint();
  }

  /**
   * BUG 3 — click-pick suppression for creator mode. True when a click landing on `nodeId` must be
   * IGNORED by click-to-select because it belongs to the package currently being EDITED. While
   * creator mode is active the target box is NEVER selected by a click, with ANY modifier: a plain
   * click falls through to surface paint, and an ALT click is orbit-only (the orbit controller
   * reads the raw pointer — it does not depend on the pick selecting anything). This is deliberately
   * INDEPENDENT of the active layer's paintability: a vector 'place' layer previously LIFTED
   * suppression, which let an alt-orbit click select (and yank the gizmo onto) the box — the bug.
   * Suppressing the pick does not steal the event (the host returns WITHOUT stopping propagation),
   * so the illustration tools still receive place-mode clicks. Only the creator TARGET is
   * suppressed; every OTHER package is hidden by isolation, so it cannot be picked anyway.
   */
  isPickSuppressed(nodeId: string): boolean {
    if (!this.creatorActive || !this.creatorId) return false;
    return this.isPackageNode(nodeId) === this.creatorId;
  }

  /** True when the creator target's ACTIVE layer is paintable (raster). Hosts use this to gate the
   *  box click-pick suppression: suppression (paint-owns-clicks) only while a RASTER layer is
   *  active; a VECTOR layer active = 'place' mode (normal illustration tools + selection). */
  isActivePaintable(): boolean {
    const s = this.creatorId ? this.items.get(this.creatorId) ?? null : null;
    if (!s || !s.layers?.length) return true;           // legacy path: paint always owns the box
    return this._paintLayerId(s) !== null;
  }

  /** Ensure the package has its base paint layer (creates + links a 'Dieline' when missing). */
  private _ensureBaseLayer(s: PackagingState): void {
    if (s.dielineLayerId || !this.host.stack) return;
    const id = this.host.stack.addRasterLayer(s.id, 'Dieline');
    if (id) this.setDielineLayer(s.id, id);
  }

  /** Add a RASTER paint layer on top of the stack; it becomes the active paint target. */
  addLayer(packageId: string, name?: string): { layerId: string } | null {
    const s = this.items.get(packageId);
    const st = this.host.stack;
    if (!s || !st) return null;
    this._ensureBaseLayer(s);
    if (!this._ensureStack(s)) return null;
    const layerId = st.addRasterLayer(packageId, name ?? `Layer ${s.layers!.length + 1}`);
    if (!layerId) return null;
    s.layers!.push(layerId);
    s.activeLayerId = layerId;
    this._linkStackComposite(s);
    this._syncPaintArm(s);
    this._stampMarker(s);
    this.host.scheduleRender();
    return { layerId };
  }

  /** Add a VECTOR layer on top of the stack (Part 2 — ephemera/text/logos live on the box). The
   *  new layer becomes ACTIVE ('place' mode: surface paint disarms; the host places vectors with
   *  the normal illustration tools while this layer is the doc's active vector layer). */
  addVectorLayer(packageId: string, name?: string): { layerId: string } | null {
    const s = this.items.get(packageId);
    const st = this.host.stack;
    if (!s || !st) return null;
    this._ensureBaseLayer(s);
    if (!this._ensureStack(s)) return null;
    const layerId = st.addVectorLayer(packageId, name ?? `Vector ${s.layers!.length + 1}`);
    if (!layerId) return null;
    s.layers!.push(layerId);
    s.activeLayerId = layerId;
    this._linkStackComposite(s);
    this._syncPaintArm(s);                              // vector active → paint disarms (place mode)
    this._stampMarker(s);
    this.host.scheduleRender();
    return { layerId };
  }

  /** The ordered stack (bottom→top) with live metadata. Bootstraps the stack on first call. */
  getLayerStack(packageId: string): { layerId: string; name: string; visible: boolean; opacity: number; active: boolean; kind: 'raster' | 'vector' }[] {
    const s = this.items.get(packageId);
    const st = this.host.stack;
    if (!s || !st) return [];
    if (!this._ensureStack(s)) return [];
    this._normalizeStack(s);
    return (s.layers ?? []).map(layerId => {
      const i = st.info(layerId)!;
      return { layerId, name: i.name, visible: i.visible, opacity: i.opacity, active: layerId === s.activeLayerId, kind: i.kind };
    });
  }

  /** Set the paint/place target layer. Raster → surface paint re-arms on it; vector → paint
   *  disarms ('place' mode) and the box click-pick suppression lifts (see isActivePaintable). */
  setActiveLayer(packageId: string, layerId: string): boolean {
    const s = this.items.get(packageId);
    if (!s || !this._ensureStack(s) || !s.layers!.includes(layerId)) return false;
    s.activeLayerId = layerId;
    this._syncPaintArm(s);
    this._stampMarker(s);
    this.host.scheduleRender();
    return true;
  }

  setLayerVisible(packageId: string, layerId: string, visible: boolean): boolean {
    const s = this.items.get(packageId);
    const st = this.host.stack;
    if (!s || !st || !s.layers?.includes(layerId)) return false;
    st.setVisible(layerId, visible);
    st.recomposite(packageId);
    this.host.scheduleRender();
    return true;
  }

  setLayerOpacity(packageId: string, layerId: string, opacity: number): boolean {
    const s = this.items.get(packageId);
    const st = this.host.stack;
    if (!s || !st || !s.layers?.includes(layerId)) return false;
    st.setOpacity(layerId, Math.max(0, Math.min(1, opacity)));
    st.recomposite(packageId);
    this.host.scheduleRender();
    return true;
  }

  renameLayer(packageId: string, layerId: string, name: string): boolean {
    const s = this.items.get(packageId);
    const st = this.host.stack;
    if (!s || !st || !s.layers?.includes(layerId)) return false;
    st.rename(layerId, name);
    return true;
  }

  /** Move `layerId` to `toIndex` within the stack (0 = bottom; clamped). */
  reorderLayer(packageId: string, layerId: string, toIndex: number): boolean {
    const s = this.items.get(packageId);
    const st = this.host.stack;
    if (!s || !st || !s.layers) return false;
    const from = s.layers.indexOf(layerId);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(s.layers.length - 1, Math.floor(toIndex)));
    if (to === from) return true;
    s.layers.splice(from, 1);
    s.layers.splice(to, 0, layerId);
    this._normalizeStack(s);                            // base (= first raster) may have changed
    st.recomposite(packageId);
    this._stampMarker(s);
    this.host.scheduleRender();
    return true;
  }

  /** Remove a stack layer (deletes it). The LAST raster layer cannot be removed — the box always
   *  keeps one paint surface. Erased/removed content reveals the layers below; only the
   *  full-stack-empty area shows the bare board. */
  removeLayer(packageId: string, layerId: string): boolean {
    const s = this.items.get(packageId);
    const st = this.host.stack;
    if (!s || !st || !s.layers?.includes(layerId)) return false;
    const kind = st.info(layerId)?.kind;
    const rasters = s.layers.filter(l => st.info(l)?.kind === 'raster');
    if (kind === 'raster' && rasters.length <= 1) return false;   // keep ≥1 paint surface
    s.layers = s.layers.filter(l => l !== layerId);
    st.remove(layerId);
    this._normalizeStack(s);                            // repairs base + active
    st.recomposite(packageId);
    this._syncPaintArm(s);
    this._stampMarker(s);
    this.host.scheduleRender();
    return true;
  }

  /**
   * Open the full 3D-PAINT editor for a box in ONE call: size the doc to the dieline, ensure the
   * dieline raster layer is linked as the box's live texture, start FLAT, frame + orbit the box,
   * and arm 3D-surface painting on it. From here the DIELINE RASTER LAYER is the single source of
   * truth: flat drawing (normal raster tools on that layer) AND painting on the 3D box both write it,
   * the box live-textures from it, and print/PNG export is that layer. Idempotent-ish — safe to call
   * again after `setDimensions`. Returns the handle the host needs, or null if `id` is unknown.
   */
  enterEditor(id: string, opts: EnterEditorOpts = {}): EditorHandle | null {
    const s = this.items.get(id);
    if (!s) return null;
    // 1. Size the document to the dieline so flat artwork lands 1:1 on the net (print-accurate).
    this.host.setDocSize(s.canvasWidth, s.canvasHeight);
    // 2. Ensure the dieline layer + live-texture it onto the box (box.diffuse := layer texture).
    const layerId = this.host.ensureDielineLayer(s.dielineLayerId ?? opts.layerId);
    if (layerId) this.setDielineLayer(id, layerId);   // sets s.dielineLayerId + LiveTextureMode link
    // 3. Start flat (the dieline you draw on).
    this.setFoldAmount(id, 0);
    // 4. Put the box on-screen: frame the ROOT container + enable alt-orbit (left-drag paints, alt+left orbits).
    if (opts.frame !== false) this.host.frameAndOrbit(s.box.rootGroupId);
    // 5. Arm 3D-surface painting across ALL panels → a stroke raycasts whichever panel is hit, paints the SAME layer.
    if (s.dielineLayerId) this.host.armSurfacePaint(s.box.panels.map(p => p.meshId), s.dielineLayerId);
    this.host.scheduleRender();
    return { meshId: s.box.rootGroupId, canvasWidth: s.canvasWidth, canvasHeight: s.canvasHeight, dielineLayerId: s.dielineLayerId ?? null, guides: s.guides };
  }

  /** Close the editor: disarm 3D-surface painting + disable orbit controls. The dieline layer link,
   *  the box, and its fold state all persist (drawing still live-textures the box). */
  exitEditor(id: string): void {
    const s = this.items.get(id);
    if (!s) return;
    this.host.disarmSurfacePaint();
    this.host.stopOrbit();
    this.host.scheduleRender();
  }

  /**
   * PACKAGE CREATOR MODE — enter it from a NORMAL Illustration document (the Character-Creator /
   * City-Edit-Mode pattern; no bespoke route needed). Composes the existing editor pieces with two
   * deliberate differences from {@link enterEditor}:
   *  - NO `setDocSize` — the user's illustration document is theirs. The dieline layer is
   *    document-sized and artwork maps onto the box via the net UVs (so PNG export is doc-sized,
   *    NOT 1:1 print mm→px; use `enterEditor` for print-exact sizing).
   *  - IDEMPOTENT re-enter — reuses the existing creator box and dieline layer (the host's
   *    `ensureDielineLayerInfo` also reuses a layer already NAMED 'Dieline'), so re-entering never
   *    duplicates boxes or layers.
   * The dieline layer stays TRANSPARENT on fresh creation — the box composites it over the kraft
   * base (texOverBase: empty = blank cardboard, strokes read as painted on it); a reused layer is
   * never touched (artwork preserved). Pair with {@link exitCreatorMode}.
   */
  enterCreatorMode(opts: CreatorModeOpts = {}): CreatorState {
    // Stale-handle guard: the tracked box may be gone (document switch / node deleted externally).
    if (this.creatorId) {
      const prev = this.items.get(this.creatorId);
      if (!prev || (this.host.nodeExists && !this.host.nodeExists(prev.box.rootGroupId))) {
        if (prev) this.items.delete(prev.id);
        this.creatorId = null;
      }
    }
    // ADOPT-ALL-ORPHANS sweep — EVERY enter path, not just create: package-shaped roots OUTSIDE
    // the registry (strays saved during the old duplicate-box era, restored packages whose
    // persisted re-adoption failed to match) are structurally adopted UP FRONT, so `{packageId}`
    // targeting resolves them and the isolation pass covers them like any registered package.
    const sweep = this._adoptAllOrphans();
    // ── TARGET RESOLUTION (the only thing the entry paths differ in — everything after runs the
    // ONE shared `_enterOn` procedure, so the {packageId} path can never lag the create path):
    //  1. opts.packageId (Outliner "Package Mode"): accepts ANY package node id — root container,
    //     hinge pivot, or panel mesh (isPackageNode resolves them; hosts have handed us raw
    //     selection ids). An id that is package-SHAPED in the scene but missing from the registry
    //     (restored doc whose re-adoption didn't run) is structurally ADOPTED. If it still doesn't
    //     resolve, warn LOUDLY (non-throwing) and fall through — a silent fallback used to re-enter
    //     the PREVIOUS creator box no matter which package the user selected.
    //  2. else the previous creator box (idempotent re-enter reuse),
    //  3. else adopt an orphaned package root (defensive dedupe), else create a fresh box.
    let target: PackagingState | null = null;
    let created = false;
    if (opts.packageId) {
      const resolvedId = this.isPackageNode(opts.packageId);
      target = resolvedId ? this.items.get(resolvedId) ?? null : null;
      if (!target) {
        target = this._adoptStructural(opts.packageId, opts.style ?? 'simpleBox', opts.params ?? { ...DEFAULT_CREATOR_PARAMS });
      }
      if (target && this.host.nodeExists && !this.host.nodeExists(target.box.rootGroupId)) target = null;
      if (!target) {
        console.warn(
          `[Packaging] enterCreatorMode: packageId '${opts.packageId}' did not resolve to a live package — ` +
          `falling back to create-or-reuse (this targets the PREVIOUS creator box, not the selection). ` +
          `Known package ids: [${[...this.items.keys()].join(', ')}]`,
        );
      }
    }
    if (!target && this.creatorId) target = this.items.get(this.creatorId) ?? null;   // reuse — no duplicate box
    if (!target) {
      // DEFENSIVE DEDUPE: before creating a box, target a package the sweep just adopted (a
      // restored/persisted box whose registry entry didn't survive — e.g. a reload path that
      // missed re-adoption), falling back to a direct orphan adoption (belt-and-braces if the
      // sweep found nothing). Creating here would drop a SECOND box exactly on top of it.
      target = (sweep.first ? this.items.get(sweep.first) ?? null : null)
        ?? this._adoptFirstOrphan(opts.style ?? 'simpleBox', opts.params);
      if (!target) {
        target = this.create(opts.style ?? 'simpleBox', opts.params ?? { ...DEFAULT_CREATOR_PARAMS });
        created = true;
      }
    }
    return this._enterOn(target, opts, created);
  }

  /**
   * The ONE shared enter procedure — every `enterCreatorMode` entry path (create-fresh, reuse,
   * {packageId} targeting, orphan adoption) converges here after target resolution, so the full
   * sequence is guaranteed identical for all of them: re-dimension → dieline ensure + link
   * (re-asserting the panel material contract per panel) → stack bootstrap/migration + composite
   * (re)wire → isolation of the OTHER packages → framing → stage hygiene (pick suppression /
   * ambience ticker via beginCreatorStage) → paint armed on the target's ACTIVE stack layer.
   */
  private _enterOn(s: PackagingState, opts: CreatorModeOpts, freshlyCreated: boolean): CreatorState {
    this.creatorId = s.id;
    // Style change on an EXISTING target: convert via the setStyle rebuild (the style dropdown used
    // to be silently ignored on re-enter — the "changing style does nothing" bug). Combined with a
    // params change it is ONE rebuild (style flip regenerates at the new dims directly).
    if (opts.style && !freshlyCreated && opts.style !== s.style && TEMPLATES[opts.style]) {
      s.style = opts.style;
      if (opts.params) s.params = opts.params;
      s = this._rebuild(s, s.params);
    } else if (opts.params && !freshlyCreated) {
      // Re-dimension an EXISTING target in place (a fresh create already used opts.params).
      s = this.setDimensions(s.id, opts.params) ?? s;
    }
    this.creatorId = s.id;                    // the rebuild paths can re-key the package
    // Dieline layer: prefer the fresh-aware hook. Fresh layers stay TRANSPARENT (no white fill) —
    // the kraft base shows through empty texels via the panels' texOverBase material blend. The
    // package id scopes the host's by-NAME 'Dieline' reuse so one box never steals another's base.
    let layerId: string | null;
    if (this.host.ensureDielineLayerInfo) {
      const info = this.host.ensureDielineLayerInfo(s.dielineLayerId, s.id);
      layerId = info?.layerId ?? null;
    } else {
      layerId = this.host.ensureDielineLayer(s.dielineLayerId);              // legacy host — no fill info
    }
    if (layerId) this.setDielineLayer(s.id, layerId);   // links every panel + re-asserts applyPanelMaterial
    // LAYER STACK: bootstrap from the legacy dieline (idempotent) + (re)wire the composite — the
    // panels then live-texture from the COMPOSITE of the whole stack, not layer 0 directly.
    if (this._ensureStack(s)) {
      this._normalizeStack(s);
      this._linkStackComposite(s);
    }
    // ISOLATE the scene to the target: hide EVERY other 3D object (other packages AND non-package
    // meshes / characters / city) so the stage shows ONLY the box being edited, remembering prior
    // visibility for restore-on-exit. Re-entering while already active (target switch) restores the
    // previous set first. Legacy hosts without the full-scene hook fall back to package-only isolation.
    if (this.host.isolateSceneToPackage) this.host.isolateSceneToPackage(s.id);
    else this._isolateCreatorTarget(s.id);
    // Lay the box FLAT for editing: capture the target's scene rotation and ZERO it (a standard
    // orientation for painting/framing), restored on exit. Position/scale stay as placed. Done BEFORE
    // framing so the camera frames the un-rotated box.
    this._flattenCreatorTarget(s.id);
    // Stage: measured framing + 3/4 orbit + clean focus bg (host → enterGroupOrbit3D), then the
    // city-mode hygiene extras (suppress box-select, clear hover/selection, view gizmo).
    // §4.1 STUDIO STAGE: swap the focus background for the neutral studio gradient (or the host's
    // picked theme), capturing the user's background once per mode session for restore-on-exit.
    this._applyStageBg();
    this.host.frameAndOrbit(s.box.rootGroupId);
    this.host.beginCreatorStage?.();
    // Paint targets the ACTIVE stack layer (raster); legacy path targets the dieline directly.
    // No paintable layer (vector-active target, e.g. restored in place mode) → explicitly DISARM,
    // otherwise a target-switch would leave paint armed on the PREVIOUS box's layer.
    {
      const paintId = this._paintLayerId(s);
      if (paintId) this.host.armSurfacePaint(s.box.panels.map(p => p.meshId), paintId);
      else this.host.disarmSurfacePaint();
    }
    this.creatorActive = true;
    this._syncStageShadow(s);   // §4.1: contact shadow under the staged box (created once, tracked live)
    this.host.scheduleRender();
    return this.getCreatorState();
  }

  /** Leave creator mode: disarm painting + release the camera back to the illustration sync (via
   *  {@link exitEditor}) and drop the stage hygiene. The box, its fold state, its artwork, and the
   *  live-texture link all STAY in the scene — it remains a normal, visible, paintable object
   *  (mirrors how exitCityMode3D leaves the city). Re-entering reuses the same box + layer. */
  exitCreatorMode(): void {
    if (!this.creatorActive) return;
    if (this.creatorId) this.exitEditor(this.creatorId);
    this._restoreCreatorRotation();   // put the box back to the rotation it had before the mode flattened it
    // Restore every object the mode hid (full-scene isolation if the host supports it, else packages).
    if (this.host.restoreSceneIsolation) this.host.restoreSceneIsolation();
    else this._restoreIsolation();
    this._removeStageShadow();  // §4.1: the contact shadow is a stage prop, not scene content
    this._restoreStageBg();     // §4.1: the user's own background comes back exactly as it was
    this.host.endCreatorStage?.();
    this.creatorActive = false;
  }

  /** Capture the creator target's scene rotation and ZERO it (lay the box flat for editing). No-op if
   *  already flat or the transform hooks are absent. {@link _restoreCreatorRotation} puts it back. */
  private _flattenCreatorTarget(rootId: string): void {
    this._creatorSavedRot = null;
    if (!this.host.getNodeTransform || !this.host.setNodeTransform) return;
    const t = this.host.getNodeTransform(rootId);
    if (!t || (t.rotationX === 0 && t.rotationY === 0 && t.rotation === 0)) return;
    this._creatorSavedRot = { rootId, rotationX: t.rotationX, rotationY: t.rotationY, rotation: t.rotation };
    this.host.setNodeTransform(rootId, { rotX: 0, rotY: 0, rotZ: 0 });
  }

  /** Restore the rotation {@link _flattenCreatorTarget} zeroed (exit / target switch). */
  private _restoreCreatorRotation(): void {
    const r = this._creatorSavedRot;
    this._creatorSavedRot = null;
    if (!r || !this.host.setNodeTransform) return;
    if (this.host.nodeExists && !this.host.nodeExists(r.rootId)) return;   // deleted while in mode
    this.host.setNodeTransform(r.rootId, { rotX: r.rotationX, rotY: r.rotationY, rotZ: r.rotation });
  }

  /** Hide every package EXCEPT `targetId` (remembering previous visibility) + ensure the target is
   *  shown. No-op without the optional `setNodeVisible` host hook. Idempotent-safe: restores any
   *  prior isolation first so switching targets while active never double-records or leaks.
   *  BELT-AND-BRACES: after the registry loop, package-shaped roots STILL outside the registry
   *  (candidates {@link _adoptAllOrphans} had to skip — unknown topology, missing panel meshes)
   *  are hidden too, keyed by their ROOT node id in the same `isolationPrev` map, so a stray box
   *  can never share the stage with the mode's target. */
  private _isolateCreatorTarget(targetId: string): void {
    if (!this.host.setNodeVisible) return;
    this._restoreIsolation();
    for (const other of this.items.values()) {
      if (other.id === targetId) continue;
      if (this.host.nodeExists && !this.host.nodeExists(other.box.rootGroupId)) continue;
      this.isolationPrev.set(other.id, this.host.isNodeVisible?.(other.box.rootGroupId) ?? true);
      this.host.setNodeVisible(other.box.rootGroupId, false);
    }
    for (const rootId of this.host.findOrphanPackageRoots?.([...this.items.keys()]) ?? []) {
      if (rootId === targetId || this.isolationPrev.has(rootId)) continue;
      if (this.host.nodeExists && !this.host.nodeExists(rootId)) continue;
      this.isolationPrev.set(rootId, this.host.isNodeVisible?.(rootId) ?? true);
      this.host.setNodeVisible(rootId, false);
    }
    const t = this.items.get(targetId);
    if (t) this.host.setNodeVisible(t.box.rootGroupId, true);   // target always visible in the mode
  }

  /** Restore everything {@link _isolateCreatorTarget} hid. A key is a package id (→ its root node)
   *  or, for the adoption-skipped strays of the defensive pass, a raw ROOT node id (package ids ARE
   *  root node ids, so the map stays uniform). Packages deleted while hidden cleared their entry in
   *  {@link remove}; any other node that vanished (document switch) is skipped via nodeExists. */
  private _restoreIsolation(): void {
    if (this.host.setNodeVisible) {
      for (const [pid, prev] of this.isolationPrev) {
        const nodeId = this.items.get(pid)?.box.rootGroupId ?? pid;   // registered package or stray root
        if (this.host.nodeExists && !this.host.nodeExists(nodeId)) continue;   // node gone
        this.host.setNodeVisible(nodeId, prev);
      }
    }
    this.isolationPrev.clear();
  }

  /** Live snapshot for the host's Package Creator panel. `packageId` persists across exit (so the
   *  panel can keep driving fold/dims/export on the same box); null until the first enter. */
  getCreatorState(): CreatorState {
    const s = this.creatorId ? this.items.get(this.creatorId) ?? null : null;
    return {
      active: this.creatorActive && s !== null,
      packageId: s?.id ?? null,
      style: s?.style ?? null,
      params: s?.params ?? null,
      foldAmount: s?.foldAmount ?? 0,
      dielineLayerId: s?.dielineLayerId ?? null,
      guides: s?.guides ?? [],
    };
  }

  /**
   * UNWRAP PANE — wire a UV-pane canvas (the host's dieline pane) into the ACTIVE creator-mode paint
   * session, exactly the character UV-paint pattern: pane strokes and 3D box strokes paint the ONE
   * dieline layer, and the pane background shows the dieline texture (throttled readback). Call AFTER
   * {@link enterCreatorMode} (returns null while the mode is off). NO UV session/unwrap is opened —
   * the box's authored net UVs are the mapping (the openUVEditor3D clobber trap is deliberately
   * avoided); the pane attaches onto the already-armed surface-paint controller. Returns the overlay
   * handle (guides + a UV→pane-px mapper) so the host can draw cut/fold/bleed/panel guides on top.
   * The pane auto-detaches on {@link exitCreatorMode} (the paint session tears down).
   */
  attachDielinePane(uvRenderer: UVCanvasRenderer): DielinePaneHandle | null {
    const s = this.creatorActive && this.creatorId ? this.items.get(this.creatorId) ?? null : null;
    if (!s || !this.host.attachPaintPane) return null;
    // Late-bound resize notifier: the host's pane plumbing calls this after a layout resize
    // re-synced + re-rendered the pane; it forwards to whatever the host set on the handle.
    let notifyResize: (() => void) | undefined;
    const uvToCanvas = this.host.attachPaintPane(uvRenderer, () => notifyResize?.());
    if (!uvToCanvas) return null;
    // LIVE handle: `s` is mutated in place by setDimensions (both fast + rebuild paths), so getters
    // over it stay current; `uvToCanvas` is the host's closure over the pane's live pan/zoom/size.
    // The host still redraws its own overlay after resize/setDimensions (see DielinePaneHandle docs);
    // for pane-canvas resizes it can simply set `handle.onPaneResize` and redraw there.
    const handle: DielinePaneHandle = {
      uvToCanvas,
      get guides() { return s.guides; },
      get canvasWidth() { return s.canvasWidth; },
      get canvasHeight() { return s.canvasHeight; },
      get panels(): DielinePanePanel[] {
        return s.foldMeshData.panels.map(p => {
          let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
          for (const [u, v] of p.uvs) {
            if (u < u0) u0 = u; if (u > u1) u1 = u;
            if (v < v0) v0 = v; if (v > v1) v1 = v;
          }
          return { id: p.id, label: s.panelLabels[p.id] ?? p.name, uvRect: { u0, v0, u1, v1 } };
        });
      },
    };
    notifyResize = () => handle.onPaneResize?.();
    return handle;
  }

  /** Detach the pane wired by {@link attachDielinePane}. 3D box painting stays armed. */
  detachDielinePane(): void { this.host.detachPaintPane?.(); }

  fold(id: string, durationMs = 700): void { this.animateTo(id, 1, durationMs); }
  unfold(id: string, durationMs = 700): void { this.animateTo(id, 0, durationMs); }

  private animateTo(id: string, target: number, durationMs: number): void {
    const s = this.items.get(id);
    if (!s) return;
    const prev = this.anim.get(id);
    if (prev != null) cancelAnimationFrame(prev);
    const from = s.foldAmount, start = performance.now();
    const tick = (): void => {
      const t = Math.min(1, (performance.now() - start) / Math.max(1, durationMs));
      const e = easeInOutCubic(t);   // §4.3: cubic in-out — softer launch/landing than the old quad
      this.setFoldAmount(id, from + (target - from) * e);
      if (t < 1) this.anim.set(id, requestAnimationFrame(tick));
      else this.anim.delete(id);
    };
    this.anim.set(id, requestAnimationFrame(tick));
  }

  get(id: string): PackagingState | null { return this.items.get(id) ?? null; }
  getAll(): PackagingState[] { return [...this.items.values()]; }

  // ── Persistence: params-only registry round-trip (the characters/buildings pattern) ────────────

  /** The params-only persisted form of ONE live package. Shared by {@link serialize} (the
   *  scene3dJSON array) AND {@link _stampMarker} (the self-describing worldParams marker) so the two
   *  can never disagree. */
  private _entryOf(s: PackagingState): PackagingPersistEntry {
    // Read the ROOT's transform LIVE every call (serialize + marker stamp) so a bare gizmo drag —
    // which touches the node directly and calls no packaging API — is still captured at save time.
    let transform = this.host.getNodeTransform?.(s.id) ?? null;
    // While in creator mode the target is temporarily FLATTENED (rotation 0) for editing — persist the
    // user's REAL rotation (saved on enter), not the transient zero, if a save fires mid-mode.
    if (transform && this._creatorSavedRot && this._creatorSavedRot.rootId === s.id) {
      transform = {
        ...transform,
        rotationX: this._creatorSavedRot.rotationX,
        rotationY: this._creatorSavedRot.rotationY,
        rotation: this._creatorSavedRot.rotation,
      };
    }
    return {
      id: s.id,
      style: s.style,
      params: { ...s.params },
      foldAmount: s.foldAmount,
      dielineLayerId: s.dielineLayerId,
      panels: s.box.panels.map(p => ({ meshId: p.meshId, pivotNodeId: p.pivotNodeId })),
      ...(this.creatorId === s.id ? { wasCreator: true } : {}),
      // Layer STACK order + active target (the layers themselves persist as tagged doc layers).
      ...(s.layers?.length ? { layers: s.layers.slice() } : {}),
      ...(s.layers?.length && s.activeLayerId ? { activeLayerId: s.activeLayerId } : {}),
      ...(s.board ? { board: s.board } : {}),   // §4.2 board preset
      ...(transform && !isIdentityPackagingTransform(transform) ? { transform } : {}),
    };
  }

  /** Re-apply a persisted ROOT transform to a package root after its box is (re)built on restore.
   *  Absent/identity = no-op (older saves / unmoved packages). Called BEFORE the marker re-stamp on
   *  every restore path so the node — and the refreshed marker read from it — carry the transform. */
  private _applyRootTransform(rootId: string, t?: PackagingTransform): void {
    if (!t || isIdentityPackagingTransform(t)) return;
    this.host.setNodeTransform(rootId, {
      pos: [t.x, t.y, t.z], rotX: t.rotationX, rotY: t.rotationY, rotZ: t.rotation,
      scale: [t.scaleX, t.scaleY, t.scaleZ],
    });
  }

  /** (Re)stamp the SELF-DESCRIBING worldParams marker on a package's root — called after EVERY
   *  state change (create / dimension / style / fold / board / dieline / layer-stack) so a reload
   *  can re-adopt the package from the scene graph ALONE, the way Buildings/Foliage do. No-op
   *  without the optional {@link PackagingHost.stampMarker} hook. */
  private _stampMarker(s: PackagingState): void {
    this.host.stampMarker?.(s.id, this._entryOf(s));
  }

  /** Serialize every live package to its params-only persisted form (rides in scene3d JSON). */
  serialize(): PackagingPersistEntry[] {
    return [...this.items.values()].map(s => this._entryOf(s));
  }

  /**
   * EAGER re-adoption from the SELF-DESCRIBING scene markers (the Building/Foliage pattern): scan
   * the scene graph for package roots (`worldParams.kind==='packaging'`) and re-adopt each from its
   * OWN stamped `entry` — INDEPENDENT of the scene3dJSON packaging array. This makes
   * getAll()/isPackageNode() work the instant a document loads (the host wires it into
   * restoreProceduralFromSave3D alongside buildings/foliage), so a reloaded package is recognised
   * as a package — 📦 icon, delete, Package-Mode-on-select — WITHOUT first entering creator mode.
   * Idempotent: packages already in the registry are skipped, so it is safe to call alongside
   * {@link restoreFromJSON} (no double-adoption). Markers with no `entry` (legacy) are left to the
   * structural orphan sweep. Returns the number of packages newly adopted.
   */
  restoreFromSave(): number {
    if (!this.host.findPackageMarkers) return 0;
    let adopted = 0;
    let firstAdopted: string | null = null;
    for (const { rootId, entry } of this.host.findPackageMarkers()) {
      // ★Adopt against the SCANNED root id, never the entry's saved id: the marker is stamped ON the
      // restored root, so `rootId` is always correct, whereas `entry.id` is the pre-reload id (stale if
      // the node id ever fails to round-trip). Building-style id-independence — the entry supplies
      // params only. `id` is normalized so downstream regenerate-under-root uses the live root.
      if (!entry || this.items.has(rootId)) continue;   // legacy marker (→ orphan sweep) / already live
      const e = rootId === entry.id ? entry : { ...entry, id: rootId };
      try {
        if (this._adoptPersisted(e)) {
          adopted++;
          firstAdopted ??= rootId;
          // Re-establish the creator reuse handle across a reload (see restoreFromJSON).
          if (e.wasCreator && !this.creatorId) this.creatorId = rootId;
        }
      } catch (err) {
        console.warn('[Packaging] marker re-adoption failed for', rootId, err);
      }
    }
    // Sweep any package-shaped roots with NO usable entry (legacy markers, duplicate-era strays).
    const sweep = this._adoptAllOrphans();
    adopted += sweep.count;
    if (!this.creatorId) this.creatorId = firstAdopted ?? sweep.first;
    this._pruneLooseLegacyNodes();
    return adopted;
  }

  /**
   * RE-ADOPT persisted packages after a document load: rebuild the registry from the persisted
   * params and re-bind each entry to the EXISTING restored scene nodes (no node creation). Also
   * repairs panel-mesh parenting (restore re-parents only one nesting level — panel meshes sit two
   * deep, so they land at the scene root without this), re-asserts panel geometry/pivot placement
   * from params, re-applies the persisted fold, and re-links the dieline layer (which re-asserts
   * the panel material contract). Idempotent: ids already in the registry are skipped; entries
   * whose root node no longer exists are dropped. Returns the number of packages adopted.
   */
  restoreFromJSON(entries: PackagingPersistEntry[] | null | undefined): number {
    let adopted = 0;
    let firstAdopted: string | null = null;
    if (entries && Array.isArray(entries)) {
      for (const e of entries) {
        try {
          if (this._adoptPersisted(e)) {
            adopted++;
            firstAdopted ??= e.id;
            // Re-establish the creator reuse handle: re-entering the mode after a reload targets
            // the SAME box it did before the reload — never an overlapping duplicate.
            if (e.wasCreator && !this.creatorId) this.creatorId = e.id;
          }
        } catch (err) {
          console.warn('[Packaging] re-adoption failed for', e?.id, err);
        }
      }
    }
    // WRAP-UP SWEEP: adopt package-shaped roots with NO surviving persisted entry — strays from
    // the old duplicate-box era, or entries whose re-adoption failed above (root-id drift). Their
    // style/params are inferred structurally; candidates matching no template are left untouched
    // (creator-mode isolation still hides those defensively).
    const sweep = this._adoptAllOrphans();
    adopted += sweep.count;
    // Older saves carry no wasCreator flag — still point the reuse handle at a restored box so a
    // plain enterCreatorMode() reuses it instead of stacking a new box on the restored geometry.
    if (!this.creatorId) this.creatorId = firstAdopted ?? sweep.first;
    // LEGACY-SAVE CLEANUP (BUG 5): a pre-`documentSkipChildren` save serialized panels as normal
    // nodes; the restore can float them up as LOOSE '<Name> Hinge' pivot subtrees at the scene root
    // (the "loose Package, Front, Right, Back, Left" symptom). Now that every live package has been
    // (re)built/rebound with its CURRENT node ids, delete any top-level package pivot leftover that
    // is NOT one of them, collapsing the Outliner to exactly one 'Package' per box.
    this._pruneLooseLegacyNodes();
    return adopted;
  }

  /** Delete stray top-level package pivot subtrees a legacy reload left loose (see BUG 5). Keeps
   *  every live package's own root/pivot/mesh ids; a top-level '<Name> Hinge' group NOT among them
   *  is unambiguously a leftover (real pivots nest under a 'Package' root). No-op without the host
   *  hook / when nothing is loose. */
  private _pruneLooseLegacyNodes(): void {
    if (!this.host.pruneLoosePackageNodes) return;
    const keep: string[] = [];
    for (const s of this.items.values()) {
      keep.push(s.box.rootGroupId);
      for (const p of s.box.panels) { keep.push(p.pivotNodeId, p.meshId); }
    }
    this.host.pruneLoosePackageNodes(keep);
  }

  /** Adopt one persisted entry against the restored scene. See {@link restoreFromJSON}. */
  private _adoptPersisted(e: PackagingPersistEntry): boolean {
    if (!e || !e.id || !e.params || !TEMPLATES[e.style]) return false;
    if (this.items.has(e.id)) return false;                                        // already live
    if (this.host.nodeExists && !this.host.nodeExists(e.id)) return false;         // root gone
    const r = TEMPLATES[e.style](e.params);
    const tpanels = r.foldMeshData.panels;
    // Resolve panel node ids: persisted ids first (index-aligned with the template), falling back
    // to STRUCTURAL matching by panel name under the root when an id didn't survive the reload.
    const struct = this.host.getPackageStructure?.(e.id) ?? null;
    // REGENERATION path (the params-only City pattern): a `documentSkipChildren` package root
    // serializes as a lightweight marker WITHOUT its panel/pivot subtree, so the restored root has
    // no '<Panel> Hinge' structure. Build the panels under the existing marker root (its id == the
    // package id) straight from the persisted style + params. Legacy saves (panels serialized, no
    // documentSkipChildren) still have a structure → the re-BIND path below runs unchanged.
    if (!struct || struct.length === 0) return this._regenerateUnderRoot(e, r);
    const byName = new Map(struct.map(p => [p.name, p]));
    const pairs: { pivotNodeId: string; meshId: string }[] = [];
    for (let i = 0; i < tpanels.length; i++) {
      const persisted = e.panels?.[i];
      let pivotNodeId = persisted?.pivotNodeId ?? '';
      let meshId = persisted?.meshId ?? '';
      const nodeOk = (id: string) => !!id && (!this.host.nodeExists || this.host.nodeExists(id));
      if (!nodeOk(pivotNodeId)) pivotNodeId = byName.get(tpanels[i].name)?.pivotNodeId ?? '';
      if (!nodeOk(meshId)) {
        meshId = byName.get(tpanels[i].name)?.meshId
          ?? (struct?.find(p => p.pivotNodeId === pivotNodeId)?.meshId ?? '')
          ?? '';
      }
      if (!nodeOk(pivotNodeId) || !nodeOk(meshId)) return false;   // unrecoverable — leave nodes alone
      pairs.push({ pivotNodeId, meshId });
    }
    return this._adoptCore(e.id, e.style, e.params, r, pairs, e.foldAmount, e.dielineLayerId, e.layers, e.activeLayerId, e.board, e.transform);
  }

  /** REGENERATE a package's panel/pivot hierarchy UNDER its restored `documentSkipChildren` marker
   *  root (id == package id) from the persisted params — the panels weren't serialized. Mirrors
   *  {@link _adoptCore}'s tail (register + wrapper mark + fold + dieline/stack re-link) but BUILDS
   *  fresh nodes rather than re-binding existing ones. */
  private _regenerateUnderRoot(e: PackagingPersistEntry, r: DielineResult): boolean {
    const box = buildBoxNodes(r.foldMeshData.panels, this.host, { name: 'Package', scale: MM_TO_WORLD, existingRootId: e.id });
    const state: PackagingState = {
      id: e.id, meshId: e.id, box, style: e.style, params: { ...e.params },
      foldMeshData: r.foldMeshData, foldAmount: Math.max(0, Math.min(1, e.foldAmount)),
      canvasWidth: r.canvasWidth, canvasHeight: r.canvasHeight, guides: r.guides, panelLabels: r.panelLabels,
      ...(e.board ? { board: e.board } : {}),
    };
    this.items.set(state.id, state);
    // Re-assert the thin-wrapper / documentSkipChildren marker + bounds (the restored marker already
    // carries them, but the newly built panels changed the aggregate bounds) — tight to the pose.
    this.host.markUnitWrapper?.(e.id, this.poseBounds(r.foldMeshData.panels, state.foldAmount));
    setBoxFold(box, state.foldAmount, this.host);
    this._applyRootTransform(e.id, e.transform);   // restore a moved/rotated/scaled package's placement
    if (e.dielineLayerId && (this.host.layerExists?.(e.dielineLayerId) ?? true)) {
      this.setDielineLayer(state.id, e.dielineLayerId);
    } else {
      this._applyBoardMaterials(state);
    }
    // Re-establish the LAYER STACK (identical to _adoptCore): re-tag the persisted layers, restore
    // order + active target, and re-wire the composite so the box shows the full stack immediately.
    if (e.layers?.length && this.host.stack) {
      const st = this.host.stack;
      const alive = e.layers.filter(l => st.info(l) !== null);
      if (alive.length) {
        for (const l of alive) st.adopt(state.id, l);
        state.layers = alive;
        state.activeLayerId = e.activeLayerId && alive.includes(e.activeLayerId) ? e.activeLayerId : undefined;
        this._normalizeStack(state);
        this._linkStackComposite(state);
      }
    }
    this._stampMarker(state);   // refresh the marker with the regenerated panel ids
    this.host.notifySceneGraphChanged?.();
    this.host.scheduleRender();
    return true;
  }

  /** Structure-only adoption of an orphaned package root (no persisted entry — the defensive
   *  dedupe path). Panel identity comes from '<Name> Hinge' pivot naming; geometry is normalized
   *  to `params` (defaults when unknown) via the in-place re-dimension. */
  private _adoptStructural(rootId: string, style: BoxStyle, params: DielineParams): PackagingState | null {
    if (!TEMPLATES[style]) return null;
    if (this.items.has(rootId)) return this.items.get(rootId)!;
    if (this.host.nodeExists && !this.host.nodeExists(rootId)) return null;
    const struct = this.host.getPackageStructure?.(rootId);
    if (!struct || struct.length === 0) return null;
    const r = TEMPLATES[style](params);
    const tpanels = r.foldMeshData.panels;
    if (struct.length !== tpanels.length) return null;               // different topology — not ours
    const byName = new Map(struct.map(p => [p.name, p]));
    const pairs: { pivotNodeId: string; meshId: string }[] = [];
    for (const tp of tpanels) {
      const hit = byName.get(tp.name);
      if (!hit || !hit.meshId) return null;
      pairs.push({ pivotNodeId: hit.pivotNodeId, meshId: hit.meshId });
    }
    if (!this._adoptCore(rootId, style, params, r, pairs, 0, undefined)) return null;
    return this.items.get(rootId) ?? null;
  }

  /** ADOPT-ALL-ORPHANS sweep: structurally adopt EVERY package-shaped root the host can find that
   *  is missing from the registry (strays saved during the old duplicate-box era, restored
   *  packages whose persisted re-adoption failed to match). Style is INFERRED per root by trying
   *  each template against the root's '<Panel> Hinge' structure (the {@link _adoptStructural}
   *  name/topology match); params fall back to the creator defaults — best-effort registration
   *  through the existing {@link _adoptCore} semantics (register + re-parent/mark; nodes are never
   *  created or removed). A candidate matching NO template topology is SKIPPED with a warning and
   *  left untouched — {@link _isolateCreatorTarget}'s defensive pass still hides it during the
   *  mode. Runs on every {@link enterCreatorMode} and in {@link restoreFromJSON}'s wrap-up. */
  private _adoptAllOrphans(): { count: number; first: string | null } {
    const roots = this.host.findOrphanPackageRoots?.([...this.items.keys()]) ?? [];
    let count = 0;
    let first: string | null = null;
    for (const rootId of roots) {
      let adopted: PackagingState | null = null;
      try {
        for (const style of Object.keys(TEMPLATES) as BoxStyle[]) {
          adopted = this._adoptStructural(rootId, style, { ...DEFAULT_CREATOR_PARAMS });
          if (adopted) break;
        }
      } catch (err) {
        adopted = null;
        console.warn('[Packaging] orphan adoption failed for', rootId, err);
      }
      if (adopted) { count++; first ??= adopted.id; }
      else {
        console.warn(
          `[Packaging] package-shaped root '${rootId}' matches no template topology — left ` +
          `unregistered and unmodified (creator mode will hide it while active).`,
        );
      }
    }
    return { count, first };
  }

  /** Try structural adoption of the first adoptable orphan root (defensive dedupe for the
   *  enterCreatorMode create path). */
  private _adoptFirstOrphan(style: BoxStyle, params?: DielineParams): PackagingState | null {
    const roots = this.host.findOrphanPackageRoots?.([...this.items.keys()]) ?? [];
    for (const rootId of roots) {
      const s = this._adoptStructural(rootId, style, params ?? { ...DEFAULT_CREATOR_PARAMS });
      if (s) return s;
    }
    return null;
  }

  /** Shared adoption core: registry entry + parent repair + geometry/pivot normalization + fold +
   *  dieline re-link (+ layer-stack re-link). Never creates or removes nodes. */
  private _adoptCore(
    rootId: string, style: BoxStyle, params: DielineParams, r: DielineResult,
    pairs: { pivotNodeId: string; meshId: string }[], foldAmount: number, dielineLayerId: string | undefined,
    layers?: string[], activeLayerId?: string, board?: BoardPresetId, transform?: PackagingTransform,
  ): boolean {
    const box: PackagingBox = {
      rootGroupId: rootId,
      panels: pairs.map(p => ({
        pivotNodeId: p.pivotNodeId, meshId: p.meshId,
        pos: [0, 0, 0], yaw: 0, targetAngleRad: 0,     // filled by updateBoxDimensions below
        hingeAxisLocal: [1, 0, 0],
      })),
    };
    // Repair parenting: the restore pass re-parents only ONE level of group nesting, so panel
    // meshes come back at the scene root — move each back under its hinge pivot (no-op when fine).
    for (const p of pairs) this.host.reparentNode?.(p.meshId, p.pivotNodeId);
    // Re-assert geometry + pivot placement from params (also fills pos/yaw/targetAngleRad), then
    // re-apply the persisted fold. Params are the source of truth — node drift is normalized.
    if (!updateBoxDimensions(box, r.foldMeshData.panels, this.host, { scale: MM_TO_WORLD })) return false;
    const state: PackagingState = {
      id: rootId, meshId: rootId, box, style, params: { ...params },
      foldMeshData: r.foldMeshData, foldAmount: Math.max(0, Math.min(1, foldAmount)),
      canvasWidth: r.canvasWidth, canvasHeight: r.canvasHeight, guides: r.guides, panelLabels: r.panelLabels,
      ...(board ? { board } : {}),
    };
    this.items.set(state.id, state);
    this.host.markUnitWrapper?.(rootId, this.poseBounds(r.foldMeshData.panels, state.foldAmount));
    setBoxFold(box, state.foldAmount, this.host);
    this._applyRootTransform(rootId, transform);   // restore a moved/rotated/scaled package's placement
    // Re-establish the dieline link (also re-asserts the board panel material contract per panel).
    if (dielineLayerId && (this.host.layerExists?.(dielineLayerId) ?? true)) {
      this.setDielineLayer(state.id, dielineLayerId);
    } else {
      this._applyBoardMaterials(state);   // no dieline yet — board read still applies (§4.2)
    }
    // Re-establish the LAYER STACK: the layers persisted as tagged doc layers; re-assert the tags
    // (legacy saves may predate them), restore order + active target, and re-wire the composite so
    // the restored box shows the full stack immediately (not just layer 0).
    if (layers?.length && this.host.stack) {
      const st = this.host.stack;
      const alive = layers.filter(l => st.info(l) !== null);
      if (alive.length) {
        for (const l of alive) st.adopt(state.id, l);
        state.layers = alive;
        state.activeLayerId = activeLayerId && alive.includes(activeLayerId) ? activeLayerId : undefined;
        this._normalizeStack(state);
        this._linkStackComposite(state);
      }
    }
    // Re-stamp the self-describing marker with the re-bound node ids (a structural/orphan adoption
    // may have carried no marker entry, or a drifted one — normalize it to the live state).
    this._stampMarker(state);
    // Re-adoption repaired parenting/wrapper flags — announce the final tree (coalesced by the
    // host during a document restore; immediate for the orphan-adoption path).
    this.host.notifySceneGraphChanged?.();
    this.host.scheduleRender();
    return true;
  }

  /** The current guide overlay (cut/fold/bleed/panel, canvas px) — convenience for redrawing after setDimensions. */
  getGuides(id: string): DielineGuide[] { return this.items.get(id)?.guides ?? []; }

  /** Export the artwork as a flat PNG: the FLATTENED layer-stack composite when a stack exists,
   *  else the single dieline layer. null if nothing is linked. */
  async exportDielinePng(id: string): Promise<Blob | null> {
    const s = this.items.get(id);
    if (!s) return null;
    if (s.layers?.length && this.host.stack) return this.host.stack.exportPng(id);
    if (!s.dielineLayerId) return null;
    return this.host.exportLayerPng(s.dielineLayerId);
  }

  remove(id: string): void {
    const s = this.items.get(id);
    if (!s) return;
    const a = this.anim.get(id);
    if (a != null) cancelAnimationFrame(a);
    this.anim.delete(id);
    if (s.dielineLayerId) for (const p of s.box.panels) this.host.unlinkLiveTexture(p.meshId);
    // Layer stack: tear down the composite + delete the package's tagged layers (they are hidden
    // system layers — with the package gone they would otherwise linger invisible forever).
    if (this.host.stack) {
      this.host.stack.unlinkComposite(id);
      for (const l of s.layers ?? []) this.host.stack.remove(l);
    }
    this.host.removeNode(s.box.rootGroupId);   // deletes the whole panel subtree
    this.items.delete(id);
    this.isolationPrev.delete(id);   // deleted while hidden by the mode → nothing to restore later
    // §4.1: the contact shadow (a child of the removed root) died with the subtree.
    if (this.stageShadowPkg === id) { this.stageShadowId = null; this.stageShadowPkg = null; }
    if (this.creatorId === id) { this.creatorId = null; this.creatorActive = false; }
  }
}
