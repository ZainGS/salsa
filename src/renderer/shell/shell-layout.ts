/**
 * shell-layout.ts — Pure layout + theming for the Shell UI grid.
 *
 * A **paged** cell grid (3DS-style): a target cell size + a zoom factor set the
 * tile size; the viewport then determines a whole number of columns and rows
 * that fit (no partial rows, no bleed). Overflow pages horizontally via the
 * left/right arrows. Rows reserve extra height for the label beneath each tile.
 *
 * The same bounded grid drives the debossed inset panel, so insets appear only
 * under the tile area (cols × rows), never to the left of / above the grid.
 *
 * Coordinate system: device pixels, origin top-left. No GPU dependency.
 * See docs/specs/shell-ui-upgrade.md.
 */

export type Rgba = [number, number, number, number];

/** Synthetic tile id for the previous/next page arrows. */
export const SHELL_PREV_ID = '__prev_page__';
export const SHELL_NEXT_ID = '__next_page__';

export interface ShellTileSpec {
  id: string;
  kind: 'system' | 'local' | 'remote' | 'project' | 'empty';
  selected: boolean;
  hovered: boolean;
  label?: string;
  /** When set, this tile renders as a 3D coin with this atlas-key icon on its
   *  face (system apps, Install Cart) instead of a flat 2D tile. */
  discIcon?: string;
  /** When true, this tile renders as a spinning iridescent CD (FrogCarts). */
  cd?: boolean;
  /** When set, this tile renders as a spinning Billboard3D cutout of this
   *  atlas-key icon (Install Cart → download arrow). */
  billboardKey?: string;
}

export interface RenderTile {
  id: string;
  /** Tile kind (drives the 3D disc treatment for system apps). */
  kind: ShellTileSpec['kind'];
  /** [x, y, w, h] in device pixels. */
  rect: Rgba;
  fill: Rgba;
  cornerRadius: number;
  selected: boolean;
  hovered: boolean;
  /** Atlas-key for the 3D-coin icon (system apps / Install Cart); when set, the
   *  renderer draws a coin instead of the flat 2D tile. */
  discIcon?: string;
  /** When true, render a spinning iridescent CD instead of a flat tile (carts). */
  cd?: boolean;
  /** Atlas-key for a spinning Billboard3D cutout tile (Install Cart). */
  billboardKey?: string;
}

export interface RenderLabel {
  id: string;
  text: string;
  centerX: number;
  topY: number;
  maxWidthPx: number;
  fontPx: number;
  color: Rgba;
  /** Non-uniform glyph scaling (hand-lettered squash/stretch). Default 1. */
  scaleX?: number;
  scaleY?: number;
  /** Override font stack (e.g. window titlebars). Defaults to the shell font. */
  fontFamily?: string;
}

/** A flat rounded-rect "pill" for chrome (title bar, info badges). */
export interface RenderBadge {
  /** [x, y, w, h] in device px. */
  rect: Rgba;
  fill: Rgba;
  corner: number;
}

/** A Win9x window frame drawn as a chrome overlay: a raised bevel + a green
 *  title bar (+ faux ✕) + a separator line, with a transparent interior so the
 *  region's existing content shows through. The title text is a separate
 *  RenderLabel positioned by the manager. */
export interface RenderWindow {
  /** [x, y, w, h] in device px. */
  rect: Rgba;
  /** Title bar height (px). 0 = bevel frame only, no title bar. */
  titleH: number;
  /** Title-bar buttons: a faux ✕ (default), or working zoom −/+ buttons. */
  controls?: 'close' | 'zoom';
}

/** A clickable circular page arrow. */
export interface ArrowSpec {
  id: string;
  cx: number;
  cy: number;
  radius: number;
  /** +1 = points right (next), -1 = points left (prev). */
  dir: number;
  hovered: boolean;
}

/** Cell-grid parameters shared by the tile layout and the inset panel. */
export interface GridParams {
  left: number;
  top: number;
  colPitch: number;
  rowPitch: number;
  tileSize: number;
  corner: number;
  columns: number;
  rows: number;
  regionTop: number;
  regionHeight: number;
  /** Floating frosted card rect (px) + corner radius. */
  cardX: number;
  cardY: number;
  cardW: number;
  cardH: number;
  cardCorner: number;
  /** Title-bar height (px) reserved at the top of the panel window. */
  panelTitleH: number;
}

export interface ViewerSpec {
  kind: 'cartridge' | 'sketchbook' | 'cd' | 'box';
  bodyColor: Rgba;
  labelColor: Rgba;
  /** When set, the viewer renders the Billboard3D cutout mesh registered under
   *  this key (a system-app icon) instead of the cartridge/sketchbook. */
  billboardKey?: string;
  /** Cut-edge color for the billboard cutout. Default white. */
  sideColor?: Rgba;
  /** Extra scale multiplier for the mesh (e.g. a larger logo). Default 1. */
  scale?: number;
  /** Mirror the back face at edge-on so spinning TEXT never reads backwards
   *  (the hero logo). Off for symbol icons (pencil, gear, …), which should spin
   *  naturally and show both sides. */
  mirrorBack?: boolean;
  /** Weightless "facing you" float instead of a full Y-spin (the hero logo). */
  floaty?: boolean;
  /** 3D themes: idle motion is a gentle ±30° sway, not a full Y-spin (keeps the icons readable). */
  swayOnly?: boolean;
}

export interface ShellRenderModel {
  bgTop: Rgba;
  bgBottom: Rgba;
  panelColor: Rgba;
  insetColor: Rgba;
  tiles: RenderTile[];
  labels: RenderLabel[];
  arrows: ArrowSpec[];
  /** Chrome pills (title, info badges) — filled in by the manager. */
  badges: RenderBadge[];
  /** Win9x window frames (chrome overlays) — bottom panel, viewer, etc. */
  windows?: RenderWindow[];
  grid: GridParams;
  /** Current page index and total page count (after clamping). */
  page: number;
  pageCount: number;
  viewer?: ViewerSpec;
  viewerThumbId?: string;
  viewerFraction: number;
  /** Tile currently focused (shows the green timer ring). */
  ringTileId?: string;
  /** When the countdown began (performance.now()/1000). Undefined = paused/full
   *  (the pointer is still over the tile, so the ring stays full). */
  ringCountdownStart?: number;
  /** Dominant accent (themed): outlines, ink rings, chrome text. */
  ink: Rgba;
  /** Riso duotone (A,B) + flags, themed. */
  accentA: Rgba;
  accentB: Rgba;
  rainbow: boolean;
  dark: boolean;
  /** True = draw the 3D wireframe grid backdrop (Polygon theme) instead of the riso blob+squiggles. */
  backdropGrid: boolean;
  /** Backdrop sticker (themed): blob gradient stops, squiggle fill, and the
   *  bottom-panel border color. */
  blobA: Rgba;
  blobB: Rgba;
  squiggle: Rgba;
  panelBorder: Rgba;
  /** Billboard3D cutout outline color (cut edge + baked rim), themed. */
  billboardOutline: Rgba;
  /** Illustrations mode: full-screen curved floating thumbnail grid (one card
   *  per project). When present, the renderer fades the home layers and draws
   *  this instead. */
  projectGrid?: ProjectGridItem[];
  /** Total scrollable content height (px) of the project grid, for clamping. */
  gridContentHeight?: number;
  /** Cross-fade: 0 = shell home, 1 = illustrations grid. */
  modeFade?: number;
}

/** One card in the illustrations thumbnail grid. */
export interface ProjectGridItem {
  id: string;
  /** Base (pre-curve) screen rect [x, y, w, h] in device px, scroll applied. */
  rect: Rgba;
  /** 1 while hovered (drives the lift/brighten), else 0. */
  hover: number;
}

export interface ShellTheme {
  bgTop: Rgba;
  bgBottom: Rgba;
  panelColor: Rgba;
  insetColor: Rgba;
  systemFill: Rgba;
  localFill: Rgba;
  remoteFill: Rgba;
  projectFill: Rgba;
  emptyFill: Rgba;
  viewerFraction: number;
  /** Column pitch as a fraction of viewport width (before zoom). */
  cellFrac: number;
  /** Tile size as a fraction of the column pitch. */
  tileFrac: number;
  /** Extra row height for the label, as a fraction of tile size. */
  labelBandFrac: number;
  /** Outer padding as a fraction of viewport width. */
  paddingFrac: number;
  /** Side zones reserved for the page arrows, as a fraction of viewport width. */
  arrowZoneFrac: number;
  cornerFrac: number;
  labelFontFrac: number;
  labelColor: Rgba;
  /** Dominant accent: tile/panel outlines, slot ink rings, chrome text. */
  ink: Rgba;
  /** Greeting + cart-count TEXT color. Optional — defaults to `ink` when absent (Polygon sets it white
   *  so the text reads on black while the accents stay green). */
  chromeText?: Rgba;
  /** Riso slot-circle / pattern duotone (A,B). On light themes they're
   *  multiplicative ink filters; on dark themes (see `dark`) they blend. */
  accentA: Rgba;
  accentB: Rgba;
  /** Slot placeholder patterns use the full rainbow palette (else accentA/B). */
  rainbow: boolean;
  /** Dark theme — riso circles blend (additive-ish) instead of multiply. */
  dark: boolean;
  /** Backdrop style: false = the riso sticker (blob + squiggle ribbons); true = a 3D wireframe grid
   *  surface (the "Polygon" theme — reads like a 3D viewport). `squiggle` is reused as the grid-line color. */
  backdropGrid: boolean;
  /** Backdrop sticker: blob gradient stops + squiggle fill (themed), and the
   *  bottom-panel border (light for frog/pinwheel, ink-grey for moon). */
  blobA: Rgba;
  blobB: Rgba;
  squiggle: Rgba;
  panelBorder: Rgba;
  /** Billboard3D cutout outline (cut edge + baked rim): cream/beige (pinwheel),
   *  dark green (frog), very dark grey (moon). */
  billboardOutline: Rgba;
  /** Floating card: side margin (frac of W), gap below viewer + bottom gap
   *  (frac of H), and corner radius (frac of min(cardW, cardH)). */
  cardMarginXFrac: number;
  cardGapTopFrac: number;
  cardGapBottomFrac: number;
  cardCornerFrac: number;
}

// Cream-paper / risograph "inked" palette.
//   cream  #EFE6D0  ink-blue #1A4C7C  red #E23B2E  yellow #F4C842
export const DEFAULT_SHELL_THEME: ShellTheme = {
  bgTop:       [0.945, 0.910, 0.825, 1],   // cream paper (slightly lighter at top)
  bgBottom:    [0.905, 0.860, 0.760, 1],
  panelColor:  [0.965, 0.940, 0.870, 1],   // off-white card
  insetColor:  [0.860, 0.805, 0.700, 1],   // recessed tan slot
  systemFill:  [0.985, 0.965, 0.910, 1],   // near-white tile
  localFill:   [0.96, 0.86, 0.66, 1],      // warm yellow-cream
  remoteFill:  [0.80, 0.86, 0.92, 1],      // pale blue
  projectFill: [0.985, 0.965, 0.910, 1],
  emptyFill:   [0.905, 0.855, 0.745, 1],
  viewerFraction: 0.40,
  cellFrac: 0.102,
  tileFrac: 0.78,
  labelBandFrac: 0.42,
  paddingFrac: 0.025,
  arrowZoneFrac: 0.035,
  cornerFrac: 0.18,
  labelFontFrac: 0.15,
  labelColor: [0.102, 0.298, 0.486, 1],   // ink-blue text on cream
  ink: [0.102, 0.298, 0.486, 1],          // ink-blue accent
  accentA: [0.14, 0.15, 0.17, 1],         // riso black (filter)
  accentB: [0.50, 0.82, 0.45, 1],         // riso green (filter)
  rainbow: true,                          // pinwheel keeps the full pattern palette
  dark: false,
  backdropGrid: false,                    // riso sticker by default (Polygon flips this on)
  blobA:       [0.96, 0.42, 0.62, 1],     // warm sticker: pink →
  blobB:       [0.97, 0.84, 0.36, 1],     //               → yellow
  squiggle:    [0.52, 0.79, 0.45, 1],     // green squiggle fill
  panelBorder: [0.992, 0.978, 0.935, 1],  // light cream border (lighter than panel)
  billboardOutline: [0.93, 0.89, 0.78, 1], // light warm cream cutout outline
  cardMarginXFrac: 0.028,
  cardGapTopFrac: 0.015,
  cardGapBottomFrac: 0.035,
  cardCornerFrac: 0.05,
};

/** Named color themes (the Themes app switches between these). */
export type ShellThemeName = 'pinwheel' | 'frog' | 'moon' | 'polygon' | 'prism' | 'lattice';

// 3D-viewport base (Polygon + its colour variants): near-black scene + wireframe grid; UI mirrors Moon's
// dark palette. `squiggle` = the grid-line colour (also drives the window titlebar on 3D themes via globals).
const POLYGON_3D_BASE: ShellTheme = {
  ...DEFAULT_SHELL_THEME,
  backdropGrid: true,
  squiggle:    [0.46, 0.66, 0.44, 1],
  bgTop:       [0.0, 0.0, 0.0, 1],
  bgBottom:    [0.0, 0.0, 0.0, 1],
  panelColor:  [0.116, 0.120, 0.128, 1],
  insetColor:  [0.060, 0.070, 0.062, 1],
  systemFill:  [0.180, 0.205, 0.185, 1],
  localFill:   [0.225, 0.255, 0.230, 1],
  remoteFill:  [0.195, 0.225, 0.200, 1],
  projectFill: [0.180, 0.205, 0.185, 1],
  emptyFill:   [0.095, 0.110, 0.098, 1],
  labelColor:  [0.870, 0.910, 0.880, 1],
  ink:         [0.46, 0.66, 0.44, 1],
  accentA:     [0.05, 0.05, 0.06, 1],
  accentB:     [0.78, 0.80, 0.83, 1],
  rainbow:     false,
  dark:        true,
  panelBorder: [0.300, 0.620, 0.360, 1],
  billboardOutline: [0.12, 0.16, 0.13, 1],
};

export const SHELL_THEMES: Record<ShellThemeName, ShellTheme> = {
  // Current cream / riso look.
  pinwheel: DEFAULT_SHELL_THEME,
  // Sage green + black.
  frog: {
    ...DEFAULT_SHELL_THEME,
    blobA:       [0.46, 0.74, 0.46, 1],      // fresh sticker: green → lime
    blobB:       [0.83, 0.90, 0.48, 1],
    squiggle:    [0.30, 0.55, 0.32, 1],      // deep-green squiggle fill
    panelBorder: [0.952, 0.968, 0.910, 1],   // light sage border (lighter than panel)
    billboardOutline: [0.13, 0.22, 0.13, 1], // dark green cutout outline
    bgTop:       [0.862, 0.902, 0.820, 1],
    bgBottom:    [0.792, 0.844, 0.736, 1],
    panelColor:  [0.902, 0.930, 0.852, 1],
    insetColor:  [0.740, 0.812, 0.660, 1],
    systemFill:  [0.930, 0.948, 0.880, 1],
    localFill:   [0.806, 0.860, 0.610, 1],
    remoteFill:  [0.745, 0.840, 0.700, 1],
    projectFill: [0.930, 0.948, 0.880, 1],
    emptyFill:   [0.800, 0.852, 0.720, 1],
    labelColor:  [0.110, 0.165, 0.090, 1],
    ink:         [0.090, 0.130, 0.075, 1],   // near-black green
    accentA:     [0.46, 0.70, 0.40, 1],      // riso green (filter)
    accentB:     [0.12, 0.16, 0.10, 1],      // riso black-green (filter)
    rainbow:     false,                      // green/black patterns
    dark:        false,
  },
  // Near-black / very dark grey (dark theme — light text, black/white riso).
  moon: {
    ...DEFAULT_SHELL_THEME,
    blobA:       [0.33, 0.34, 0.40, 1],      // nocturnal glow: cool grey → grey-violet
    blobB:       [0.46, 0.45, 0.50, 1],
    squiggle:    [0.68, 0.70, 0.79, 1],      // slightly darker pale squiggle fill (reads on dark)
    panelBorder: [0.820, 0.830, 0.845, 1],   // keep the light-grey ink border
    billboardOutline: [0.13, 0.13, 0.15, 1], // very dark grey cutout outline
    bgTop:       [0.110, 0.115, 0.125, 1],
    bgBottom:    [0.055, 0.058, 0.065, 1],
    panelColor:  [0.140, 0.145, 0.155, 1],
    insetColor:  [0.085, 0.088, 0.095, 1],
    systemFill:  [0.205, 0.210, 0.225, 1],
    localFill:   [0.260, 0.265, 0.280, 1],
    remoteFill:  [0.225, 0.230, 0.245, 1],
    projectFill: [0.205, 0.210, 0.225, 1],
    emptyFill:   [0.120, 0.124, 0.132, 1],
    labelColor:  [0.860, 0.870, 0.885, 1],
    ink:         [0.820, 0.830, 0.845, 1],   // light grey outlines
    accentA:     [0.05, 0.05, 0.06, 1],      // black (direct, blended)
    accentB:     [0.90, 0.92, 0.95, 1],      // white (direct, blended)
    rainbow:     false,                      // black/white patterns
    dark:        true,                       // blend circles so white shows on dark
  },
  // 3D viewport — GREEN wireframe grid on black (the original 3D theme). squiggle = grid green = titlebar green.
  polygon: POLYGON_3D_BASE,
  // 3D viewport — icy BLUE grid variant of Polygon.
  prism: {
    ...POLYGON_3D_BASE,
    squiggle:    [0.36, 0.66, 0.96, 1],
    ink:         [0.40, 0.68, 0.97, 1],
    panelBorder: [0.26, 0.45, 0.66, 1],
    labelColor:  [0.80, 0.88, 0.97, 1],
    bgTop:       [0.0, 0.006, 0.022, 1],     // near-black with a faint blue cast
    bgBottom:    [0.0, 0.006, 0.022, 1],
    insetColor:  [0.055, 0.065, 0.085, 1],
    systemFill:  [0.160, 0.190, 0.235, 1],
    localFill:   [0.200, 0.235, 0.285, 1],
    remoteFill:  [0.175, 0.205, 0.255, 1],
    projectFill: [0.160, 0.190, 0.235, 1],
    emptyFill:   [0.090, 0.105, 0.135, 1],
    billboardOutline: [0.12, 0.15, 0.18, 1],
  },
  // 3D viewport — warm AMBER/gold grid variant of Polygon.
  lattice: {
    ...POLYGON_3D_BASE,
    squiggle:    [0.96, 0.72, 0.30, 1],
    ink:         [0.97, 0.74, 0.34, 1],
    panelBorder: [0.60, 0.46, 0.20, 1],
    labelColor:  [0.96, 0.90, 0.78, 1],
    bgTop:       [0.022, 0.014, 0.0, 1],     // near-black with a faint warm cast
    bgBottom:    [0.022, 0.014, 0.0, 1],
    insetColor:  [0.085, 0.072, 0.050, 1],
    systemFill:  [0.215, 0.190, 0.150, 1],
    localFill:   [0.255, 0.225, 0.175, 1],
    remoteFill:  [0.225, 0.200, 0.155, 1],
    projectFill: [0.215, 0.190, 0.150, 1],
    emptyFill:   [0.115, 0.100, 0.075, 1],
    billboardOutline: [0.16, 0.14, 0.10, 1],
  },
};

function fillFor(kind: ShellTileSpec['kind'], theme: ShellTheme): Rgba {
  switch (kind) {
    case 'system':  return theme.systemFill;
    case 'local':   return theme.localFill;
    case 'remote':  return theme.remoteFill;
    case 'project': return theme.projectFill;
    case 'empty':   return theme.emptyFill;
  }
}

function emptyGrid(): GridParams {
  return { left: 0, top: 0, colPitch: 1, rowPitch: 1, tileSize: 1, corner: 0, columns: 1, rows: 0, regionTop: 0, regionHeight: 0, cardX: 0, cardY: 0, cardW: 0, cardH: 0, cardCorner: 0, panelTitleH: 0 };
}

export interface LayoutOpts {
  /** Current page (clamped internally). */
  page?: number;
  /** Tile-size multiplier (zoom). */
  zoom?: number;
}

export function computeShellLayout(
  viewportW: number,
  viewportH: number,
  specs: ShellTileSpec[],
  opts: LayoutOpts = {},
  theme: ShellTheme = DEFAULT_SHELL_THEME,
): ShellRenderModel {
  const tiles: RenderTile[] = [];
  const labels: RenderLabel[] = [];
  const arrows: ArrowSpec[] = [];
  const base = {
    bgTop: theme.bgTop, bgBottom: theme.bgBottom,
    panelColor: theme.panelColor, insetColor: theme.insetColor,
    tiles, labels, arrows, badges: [] as RenderBadge[], viewerFraction: theme.viewerFraction,
    ink: theme.ink, accentA: theme.accentA, accentB: theme.accentB,
    rainbow: theme.rainbow, dark: theme.dark, backdropGrid: theme.backdropGrid,
    blobA: theme.blobA, blobB: theme.blobB, squiggle: theme.squiggle, panelBorder: theme.panelBorder,
    billboardOutline: theme.billboardOutline,
  };
  if (viewportW <= 0 || viewportH <= 0) {
    return { ...base, grid: emptyGrid(), page: 0, pageCount: 1 };
  }

  const zoom = Math.max(0.5, Math.min(1.4, opts.zoom ?? 1));
  const arrowZone = theme.arrowZoneFrac * viewportW;
  const colPitch = Math.max(8, theme.cellFrac * viewportW * zoom);
  const tileSize = colPitch * theme.tileFrac;
  const corner = tileSize * theme.cornerFrac;
  const labelBand = tileSize * theme.labelBandFrac;
  const rowPitch = colPitch + labelBand;
  const fontPx = tileSize * theme.labelFontFrac;
  const vGap = colPitch - tileSize;

  // Floating frosted card, inset from the screen edges.
  const regionTop = theme.viewerFraction * viewportH;
  const cardX = theme.cardMarginXFrac * viewportW;
  const cardY = regionTop + theme.cardGapTopFrac * viewportH;
  const cardW = viewportW - 2 * cardX;
  const cardH = viewportH - cardY - theme.cardGapBottomFrac * viewportH;
  const cardCorner = 0;                          // sharp Win9x window corners
  const panelTitleH = Math.max(20, Math.round(viewportH * 0.028));
  const regionHeight = viewportH - regionTop;

  // Fit whole columns/rows inside the card BELOW the title bar (arrows live in
  // the side zones), then center the grid in the remaining area.
  const gridAvailW = cardW - 2 * arrowZone;
  const columns = Math.max(1, Math.floor(gridAvailW / colPitch));
  const gridAvailH = cardH - panelTitleH;
  const rows = Math.max(1, Math.floor(gridAvailH / rowPitch));

  const left = cardX + (cardW - columns * colPitch) / 2;
  const top = cardY + panelTitleH + (cardH - panelTitleH - rows * rowPitch) / 2;

  const grid: GridParams = {
    left, top, colPitch, rowPitch, tileSize, corner, columns, rows,
    regionTop, regionHeight, cardX, cardY, cardW, cardH, cardCorner, panelTitleH,
  };

  const pageSize = columns * rows;
  const pageCount = Math.max(1, Math.ceil(specs.length / pageSize));
  const page = Math.max(0, Math.min(opts.page ?? 0, pageCount - 1));
  const pageSpecs = specs.slice(page * pageSize, page * pageSize + pageSize);

  pageSpecs.forEach((spec, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const cx = left + (col + 0.5) * colPitch;
    const rowTop = top + row * rowPitch;
    const y = rowTop + vGap * 0.5;
    const x = cx - tileSize / 2;

    tiles.push({
      id: spec.id,
      kind: spec.kind,
      discIcon: spec.discIcon,
      cd: spec.cd,
      billboardKey: spec.billboardKey,
      rect: [x, y, tileSize, tileSize],
      fill: fillFor(spec.kind, theme),
      cornerRadius: corner,
      selected: spec.selected,
      hovered: spec.hovered,
    });

    if (spec.label) {
      labels.push({
        id: spec.id,
        text: spec.label,
        centerX: cx,
        topY: y + tileSize + labelBand * 0.12,
        maxWidthPx: colPitch * 0.98,
        fontPx,
        color: spec.selected ? [0.886, 0.231, 0.180, 1] : theme.labelColor, // red when selected
      });
    }
  });

  // Page arrows in the card's side zones, vertically centered in the card.
  // The manager sets `hovered` after layout (it knows the hovered id).
  const arrowR = arrowZone * 0.42;
  const arrowCY = cardY + cardH * 0.5;
  if (page > 0) {
    arrows.push({ id: SHELL_PREV_ID, cx: cardX + arrowZone * 0.5, cy: arrowCY, radius: arrowR, dir: -1, hovered: false });
  }
  if (page < pageCount - 1) {
    arrows.push({ id: SHELL_NEXT_ID, cx: cardX + cardW - arrowZone * 0.5, cy: arrowCY, radius: arrowR, dir: 1, hovered: false });
  }

  return { ...base, grid, page, pageCount };
}

// ── Illustrations project grid ───────────────────────────────────────
//
// A full-screen floating grid of square thumbnail cards, mapped onto a
// horizontal cylinder (columns angle back at the L/R edges, rows stay level).
// The curve is a screen-space parabola so the CPU (hit-testing) and the GPU
// (vertex shader) can apply the exact same transform.

/** Edge recession of the grid curve (0 = flat). Tunable; "slight". */
export const GRID_CURVE = 0;

/** Project a base screen-x (px) through the grid curve → {scale, projected x}.
 *  Columns near the L/R edges shrink and pull toward center (the cylinder). */
export function gridProjectX(cx: number, viewportW: number): { sc: number; projX: number } {
  const ncx = viewportW > 0 ? (cx - viewportW / 2) / (viewportW / 2) : 0;
  const sc = 1 - GRID_CURVE * ncx * ncx;
  return { sc, projX: viewportW / 2 + (cx - viewportW / 2) * sc };
}

/**
 * Lay out the illustrations thumbnail grid: square cards in a centered,
 * full-bleed column grid (no panel), with vertical `scrollY` applied. Returns
 * the cards (base rects, pre-curve) + total content height for scroll clamping.
 */
export function computeProjectGrid(
  viewportW: number,
  viewportH: number,
  ids: string[],
  scrollY: number,
): { items: ProjectGridItem[]; contentHeight: number; cols: number } {
  if (viewportW <= 0 || viewportH <= 0 || ids.length === 0) {
    return { items: [], contentHeight: 0, cols: 1 };
  }
  // Dense gallery of small landscape (16:9) cards, like the Frogmarks dashboard.
  const sideMargin = viewportW * 0.03;
  const usableW = viewportW - 2 * sideMargin;
  const targetTileW = viewportW * 0.17;         // aim ~5 columns (room for titled windows)
  const gap = viewportW * 0.006;
  let cols = Math.max(1, Math.round((usableW + gap) / (targetTileW + gap)));
  cols = Math.min(cols, ids.length);
  const tileW = (usableW - (cols - 1) * gap) / cols;
  const tileH = tileW * 0.66;                    // title bar + ~16:9 content below
  const rowGap = viewportH * 0.012;
  const topMargin = viewportH * 0.13;           // room for the top chips
  const rows = Math.ceil(ids.length / cols);

  const items: ProjectGridItem[] = [];
  for (let i = 0; i < ids.length; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    const x = sideMargin + col * (tileW + gap);
    const y = topMargin + row * (tileH + rowGap) - scrollY;
    items.push({ id: ids[i], rect: [x, y, tileW, tileH], hover: 0 });
  }
  const contentHeight = topMargin + rows * tileH + (rows - 1) * rowGap + viewportH * 0.05;
  return { items, contentHeight, cols };
}

/** Hit-test the curved project grid (top-most card). Mirrors the GPU curve so
 *  the picked rect matches what's drawn. Returns the project id or null. */
export function hitTestProjectGrid(model: ShellRenderModel, px: number, py: number, viewportW: number): string | null {
  const grid = model.projectGrid;
  if (!grid) return null;
  for (let i = grid.length - 1; i >= 0; i--) {
    const [x, y, w, h] = grid[i].rect;
    const { sc, projX } = gridProjectX(x + w / 2, viewportW);
    const hw = (w / 2) * sc, hh = (h / 2) * sc;
    const cy = y + h / 2;
    if (px >= projX - hw && px <= projX + hw && py >= cy - hh && py <= cy + hh) return grid[i].id;
  }
  return null;
}

/**
 * Hit-test the title-bar CLOSE (✕) button of a project card → returns that card's id (a delete-intent target),
 * else null. The button geometry MUST match the one drawn in GRID_SHADER's fragment shader (shell-renderer):
 * a `bs`-square button inset at the top-right of the `titleH` title bar. Card-local px are mapped into the same
 * curved/scaled screen space the card is drawn + hit-tested in (`projX - hw + xLocal*sc`, `cy - hh + yLocal*sc`).
 */
export function hitTestProjectGridClose(model: ShellRenderModel, px: number, py: number, viewportW: number): string | null {
  const grid = model.projectGrid;
  if (!grid) return null;
  for (let i = grid.length - 1; i >= 0; i--) {
    const [x, y, w, h] = grid[i].rect;
    const { sc, projX } = gridProjectX(x + w / 2, viewportW);
    const hw = (w / 2) * sc, hh = (h / 2) * sc;
    const cy = y + h / 2;
    const b = Math.min(Math.max(Math.min(w, h) * 0.012, 1.5), 2.5);
    const titleH = Math.max(9, h * 0.10);
    const bs = titleH * 0.70;
    const bx1 = w - 2 * b - b * 1.5, bx0 = bx1 - bs;   // card-local button box (matches the shader)
    const by0 = 2 * b + (titleH - bs) * 0.5, by1 = by0 + bs;
    const pad = 2 * sc;                                 // a touch of slop so the small button is easy to hit
    const l = projX - hw + bx0 * sc - pad, r = projX - hw + bx1 * sc + pad;
    const t = cy - hh + by0 * sc - pad, bm = cy - hh + by1 * sc + pad;
    if (px >= l && px <= r && py >= t && py <= bm) return grid[i].id;
  }
  return null;
}

/**
 * Hit-test a pointer (device px) against tiles, then page arrows (circle).
 * Returns the topmost hit id or null.
 */
export function hitTestTiles(model: ShellRenderModel, px: number, py: number): string | null {
  for (let i = model.tiles.length - 1; i >= 0; i--) {
    const [x, y, w, h] = model.tiles[i].rect;
    if (px >= x && px <= x + w && py >= y && py <= y + h) return model.tiles[i].id;
  }
  for (const a of model.arrows) {
    const dx = px - a.cx, dy = py - a.cy;
    if (dx * dx + dy * dy <= a.radius * a.radius * 1.4) return a.id;
  }
  return null;
}
