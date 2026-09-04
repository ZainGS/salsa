/**
 * View state — the two independent axes of a document: its TARGET (what it produces) and its CAMERA MODE (how you
 * navigate). See docs/specs/free-camera-and-scene-targets.md.
 *
 * The whole feature is NON-DESTRUCTIVE: target + cameraMode are view/intent flags, never a data conversion. The 3D
 * scene graph and the 2D raster/vector layers coexist in one document at all times; `deriveViewRules` turns the two
 * flags into what RENDERS / which tools are active / how the camera moves. The engine orchestration AND the
 * Frogmarks UI both consume `deriveViewRules` — one source of truth for the whole 2×3 matrix.
 */

/** What the document produces. Independent of camera mode. */
export type ViewTarget = 'illustration' | 'scene';
/** How you navigate. Available in BOTH targets (full 2×3 matrix). */
export type CameraMode = 'ortho2D' | 'perspective2D' | 'free3D';

/** Locked 2D camera pose (shared by ortho2D + perspective2D) — pan + zoom, no orbit. */
export interface FlatCamPose { panX: number; panY: number; zoom: number; }
/** Free 3D camera pose (free3D) — an orbit vantage that persists so returning restores where you were. */
export interface FreeCamPose { target: [number, number, number]; radius: number; yaw: number; pitch: number; projection: 'orthographic' | 'perspective'; }

export interface ViewState {
  target: ViewTarget;
  cameraMode: CameraMode;
  flatCam?: FlatCamPose;               // remembered across mode switches / reload
  freeCam?: FreeCamPose;
  showArtboardFrame: boolean;          // illustration × free3D: draw the artboard render-frame OUTLINE
  showArtboardTexture: boolean;        // illustration × free3D: draw the 2D illustration TEXTURED on the artboard plane
}

export const DEFAULT_VIEW_STATE: ViewState = { target: 'illustration', cameraMode: 'ortho2D', showArtboardFrame: true, showArtboardTexture: true };

/** The rendering / interaction rules DERIVED from (target, cameraMode). One source of truth for engine + UI. */
export interface ViewRules {
  /** Render the 2D raster/vector composite inside the artboard scissor rect in the viewport. */
  twoDComposite: boolean;
  /** The artboard X×Y scissor clip is active (== twoDComposite; separate name for intent). */
  artboardScissor: boolean;
  /** 2D raster/vector EDITING tools are usable — Frogmarks shows the 2D panels when true. */
  twoDToolsActive: boolean;
  /** Free navigation (orbit + pan + dolly, later fly) — else locked 2D pan/zoom (no orbit). */
  freeNavigation: boolean;
  /** Camera projection for this mode. */
  projection: 'orthographic' | 'perspective';
  /** Drop the 2D pan/zoom clamps (free roam). */
  unclampCamera: boolean;
  /** Draw the artboard as a live textured frame floating in 3D (illustration × free3D only). */
  artboardFrame: boolean;
  /** The document OUTPUT is the fixed X×Y composite from the artboard/render camera (illustration); else the
   *  interactive scene runtime. This is the viewport-vs-render split: in illustration × free3D the EDIT camera
   *  roams but EXPORT still renders the artboard camera. */
  outputIsArtboard: boolean;
}

/**
 * The single source of truth for the 2×3 matrix. Pure — no engine state. Both the engine orchestration
 * (`setTarget3D`/`setCameraMode3D`) and the Frogmarks UI derive their behaviour from this.
 *
 * NOTE: 3D object tools (add-mesh, gizmos, modifiers, UV-paint) are available in ALL cells — you can put 3D
 * objects in a 2D illustration today, and obviously in a scene. Only the 2D raster/vector tools are gated
 * (hidden in free3D and in the scene target). That's why there's a `twoDToolsActive` flag but no `threeDToolsActive`.
 */
export function deriveViewRules(v: Pick<ViewState, 'target' | 'cameraMode' | 'showArtboardFrame'>): ViewRules {
  const illustration = v.target === 'illustration';
  const free = v.cameraMode === 'free3D';
  const flat2D = illustration && !free;   // the 2D editing surface = illustration seen through a locked 2D camera
  return {
    twoDComposite: flat2D,
    artboardScissor: flat2D,
    twoDToolsActive: flat2D,
    freeNavigation: free,
    projection: v.cameraMode === 'ortho2D' ? 'orthographic' : 'perspective',
    unclampCamera: free,
    artboardFrame: illustration && free && v.showArtboardFrame !== false,
    outputIsArtboard: illustration,
  };
}

/** A stable label per cell (for tooltips / analytics / the toolbar toggle). */
export function viewModeLabel(v: Pick<ViewState, 'target' | 'cameraMode'>): string {
  const t = v.target === 'illustration' ? 'Illustration' : 'Scene';
  const c = v.cameraMode === 'ortho2D' ? '2D Ortho' : v.cameraMode === 'perspective2D' ? '2D Perspective' : '3D Free';
  return `${t} · ${c}`;
}

/** Normalize a possibly-partial/legacy persisted blob into a full ViewState (old saves → illustration/ortho2D). */
export function normalizeViewState(raw: Partial<ViewState> | undefined | null): ViewState {
  if (!raw) return { ...DEFAULT_VIEW_STATE };
  const target: ViewTarget = raw.target === 'scene' ? 'scene' : 'illustration';
  const cameraMode: CameraMode = raw.cameraMode === 'perspective2D' || raw.cameraMode === 'free3D' ? raw.cameraMode : 'ortho2D';
  return {
    target,
    cameraMode,
    flatCam: raw.flatCam,
    freeCam: raw.freeCam,
    showArtboardFrame: raw.showArtboardFrame !== false,
    showArtboardTexture: raw.showArtboardTexture !== false,
  };
}
