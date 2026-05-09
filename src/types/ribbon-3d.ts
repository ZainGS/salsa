/**
 * Ribbon3D types — high-level configuration for spline-based ribbon/banner meshes.
 *
 * A ribbon is a flat quad strip that follows a 3D Catmull-Rom spline path.
 * By default it is double-sided (visible from both faces). Set doubleSided:false
 * to cull the back face, which prevents mirrored text from showing through spirals.
 *
 * See: src/renderer/3d/mesh-generators.ts  generateRibbon()
 *      src/renderer/3d/html-texture-3d.ts  HtmlTexture3D
 *      src/services/managers/scene3d-manager.ts  addRibbon3D(), setHtmlTexture3D()
 */

/**
 * Controls how each cross-section frame is oriented along the ribbon path.
 *
 * - `'normal'`        — Rotation-Minimizing Frame (default). The ribbon lies in the
 *                       plane of the path, rotating naturally with curves. Best for
 *                       ribbons that live in 3D space (architecture, physical banners).
 *
 * - `'world-up'`      — Width direction is always world-Y (up). The ribbon stands
 *                       upright like a wall following the path. Works well for
 *                       ground-level curves; text never flips on horizontal spirals.
 *
 * - `'camera-facing'` — The ribbon face always rotates toward the camera each frame.
 *                       Text is always readable regardless of path direction.
 *                       Requires per-frame geometry rebuild (handled automatically).
 *                       Ideal for scrolling text tickers, labels on spirals, motion
 *                       graphics path animation.
 */
export type RibbonPathMode = 'normal' | 'world-up' | 'camera-facing';

/** One control point on the ribbon's spline path. */
export interface RibbonControlPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Per-mesh ribbon state stored inside Scene3DManager.
 * Tracks everything needed to rebuild the ribbon geometry when the
 * path or UV offset changes (e.g. during a scroll Frame Link animation).
 */
export interface RibbonData {
  /** ID of the Mesh3D node this ribbon drives. */
  meshId: string;
  /** Spline control points in world space (min 2). */
  controlPoints: RibbonControlPoint[];
  /** Ribbon width in world units. */
  width: number;
  /** Curve subdivisions per segment between control points. */
  segments: number;
  /** Current UV scroll offset in U direction (along path). Updated each frame by scroll Frame Link. */
  uvScrollOffset: number;
  /** Current UV scroll offset in V direction (across width). Updated by Y-axis scroll Frame Link. */
  uvScrollOffsetV: number;
  /** Extra UV units added to the end of the ribbon's U range for seamless loop overlap. */
  uvEndPadding: number;
  /**
   * How many times the texture tiles along the ribbon length. Default: 1 (no tiling).
   * Set to N so the texture repeats N times — each tile occupies (ribbonLength/N) world units.
   * Use this to keep text crisp on long ribbons: put one copy of the text in the HTML,
   * let the GPU tile it N times. Combined with scroll animation the text scrolls smoothly.
   */
  uvTileCount: number;
  /** How each cross-section frame is oriented. Default: 'normal'. */
  pathMode: RibbonPathMode;
  /**
   * Which faces of the ribbon are rendered.
   * - `'double'` (default) — both front and back faces are visible.
   * - `'front'`  — only the front face (CCW winding); prevents mirrored text from showing
   *                through the inside of loops and spirals.
   * - `'back'`   — only the back face; useful for inside-of-loop views or reversed ribbons.
   *
   * Legacy boolean values are accepted for backwards compatibility:
   * `true` maps to `'double'`, `false` maps to `'front'`.
   */
  doubleSided: 'double' | 'front' | 'back';
  /**
   * When true, the back face has its U coordinates mirrored so text reads
   * left-to-right from both sides. Only meaningful when doubleSided is true.
   * Default: false.
   */
  flipRearU: boolean;
  /**
   * When false, the canvas overlay will not draw control-point handles for this ribbon.
   * Default: true (handles visible).
   */
  showHandles?: boolean;
  /** ID returned by setHtmlTexture3D(), if an HTML texture is bound to this ribbon. */
  htmlTextureId?: string;
  /** Cached HTML body content for auto-restore after document reload. */
  htmlContent?: string;
  /** Texture width in pixels used when htmlContent was last applied. */
  htmlTextureWidth?: number;
  /** Texture height in pixels used when htmlContent was last applied. */
  htmlTextureHeight?: number;
  /** CSS background color/gradient string for the HTML texture. Default: 'transparent'. */
  htmlTextureBgColor?: string;
  /** When true, text is scaled to fill the full texture width. */
  htmlTextureStretchToFit?: boolean;
}
