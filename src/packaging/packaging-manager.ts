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
  /** Like {@link ensureDielineLayer} but reports whether the layer was FRESHLY created (fresh → the
   *  manager white-fills it so the box reads as blank paper, not black). Hosts should also reuse an
   *  existing layer NAMED 'Dieline' here (fresh:false) so re-entering never duplicates layers. */
  ensureDielineLayerInfo?(existing?: string): { layerId: string; fresh: boolean } | null;
  /** Fill a raster layer opaque white (fresh-dieline init ONLY — never called on a reused layer). */
  fillLayerWhite?(layerId: string): void;
  /** True if a scene node still exists — guards a stale creator box handle across document switches. */
  nodeExists?(id: string): boolean;
  /** Extra mode hygiene on enter (city-mode style): suppress box-select, clear hover/selection, view gizmo. */
  beginCreatorStage?(): void;
  /** Undo {@link beginCreatorStage} on exit. */
  endCreatorStage?(): void;

  // ── FIRST-CLASS SCENE OBJECT hooks (addPackage / Outliner integration — optional) ──
  /** Mark the box's ROOT container as a select-as-a-UNIT wrapper (the City thin-wrapper pattern):
   *  clicking ANY panel resolves selection to the root, the gizmo moves the whole box, and the
   *  outliner shows ONE node. `localBounds` (group-local AABB across the fold range) sizes the
   *  selection box/gizmo without per-child scans (the cachedBounds pattern). Safe to re-call with
   *  fresh bounds after a re-dimension — hosts should only re-notify the scene graph when the
   *  wrapper flag actually flips. */
  markUnitWrapper?(rootNodeId: string, localBounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): void;
  /** Attach a UV pane renderer to the ACTIVE surface-paint session so pane strokes paint the SAME
   *  dieline layer as 3D box strokes (no second paint path). Returns a UV[0,1]→pane-canvas-px mapper
   *  (for the host's guide overlay) or null if no packaging paint session is active. */
  attachPaintPane?(uvRenderer: UVCanvasRenderer): ((u: number, v: number) => [number, number]) | null;
  /** Detach the pane wired by {@link attachPaintPane}. 3D box painting stays armed. */
  detachPaintPane?(): void;
}

export type BoxStyle = 'simpleBox';

const TEMPLATES: Record<BoxStyle, (p: DielineParams) => DielineResult> = { simpleBox };

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
  /** The raster layer live-textured onto the box (the dieline canvas), if linked. */
  dielineLayerId?: string;
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
  /** Box style for a fresh enter (default 'simpleBox'). Ignored on re-enter. */
  style?: BoxStyle;
  /** Enter the mode targeting THIS existing package (e.g. an {@link PackagingManager.addPackage} box the
   *  user selected — resolve the selection via {@link PackagingManager.isPackageNode}) instead of
   *  create-or-reuse-the-previous-creator-box. Unknown/stale ids are ignored (normal enter). */
  packageId?: string;
}

/** What {@link PackagingManager.attachDielinePane} hands back for the host's pane overlay. */
export interface DielinePaneHandle {
  /** UV [0,1] → pane canvas px (honours the pane's pan/zoom). Guide points are dieline-canvas px, so:
   *  `uvToCanvas(px / canvasWidth, py / canvasHeight)`. */
  uvToCanvas: (u: number, v: number) => [number, number];
  /** Cut / fold / bleed / panel guides (dieline-canvas px) to overlay on the pane. */
  guides: DielineGuide[];
  canvasWidth: number;
  canvasHeight: number;
}

/** Snapshot for the host's Package Creator panel — see {@link PackagingManager.getCreatorState}. */
export interface CreatorState {
  /** True while creator mode is entered (orbit + surface paint armed). */
  active: boolean;
  /** The creator box's packaging id (persists across exit so re-enter reuses it), or null. */
  packageId: string | null;
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

  constructor(private host: PackagingHost) {}

  /**
   * Add a package to the scene as a FIRST-CLASS OBJECT — the Outliner "Add Mesh > Package…" entry.
   * Creates the box hierarchy WITHOUT entering creator mode (no framing, no stage, no paint arming,
   * no dieline layer). The root behaves like the City thin-wrapper: ONE outliner node, clicking any
   * panel selects the package as a unit, the gizmo moves the whole box. To edit/paint it later, call
   * {@link enterCreatorMode} with `{ packageId: state.id }`.
   */
  addPackage(params?: DielineParams, style: BoxStyle = 'simpleBox'): PackagingState {
    return this.create(style, params ?? { ...DEFAULT_CREATOR_PARAMS });
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

  /** Group-local AABB covering the whole fold range (flat net ∪ closed box) — sizes the unit-wrapper
   *  selection box/gizmo without per-child scans (the City cachedBounds pattern). The root group sits
   *  at identity/scale 1 (the mm→world scale is baked into the panels), so net space IS group-local. */
  private unitBounds(panels: FoldPanel[]): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const amt of [0, 1]) {
      for (const corners of computeFoldWorldCorners(panels, amt, MM_TO_WORLD)) {
        for (const [x, y, z] of corners) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
  }

  /** Create a packaging box from a style + dimensions (starts flat) as a rigid-panel node hierarchy. */
  create(style: BoxStyle, params: DielineParams, name = 'Package'): PackagingState {
    const r = TEMPLATES[style](params);
    const box = buildBoxNodes(r.foldMeshData.panels, this.host, { name, scale: MM_TO_WORLD });
    // Every package is a select-as-a-unit wrapper (City pattern) — one outliner node, whole-box gizmo.
    this.host.markUnitWrapper?.(box.rootGroupId, this.unitBounds(r.foldMeshData.panels));
    const state: PackagingState = {
      id: box.rootGroupId, meshId: box.rootGroupId, box, style, params, foldMeshData: r.foldMeshData, foldAmount: 0,
      canvasWidth: r.canvasWidth, canvasHeight: r.canvasHeight, guides: r.guides, panelLabels: r.panelLabels,
    };
    this.items.set(state.id, state);
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
    {
      const r2 = TEMPLATES[s.style](params);
      if (this.host.setPanelGeometry &&
          updateBoxDimensions(s.box, r2.foldMeshData.panels, this.host, { scale: MM_TO_WORLD })) {
        s.params = params;
        s.foldMeshData = r2.foldMeshData;
        s.canvasWidth = r2.canvasWidth; s.canvasHeight = r2.canvasHeight; s.guides = r2.guides; s.panelLabels = r2.panelLabels;
        setBoxFold(s.box, s.foldAmount, this.host);   // keep the current fold on the new dimensions
        this.host.markUnitWrapper?.(s.box.rootGroupId, this.unitBounds(r2.foldMeshData.panels));   // refresh gizmo bounds (flag already set → no re-notify)
        this.host.scheduleRender();
        return s;
      }
    }
    const dielineLayerId = s.dielineLayerId;
    // Tear down the old hierarchy (unlink live textures first) and build a fresh one for the new dims.
    if (dielineLayerId) for (const p of s.box.panels) this.host.unlinkLiveTexture(p.meshId);
    this.host.removeNode(s.box.rootGroupId);
    this.items.delete(s.id);

    s.params = params;
    const r = TEMPLATES[s.style](params);
    s.foldMeshData = r.foldMeshData;
    s.canvasWidth = r.canvasWidth; s.canvasHeight = r.canvasHeight; s.guides = r.guides; s.panelLabels = r.panelLabels;
    s.box = buildBoxNodes(r.foldMeshData.panels, this.host, { name: 'Package', scale: MM_TO_WORLD });
    this.host.markUnitWrapper?.(s.box.rootGroupId, this.unitBounds(r.foldMeshData.panels));
    const oldId = id;
    s.id = s.box.rootGroupId; s.meshId = s.box.rootGroupId;
    this.items.set(s.id, s);
    if (this.creatorId === oldId) this.creatorId = s.id;   // keep the creator handle tracking the rebuilt box
    // Re-apply the current fold + re-link the dieline layer onto the new panel meshes.
    setBoxFold(s.box, s.foldAmount, this.host);
    if (dielineLayerId) { s.dielineLayerId = dielineLayerId; for (const p of s.box.panels) this.host.linkLiveTexture(p.meshId, dielineLayerId); }
    this.host.scheduleRender();
    return s;
  }

  /** Set the fold position directly (0 flat → 1 folded) — pivot TRANSFORMS only, no geometry rebuild. */
  setFoldAmount(id: string, amount: number): void {
    const s = this.items.get(id);
    if (!s) return;
    s.foldAmount = Math.max(0, Math.min(1, amount));
    setBoxFold(s.box, s.foldAmount, this.host);
    this.host.scheduleRender();
  }

  /** Live-texture a raster layer (the dieline canvas) onto EVERY panel → drawing on it shows on the box,
   *  flat OR folded (the net UVs map the canvas to each panel). Host syncs after strokes. */
  setDielineLayer(id: string, layerId: string): void {
    const s = this.items.get(id);
    if (!s) return;
    if (s.dielineLayerId) for (const p of s.box.panels) this.host.unlinkLiveTexture(p.meshId);
    s.dielineLayerId = layerId;
    for (const p of s.box.panels) this.host.linkLiveTexture(p.meshId, layerId);
    this.host.scheduleRender();
  }

  clearDielineLayer(id: string): void {
    const s = this.items.get(id);
    if (!s || !s.dielineLayerId) return;
    for (const p of s.box.panels) this.host.unlinkLiveTexture(p.meshId);
    s.dielineLayerId = undefined;
    this.host.scheduleRender();
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
   * A FRESHLY created dieline layer is filled opaque WHITE (a box sampling an empty layer renders
   * black); a reused layer is never touched (artwork preserved). Pair with {@link exitCreatorMode}.
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
    // Target an EXISTING package (Outliner selection → "Package Mode"): adopt it as the creator box,
    // so the enter frames/paints THAT box instead of create-or-reuse-the-previous-one. Ignored if the
    // id is unknown or its node is gone (falls back to the normal enter).
    if (opts.packageId) {
      const t = this.items.get(opts.packageId);
      if (t && (!this.host.nodeExists || this.host.nodeExists(t.box.rootGroupId))) this.creatorId = t.id;
    }
    let s: PackagingState;
    if (this.creatorId) {
      s = this.items.get(this.creatorId)!;                                   // reuse — no duplicate box
      if (opts.params) s = this.setDimensions(s.id, opts.params) ?? s;       // re-dimension in place
    } else {
      s = this.create(opts.style ?? 'simpleBox', opts.params ?? { ...DEFAULT_CREATOR_PARAMS });
    }
    this.creatorId = s.id;
    // Dieline layer: prefer the fresh-aware hook (white-fill ONLY on fresh creation, never on reuse).
    let layerId: string | null;
    if (this.host.ensureDielineLayerInfo) {
      const info = this.host.ensureDielineLayerInfo(s.dielineLayerId);
      layerId = info?.layerId ?? null;
      if (info?.fresh) this.host.fillLayerWhite?.(info.layerId);
    } else {
      layerId = this.host.ensureDielineLayer(s.dielineLayerId);              // legacy host — no fill info
    }
    if (layerId) this.setDielineLayer(s.id, layerId);
    // Stage: measured framing + 3/4 orbit + clean focus bg (host → enterGroupOrbit3D), then the
    // city-mode hygiene extras (suppress box-select, clear hover/selection, view gizmo).
    this.host.frameAndOrbit(s.box.rootGroupId);
    this.host.beginCreatorStage?.();
    if (s.dielineLayerId) this.host.armSurfacePaint(s.box.panels.map(p => p.meshId), s.dielineLayerId);
    this.creatorActive = true;
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
    this.host.endCreatorStage?.();
    this.creatorActive = false;
  }

  /** Live snapshot for the host's Package Creator panel. `packageId` persists across exit (so the
   *  panel can keep driving fold/dims/export on the same box); null until the first enter. */
  getCreatorState(): CreatorState {
    const s = this.creatorId ? this.items.get(this.creatorId) ?? null : null;
    return {
      active: this.creatorActive && s !== null,
      packageId: s?.id ?? null,
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
    const uvToCanvas = this.host.attachPaintPane(uvRenderer);
    if (!uvToCanvas) return null;
    return { uvToCanvas, guides: s.guides, canvasWidth: s.canvasWidth, canvasHeight: s.canvasHeight };
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
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOutQuad
      this.setFoldAmount(id, from + (target - from) * e);
      if (t < 1) this.anim.set(id, requestAnimationFrame(tick));
      else this.anim.delete(id);
    };
    this.anim.set(id, requestAnimationFrame(tick));
  }

  get(id: string): PackagingState | null { return this.items.get(id) ?? null; }
  getAll(): PackagingState[] { return [...this.items.values()]; }

  /** The current guide overlay (cut/fold/bleed/panel, canvas px) — convenience for redrawing after setDimensions. */
  getGuides(id: string): DielineGuide[] { return this.items.get(id)?.guides ?? []; }

  /** Export the dieline canvas (the linked raster layer) as a flat PNG. null if no dieline is linked. */
  async exportDielinePng(id: string): Promise<Blob | null> {
    const s = this.items.get(id);
    if (!s || !s.dielineLayerId) return null;
    return this.host.exportLayerPng(s.dielineLayerId);
  }

  remove(id: string): void {
    const s = this.items.get(id);
    if (!s) return;
    const a = this.anim.get(id);
    if (a != null) cancelAnimationFrame(a);
    this.anim.delete(id);
    if (s.dielineLayerId) for (const p of s.box.panels) this.host.unlinkLiveTexture(p.meshId);
    this.host.removeNode(s.box.rootGroupId);   // deletes the whole panel subtree
    this.items.delete(id);
    if (this.creatorId === id) { this.creatorId = null; this.creatorActive = false; }
  }
}
