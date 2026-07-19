/**
 * ShellRenderer — WebGPU renderer for the Frogmarks Shell UI.
 *
 * Layered, console-style ("3DS") look, all in one command encoder:
 *   1. Background  — vertical gradient (fullscreen triangle).
 *   2. Inset panel — a debossed repeating grid of empty slots (SDF).
 *   3. Tiles       — raised rounded squares with a drop shadow, beveled rim
 *                    (finite-difference SDF normal), specular sheen, optional
 *                    thumbnail, animated hover-lift + selection ring.
 *   4. Labels      — textured quads from the Canvas-2D label atlas.
 *   5. Viewer      — the 3D cartridge/sketchbook (own depth pass, top region).
 *
 * "3D" here is layered depth + parallax + SDF bevel/shadow rather than thick
 * extruded geometry — which matches the 3DS reference and keeps every layer a
 * single draw. Per-tile hover/select state is eased over time in this class;
 * pointer position drives parallax between the panel and tile layers.
 *
 * The pipeline targets the same swapchain + premultiplied-alpha context as the
 * editor renderer (which is hard-suspended while the shell is mounted).
 * See docs/specs/shell-ui-upgrade.md.
 */

import { mat4 } from 'gl-matrix';
import type { ShellRenderModel } from './shell-layout';
import { GRID_CURVE } from './shell-layout';
import { ShellLabelAtlas } from './shell-text';
import { ShellThumbnailAtlas } from './shell-thumbnails';
import { CartridgeViewer } from './shell-cartridge';
import { ShellHtmlLayer } from './shell-html-layer';

export const FONT_FAMILY = '"Bungee", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Window titlebar font: classic Win/Japanese system font (MS PGothic, native
 *  on Windows) → DotGothic16 (a free pixel lookalike, loaded as a webfont for
 *  everyone else) → generic sans-serif. The early-2000s Japanese-web look. */
export const TITLEBAR_FONT = '"MS PGothic", "DotGothic16", sans-serif';

/**
 * Load the Bungee web font (blocky, square letterforms) once. The shell
 * rasterizes text via Canvas 2D, so the font must resolve BEFORE the atlas
 * builds or it silently falls back. Idempotent; resolves even on failure
 * (degrades to the system fallback). The host can also self-host Bungee — if a
 * CSP blocks fonts.googleapis.com this will just fall back.
 */
let _fontPromise: Promise<void> | null = null;
export function ensureShellFont(): Promise<void> {
  if (_fontPromise) return _fontPromise;
  _fontPromise = (async () => {
    if (typeof document === 'undefined' || !document.fonts) return;
    try {
      const ID = 'shell-fonts';
      if (!document.getElementById(ID)) {
        const link = document.createElement('link');
        link.id = ID;
        link.rel = 'stylesheet';
        // Bungee (display/labels) + DotGothic16 (titlebar fallback for non-Windows).
        link.href = 'https://fonts.googleapis.com/css2?family=Bungee&family=DotGothic16&display=swap';
        document.head.appendChild(link);
      }
      await Promise.all([
        document.fonts.load('400 32px "Bungee"'),
        document.fonts.load('400 32px "DotGothic16"'),
      ]);
    } catch { /* fall back to the system fonts */ }
  })();
  return _fontPromise;
}

/** Tile instance: rect(16) + fill(16) + params(16) + uvRect(16) + anim(16). */
const TILE_STRIDE = 80;
/** Label instance: rect(16) + uv(16) + color(16). */
const LABEL_STRIDE = 48;
const INITIAL_TILE_CAP = 64;
const INITIAL_LABEL_CAP = 64;
/** Project-grid instance: center+half(16) + uvRect(16) + info(16). */
const GRID_STRIDE = 48;
const INITIAL_GRID_CAP = 64;
/** Window-frame instance: rect(16) + params(16, .x = titleH). */
const WINDOW_STRIDE = 32;
/** Globals UBO: base(32) + ink(16) + accentA(16) + accentB(16) = 80. */
const GLOBALS_SIZE = 144;
/** Background UBO: top(16)+bottom(16)+time(16) = 48. */
const BG_SIZE = 48;
/** Panel UBO: origin(8)+colPitch(4)+rowPitch(4)+inset(4)+corner(4)+cols(4)+rows(4)+cardCorner(4)+occupied(4)+pad2(8)+panel(16)+insetCol(16)+card(16)+region(16) = 112. */
const PANEL_SIZE = 112;
/** Arrow instance: a(16: cx,cy,radius,dir) + b(16: hover,_,_,_) = 32. */
const ARROW_STRIDE = 32;
/** Badge instance: rect(16) + fill(16) + params(16: corner,_,_,_) = 48. */
const BADGE_STRIDE = 48;
/** Ring instance: a(16: cx, cy, tileSize, progress). */
const RING_STRIDE = 16;
/** Dwell duration before a hovered tile auto-unfocuses. */
const RING_SECONDS = 3;

const GLOBALS_WGSL = /* wgsl */ `
struct Globals { size: vec2<f32>, time: f32, mount: f32, pointer: vec2<f32>, rainbow: f32, dark: f32, ink: vec4<f32>, accentA: vec4<f32>, accentB: vec4<f32>, blobA: vec4<f32>, blobB: vec4<f32>, squiggle: vec4<f32>, panelBorder: vec4<f32> };
`;

const BG_SHADER = /* wgsl */ `
struct Bg { top: vec4<f32>, bottom: vec4<f32>, time: vec4<f32> };
@group(0) @binding(0) var<uniform> bg: Bg;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  let xy = pts[vi];
  var out: VsOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = xy * 0.5 + vec2<f32>(0.5, 0.5);   // uv.y = 1 at top of screen
  return out;
}

fn blob(uv: vec2<f32>, c: vec2<f32>, r: f32) -> f32 {
  let d = distance(uv, c) / r;
  return exp(-d * d * 2.2);
}

fn hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

// Triangle SDF (pointing up), centered, for the AC-style confetti motif.
fn sdTri(p: vec2<f32>, r: f32) -> f32 {
  let k = sqrt(3.0);
  var q = vec2<f32>(abs(p.x) - r, p.y + r / k);
  if (q.x + k * q.y > 0.0) { q = vec2<f32>(q.x - k * q.y, -k * q.x - q.y) / 2.0; }
  q.x = q.x - clamp(q.x, -2.0 * r, 0.0);
  return -length(q) * sign(q.y);
}

// One decorative layer → a scalar coverage (jittered SOLID dots + triangles,
// thin AA edge). Two scales are max-combined so shapes stay solid (no overlap
// darkening).
fn ephemeraLayer(uv: vec2<f32>, aspect: f32, scale: f32, seed: vec2<f32>) -> f32 {
  let g = uv * vec2<f32>(scale * aspect, scale) + seed;
  let cell = floor(g);
  let f = fract(g) - vec2<f32>(0.5, 0.5);
  let r = hash21(cell + seed);
  let r2 = hash21(cell + seed + vec2<f32>(5.2, 1.3));
  let present = step(0.5, r2);
  let jit = (vec2<f32>(r, r2) - vec2<f32>(0.5, 0.5)) * 0.5;
  let p = f - jit;
  let sz = 0.09 + 0.05 * r;
  var shape = 1.0 - smoothstep(sz - 0.012, sz, length(p));        // solid dot
  if (r > 0.72) { shape = 1.0 - smoothstep(-0.006, 0.006, sdTri(p, sz)); } // solid triangle
  return shape * present;
}

fn ephemera(uv: vec2<f32>, aspect: f32) -> f32 {
  let a = ephemeraLayer(uv, aspect, 8.0, vec2<f32>(0.0, 0.0));
  let b = ephemeraLayer(uv, aspect, 13.0, vec2<f32>(3.7, 2.1));
  return max(a, b);
}

// Tiny drifting white SPECKS (Polygon theme particle): a sparse hash-grid of sub-pixel dots that slowly
// float up with a faint sway + twinkle. One grid layer; specks() stacks two for parallax depth.
fn speckLayer(uv: vec2<f32>, aspect: f32, t: f32, scale: f32, seed: vec2<f32>, drift: f32) -> vec3<f32> {
  let p = uv + vec2<f32>(sin(t * 0.05 + seed.x) * 0.008, t * drift);   // rise (up) + gentle sway
  let g = p * vec2<f32>(scale * aspect, scale) + seed;
  let cellX = floor(g.x);
  let cellY = floor(g.y);
  let headStep = -sign(drift);                           // cell-Y step toward the head (rise → cells above)
  let tailLen = 2.6;                                     // tail length in CELL units (bigger = longer)
  // Long comet tails cross cell boundaries, so each fragment also samples the cells toward the head: a speck
  // a few cells "ahead" trails its tail down into this fragment. Keep the brightest contribution. The loop
  // range must be >= tailLen (rounded up) or the far end of the tail gets clipped.
  var cov = 0.0;
  for (var k = 0; k <= 3; k = k + 1) {
    let hcell = vec2<f32>(cellX, cellY + f32(k) * headStep);   // candidate head cell (same X column)
    let r  = hash21(hcell + seed);
    let r2 = hash21(hcell + seed + vec2<f32>(3.1, 7.7));
    let present = step(0.76, r);                         // ~24% of cells hold a speck
    let jit = (vec2<f32>(r, r2) - vec2<f32>(0.5, 0.5)) * 0.7;
    let rel = g - (hcell + vec2<f32>(0.5, 0.5) + jit);   // fragment relative to this speck's head (cell units)
    let dot = 1.0 - smoothstep(0.0, 0.06, length(rel));  // round head (only the own-cell head is near enough)
    let proj = rel.y * sign(drift);                      // distance along the trailing side (>0 behind head)
    let taper = select(0.0, max(0.0, 1.0 - proj / tailLen), proj > 0.0);   // linear fade → bright full length
    let tail = (1.0 - smoothstep(0.035, 0.065, abs(rel.x))) * taper;
    let tw = 0.6 + 0.4 * sin(t * 1.6 + r2 * 6.2831);     // gentle twinkle
    cov = max(cov, max(dot, tail) * present * max(tw, 0.0));
  }
  let tint = select(vec3<f32>(0.851, 0.333, 0.506),       // #d95581 (rose) — right half
                    vec3<f32>(0.361, 0.757, 0.800),       // #5cc1cc (teal) — left half
                    uv.x < 0.5);
  return tint * cov;
}

fn specks(uv: vec2<f32>, aspect: f32, t: f32) -> vec3<f32> {
  let near = speckLayer(uv, aspect, t, 48.0, vec2<f32>(0.0, 0.0), -0.0175);
  let far  = speckLayer(uv, aspect, t, 82.0, vec2<f32>(4.3, 1.7), -0.011);   // denser + slower = "further"
  return near + far * 0.7;
}

// Soft mask of the 3D grid's screen footprint (upper-middle band behind the logo) — specks fall only here.
fn gridMask(uv: vec2<f32>) -> f32 {
  let c = vec2<f32>(0.5, 0.83);      // grid centre in uv (raise/lower Y to track the grid)
  let r = vec2<f32>(0.36, 0.065);    // grid half-extent in uv (band width, height); height halved with the drift so dwell time is unchanged
  let q = abs(uv - c) / r;
  return 1.0 - smoothstep(0.125, 1.0, max(q.x, q.y));   // 1 inside the core, fades out from 12.5% of the radius
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let t = bg.time.x;
  let aspect = max(bg.time.y, 0.0001);
  var col = mix(bg.bottom.rgb, bg.top.rgb, in.uv.y);   // gradient (solid black for Polygon)

  // Polygon (bg.time.z>0.5) = tiny white specks FALLING over the 3D grid (masked to its footprint). Other
  // themes keep the solid confetti printed on the paper, a touch LIGHTER than the cream.
  if (bg.time.z > 0.5) {
    let s = specks(in.uv, aspect, t) * gridMask(in.uv);   // s is vec3 — colour baked in (50/50 rose / cyan)
    col = col + s;                                        // additive — only over the grid
  } else {
    let e = ephemera(in.uv + vec2<f32>(0.0, t * 0.01), aspect);
    col = col + vec3<f32>(0.035, 0.033, 0.030) * e;
  }

  let d = distance(in.uv, vec2<f32>(0.5, 0.5));
  let vig = 1.0 - smoothstep(0.55, 1.05, d) * 0.10;
  return vec4<f32>(col * vig, 1.0);
}
`;

const PANEL_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> globals: Globals;

struct Panel {
  origin: vec2<f32>, colPitch: f32, rowPitch: f32,
  inset: f32, corner: f32, cols: f32, rows: f32,
  cardCorner: f32, occupied: u32, pad1: vec2<f32>,  // occupied = bitmask of cells holding a 3D tile
  panelColor: vec4<f32>, insetColor: vec4<f32>,
  card: vec4<f32>,     // x, y, w, h (px) — the floating card
  region: vec4<f32>,   // x, y, w, h (px) — quad coverage
};
@group(1) @binding(0) var<uniform> p: Panel;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) frag: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var c = array<vec2<f32>, 6>(
    vec2<f32>(0.0,0.0), vec2<f32>(1.0,0.0), vec2<f32>(1.0,1.0),
    vec2<f32>(0.0,0.0), vec2<f32>(1.0,1.0), vec2<f32>(0.0,1.0));
  let q = c[vi];
  let px = p.region.xy + q * p.region.zw;
  let clip = vec2<f32>(px.x / globals.size.x * 2.0 - 1.0, 1.0 - px.y / globals.size.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.frag = px;
  return out;
}

fn sdRoundRect(pt: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  let q = abs(pt) - b + vec2<f32>(r, r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}

fn hash21(pp: vec2<f32>) -> f32 {
  return fract(sin(dot(pp, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

// Placeholder pattern in slot-local coords (u in the unit disc) → two regions
// (a, b) that get tinted with two random riso colours.
fn patReg(u: vec2<f32>, idx: i32) -> vec2<f32> {
  let r = length(u);
  let ang = atan2(u.y, u.x);
  var a = 0.0;
  var b = 0.0;
  switch idx {
    case 0:  { let k = fract(r * 4.5); a = step(0.5, k); b = 1.0 - a; }                                    // concentric rings
    case 1:  { let c = floor(u * 3.0); let m = (c.x + c.y) - 2.0 * floor((c.x + c.y) * 0.5); a = m; b = 1.0 - m; } // checkerboard
    case 2:  { let s = floor((ang / 6.2831 + 0.5) * 12.0); let m = s - 2.0 * floor(s * 0.5); a = m; b = 1.0 - m; } // pinwheel
    case 3:  { let m = step(0.0, u.x + u.y); a = m; b = 1.0 - m; }                                          // split diagonal
    case 4:  { let k = fract((u.x + u.y) * 3.0); a = step(0.5, k); b = 1.0 - a; }                           // stripes
    case 5:  { let g = fract(u * 3.0) - vec2<f32>(0.5, 0.5); let d = 1.0 - smoothstep(0.18, 0.24, length(g)); a = d; b = 1.0 - d; } // dots
    case 6:  { let p4 = pow(abs(u.x), 0.6) + pow(abs(u.y), 0.6); let m = step(p4, 0.92); a = m; b = 1.0 - m; } // 4-point star
    default: { let rs = 0.55 + 0.32 * cos(ang * 8.0); let m = step(r, rs); a = m; b = 1.0 - m; }            // starburst
  }
  return vec2<f32>(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0));
}

fn risoColor(s: f32) -> vec3<f32> {
  let i = clamp(i32(floor(s * 6.0)), 0, 5);
  var c = vec3<f32>(0.45, 0.38, 0.72);
  switch i {
    case 0:  { c = vec3<f32>(0.93, 0.35, 0.58); }  // pink
    case 1:  { c = vec3<f32>(0.97, 0.82, 0.32); }  // yellow
    case 2:  { c = vec3<f32>(0.30, 0.74, 0.71); }  // teal
    case 3:  { c = vec3<f32>(0.55, 0.80, 0.35); }  // green
    case 4:  { c = vec3<f32>(0.96, 0.45, 0.25); }  // orange
    default: { c = vec3<f32>(0.45, 0.38, 0.72); }  // purple
  }
  return c;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let f = in.frag;

  // Cream paper card (rounded). Outside the card -> transparent.
  let cardHalf = p.card.zw * 0.5;
  let cardCenter = p.card.xy + cardHalf;
  let dCard = sdRoundRect(f - cardCenter, cardHalf, p.cardCorner);
  let cardMask = 1.0 - smoothstep(-1.5, 1.5, dCard);
  if (cardMask <= 0.001) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }

  let ink = globals.ink.rgb;
  var rgb = p.panelColor.rgb;          // flat cream card
  let a = 0.96;

  // Thin border line along the card edge (themed: light for frog/pinwheel,
  // ink-grey for moon).
  let cardBorder = smoothstep(-2.4, -1.2, dCard);
  rgb = mix(rgb, globals.panelBorder.rgb, cardBorder);

  let ccol = floor((f.x - p.origin.x) / p.colPitch);
  let crow = floor((f.y - p.origin.y) / p.rowPitch);
  let inGrid = ccol >= 0.0 && ccol < p.cols && crow >= 0.0 && crow < p.rows;

  // Occupancy: occupied cells (system apps / FrogCarts / Install Cart) keep the
  // grainy riso CIRCLES (so they don't read as a flat patch) but drop the
  // placeholder PATTERN — the 3D tile sits in the center. The universal paper
  // grain is a separate full-screen pass. p.occupied is a bitmask of cell indices.
  var selfOcc = false;
  if (inGrid) {
    let si = u32(crow) * u32(p.cols) + u32(ccol);
    selfOcc = si < 32u && ((p.occupied >> si) & 1u) == 1u;
  }

  // Riso overprint circles in the slots: duotone (red / blue by parity),
  // grain-stippled with a soft directional gradient. Overlapping circles
  // multiply (overprint) into darker mixes — like screen-printed inks. Drawn in
  // every slot, occupied or not (the grain behind the tiles too).
  let blk = globals.accentA.rgb;   // themed riso duotone
  let grn = globals.accentB.rgb;
  var riso = vec3<f32>(1.0, 1.0, 1.0);   // multiply accumulator (light themes)
  var blendRGB = vec3<f32>(0.0, 0.0, 0.0);
  var blendA = 0.0;                       // blend accumulator (dark themes)
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let cc = ccol + f32(dx);
      let cr = crow + f32(dy);
      if (cc < 0.0 || cc >= p.cols || cr < 0.0 || cr >= p.rows) { continue; }
      let cx = p.origin.x + (cc + 0.5) * p.colPitch;
      let cy = p.origin.y + cr * p.rowPitch + p.colPitch * 0.5;
      let rel = f - vec2<f32>(cx, cy);
      let rad = p.inset * 0.68;   // >½ pitch so neighbours overlap → overprint
      let dist = length(rel);
      let edge = 1.0 - smoothstep(rad * 0.5, rad, dist);
      // Per-circle random gradient direction + spread → varied fades.
      let ang = hash21(vec2<f32>(cc, cr) + vec2<f32>(1.7, 9.2)) * 6.2831;
      let gdir = vec2<f32>(cos(ang), sin(ang));
      let spread = mix(1.9, 3.1, hash21(vec2<f32>(cc, cr) + vec2<f32>(4.4, 2.1)));
      // No floor → the gradient fades to zero on the far side, so the stipple is
      // a one-sided directional fan, not a filled circle.
      let grad = clamp(0.72 - dot(rel, gdir) / (rad * spread), 0.0, 1.0);
      // Occupied slots (a system app / cart sits there): cap the coverage so they
      // never build into a dense solid circle — only the light airy stipple.
      // Empty slots keep the full dense stipple.
      let cidx = u32(cr) * u32(p.cols) + u32(cc);
      let cellOcc = cidx < 32u && ((p.occupied >> cidx) & 1u) == 1u;
      let raw = edge * grad;
      let density = select(raw, min(raw, 0.10), cellOcc);
      let nz = hash21(floor(f * 0.85) + vec2<f32>(cc * 3.1, cr * 7.7));
      let inkAmt = smoothstep(nz - 0.09, nz + 0.09, density);
      let par = (cc + cr) - 2.0 * floor((cc + cr) * 0.5);  // 0 / 1 checker parity
      // Empty slots: the alternating duotone. Occupied (system app / cart) slots:
      // a single accent (accentA) → black on Moon, green on Frog.
      let inkColor = select(mix(blk, grn, par), blk, cellOcc);
      riso = riso * mix(vec3<f32>(1.0, 1.0, 1.0), inkColor, inkAmt);
      blendRGB = mix(blendRGB, inkColor, inkAmt);
      blendA = max(blendA, inkAmt);
    }
  }
  // Dark themes blend (so white shows on near-black); light multiply (overprint).
  if (globals.dark > 0.5) { rgb = mix(rgb, blendRGB, blendA); }
  else { rgb = rgb * riso; }

  // Placeholder pattern floating in each slot (~50% opacity) — a random pattern
  // + two-tone riso colours per cell. Hidden in occupied slots (the 3D tile sits
  // there); shown only in empty slots.
  if (inGrid && !selfOcc) {
    let pcx = p.origin.x + (ccol + 0.5) * p.colPitch;
    let pcy = p.origin.y + crow * p.rowPitch + p.colPitch * 0.5;
    let u = (f - vec2<f32>(pcx, pcy)) / (p.inset * 0.5);
    let inCircle = 1.0 - smoothstep(0.94, 1.0, length(u));
    let cseed = vec2<f32>(ccol, crow);
    let pidx = clamp(i32(floor(hash21(cseed + vec2<f32>(0.5, 3.5)) * 8.0)), 0, 7);
    let reg = patReg(u, pidx);
    let useRainbow = globals.rainbow > 0.5;
    let cA = select(globals.accentA.rgb, risoColor(hash21(cseed + vec2<f32>(2.1, 7.3))), useRainbow);
    let cB = select(globals.accentB.rgb, risoColor(hash21(cseed + vec2<f32>(8.7, 1.9))), useRainbow);
    let patRGB = cA * reg.x + cB * reg.y;
    let patCov = clamp(reg.x + reg.y, 0.0, 1.0) * inCircle * 0.5;
    rgb = mix(rgb, patRGB, patCov);
  }

  let outA = a * cardMask;
  return vec4<f32>(rgb * outA, outA);   // premultiplied
}
`;

const ARROW_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> globals: Globals;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,   // px from arrow center
  @location(1) data: vec4<f32>,    // radius, dir, hover, _
};

@vertex
fn vs(
  @location(0) corner: vec2<f32>,
  @location(1) a: vec4<f32>,        // cx, cy, radius, dir
  @location(2) b: vec4<f32>,        // hover, _, _, _
) -> VsOut {
  let R = a.z;
  let m = R * 0.6;
  let size = (R + m) * 2.0;
  let origin = a.xy - vec2<f32>(R + m, R + m);
  let px = origin + corner * vec2<f32>(size, size);
  let clip = vec2<f32>(px.x / globals.size.x * 2.0 - 1.0, 1.0 - px.y / globals.size.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.local = px - a.xy;
  out.data = vec4<f32>(a.z, a.w, b.x, 0.0);
  return out;
}

fn sdSeg(pt: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let pa = pt - a; let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let pt = in.local;
  let R = in.data.x;
  let dir = in.data.y;
  let hover = in.data.z;

  // Circular button (translucent, brighter on hover).
  let dc = length(pt) - R;
  let circ = (1.0 - smoothstep(0.0, 1.5, dc)) * (0.16 + hover * 0.20);

  // Chevron pointing in the dir direction.
  let cw = R * 0.30 * dir;
  let ch = R * 0.42;
  let A = vec2<f32>(-cw, -ch);
  let B = vec2<f32>(cw, 0.0);
  let C = vec2<f32>(-cw, ch);
  let dch = min(sdSeg(pt, A, B), sdSeg(pt, B, C));
  let chev = (1.0 - smoothstep(R * 0.07, R * 0.07 + 1.5, dch)) * (0.65 + hover * 0.35);

  // Composite: white chevron over a dark translucent disc.
  let discRGB = vec3<f32>(0.92, 0.94, 1.0) * 0.10;
  var rgb = discRGB;
  var a = circ;
  rgb = mix(rgb, vec3<f32>(0.95, 0.97, 1.0), chev);
  a = max(a, chev);
  return vec4<f32>(rgb * a, a);
}
`;

const TILE_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var thumbTex: texture_2d<f32>;
@group(1) @binding(1) var thumbSmp: sampler;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,   // px, centered on the tile
  @location(1) half: vec2<f32>,    // tile half-size px
  @location(2) fill: vec4<f32>,
  @location(3) params: vec4<f32>,  // corner, useThumb, _, _
  @location(4) uvRect: vec4<f32>,
  @location(5) anim: vec4<f32>,    // hoverT, selectT, appearT, _
  @location(6) face: vec2<f32>,    // [0,1] across the tile face
};

@vertex
fn vs(
  @builtin(instance_index) inst: u32,
  @location(0) corner01: vec2<f32>,
  @location(1) rect: vec4<f32>,
  @location(2) fill: vec4<f32>,
  @location(3) params: vec4<f32>,
  @location(4) uvRect: vec4<f32>,
  @location(5) anim: vec4<f32>,
) -> VsOut {
  let margin = rect.z * 0.28;                 // room for the drop shadow
  let qOrigin = rect.xy - vec2<f32>(margin, margin);
  let qSize = rect.zw + vec2<f32>(margin, margin) * 2.0;
  var px = qOrigin + corner01 * qSize;

  let center = rect.xy + rect.zw * 0.5;
  // Appear: rise in on mount (alpha handled in fs). No hover lift.
  px.y = px.y + (1.0 - anim.z) * rect.z * 0.5;

  let clip = vec2<f32>(px.x / globals.size.x * 2.0 - 1.0, 1.0 - px.y / globals.size.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.local = qOrigin + corner01 * qSize - center;   // unshifted local for SDF
  out.half = rect.zw * 0.5;
  out.fill = fill;
  out.params = params;
  out.uvRect = uvRect;
  out.anim = anim;
  out.face = (out.local / rect.zw) + vec2<f32>(0.5, 0.5);
  return out;
}

fn sdRoundRect(pt: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  let q = abs(pt) - b + vec2<f32>(r, r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  // The quad carries a margin (for the old drop shadow); only fill the rect.
  if (in.face.x < 0.0 || in.face.x > 1.0 || in.face.y < 0.0 || in.face.y > 1.0) { discard; }
  let sizePx = in.half * 2.0;
  let px = in.face * sizePx;
  let hoverT = in.anim.x;
  let appearT = in.anim.z;
  let b = clamp(min(sizePx.x, sizePx.y) * 0.05, 2.0, 4.0);   // bevel thickness
  let xr = sizePx.x - px.x;
  let yb = sizePx.y - px.y;

  // Win9x raised grey button (sharp corners) — same chrome as the windows, no
  // title bar. Hover only adds a faint highlight (no lift/scale).
  let face = vec3<f32>(0.76, 0.76, 0.74) + vec3<f32>(hoverT * 0.07);
  let hi   = vec3<f32>(1.00, 1.00, 0.99);
  let lite = vec3<f32>(0.87, 0.87, 0.85);
  let dk   = vec3<f32>(0.50, 0.50, 0.52);
  let dk2  = vec3<f32>(0.27, 0.27, 0.29);
  var col = face;
  if (px.x < 2.0*b || px.y < 2.0*b) { col = lite; }
  if (xr < 2.0*b || yb < 2.0*b) { col = dk; }
  if (px.x < b || px.y < b) { col = hi; }
  if (xr < b || yb < b) { col = dk2; }
  return vec4<f32>(col * appearT, appearT);   // premultiplied
}
`;

const BADGE_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> globals: Globals;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) centered: vec2<f32>,
  @location(1) half: vec2<f32>,
  @location(2) fill: vec4<f32>,
  @location(3) params: vec4<f32>,   // corner, _, _, _
};

@vertex
fn vs(@location(0) corner: vec2<f32>, @location(1) rect: vec4<f32>, @location(2) fill: vec4<f32>, @location(3) params: vec4<f32>) -> VsOut {
  let px = rect.xy + corner * rect.zw;
  let clip = vec2<f32>(px.x / globals.size.x * 2.0 - 1.0, 1.0 - px.y / globals.size.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.centered = (corner - vec2<f32>(0.5, 0.5)) * rect.zw;
  out.half = rect.zw * 0.5;
  out.fill = fill;
  out.params = params;
  return out;
}

fn sdRR(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  let q = abs(p) - b + vec2<f32>(r, r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let d = sdRR(in.centered, in.half, in.params.x);
  let cov = 1.0 - smoothstep(-1.0, 1.0, d);
  // subtle top sheen
  let sheen = (1.0 - smoothstep(0.0, in.half.y, in.centered.y + in.half.y)) * 0.06;
  let a = cov * in.fill.a;
  let rgb = in.fill.rgb + sheen;
  return vec4<f32>(rgb * a, a);
}
`;

const LABEL_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var atlasTex: texture_2d<f32>;
@group(1) @binding(1) var atlasSmp: sampler;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) color: vec4<f32> };

@vertex
fn vs(
  @location(0) corner: vec2<f32>,
  @location(1) rect: vec4<f32>,
  @location(2) uvRect: vec4<f32>,
  @location(3) color: vec4<f32>,
) -> VsOut {
  var px = rect.xy + corner * rect.zw;   // (pointer parallax disabled)
  let clip = vec2<f32>(px.x / globals.size.x * 2.0 - 1.0, 1.0 - px.y / globals.size.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.uv = mix(uvRect.xy, uvRect.zw, corner);
  out.color = color;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let coverage = textureSample(atlasTex, atlasSmp, in.uv).a;
  let a = coverage * in.color.a;
  return vec4<f32>(in.color.rgb * a, a);
}
`;

// Riso paper grain: a static, fine, screen-space speckle multiplied over the
// whole composite (2D shell + 3D meshes) so everything reads as printed on the
// same sheet. Drawn last with a multiply blend (dst * grain).
const GRAIN_SHADER = /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var c = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(c[vi], 0.0, 1.0);
}
fn h21(pp: vec2<f32>) -> f32 {
  return fract(sin(dot(pp, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
@fragment
fn fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  // Two slightly-offset speckle scales → organic tooth, not a regular dither.
  let n = h21(floor(fc.xy * 0.8)) * 0.6 + h21(floor(fc.xy * 1.7) + vec2<f32>(11.0, 7.0)) * 0.4;
  let g = 1.0 - n * 0.042;    // softer tooth (~4%)
  return vec4<f32>(g, g, g, 1.0);
}
`;

// A riso "sticker" backdrop behind the viewer mesh: a pink→yellow gradient
// blob + three green squiggles that wave sinusoidally, each with a cream
// offset-up border (paper-cutout look). Procedural; animates off globals.time.
const BACKDROP_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> g: Globals;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var c = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(c[vi], 0.0, 1.0);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
fn sdC(q: vec2<f32>, c: vec2<f32>, r: f32) -> f32 { return length(q - c) - r; }

// Distance from p to the line segment a-b.
fn sdSeg(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Coverage of a constant-thickness wavy ribbon with round caps. Distance is the
// true minimum distance to the sampled centreline polyline, so the body and the
// rounded heads share a single metric: the caps are genuine round ends whose
// slab boundary is perpendicular to the local tangent, so they stay continuous
// with the body (and tilt with it) as the wave travels — no pinched seam.
fn squig(q: vec2<f32>, baseY: f32, amp: f32, freq: f32, phase: f32, xmin: f32, xmax: f32, th: f32) -> f32 {
  // Cheap reject: skip the march for pixels well outside the ribbon's band.
  let m = th + 0.05;
  if (q.x < xmin - m || q.x > xmax + m) { return 0.0; }
  if (q.y < baseY - amp - m || q.y > baseY + amp + m) { return 0.0; }
  let N: i32 = 18;
  var prev = vec2<f32>(xmin, baseY + amp * sin(freq * xmin + phase));
  var best: f32 = 1e9;
  for (var i: i32 = 1; i <= N; i = i + 1) {
    let x = mix(xmin, xmax, f32(i) / f32(N));
    let cur = vec2<f32>(x, baseY + amp * sin(freq * x + phase));
    best = min(best, sdSeg(q, prev, cur));
    prev = cur;
  }
  return 1.0 - smoothstep(th, th + 0.025, best);
}

// One diamond grid layer (argyle). rad > 0.5 makes neighbours overlap.
fn diaCov(px: vec2<f32>, cw: f32, ch: f32, off: vec2<f32>, rad: f32) -> f32 {
  let gg = (px + off) / vec2<f32>(cw, ch);
  let f = fract(gg) - vec2<f32>(0.5, 0.5);
  let d = abs(f.x) + abs(f.y);
  return 1.0 - smoothstep(rad - 0.05, rad, d);
}

// Overlapping pink/yellow/green diamonds (overprint via multiply), masked to
// the top-left so it sits behind the GOOD AFTERNOON lettering.
fn cornerDiamonds(px: vec2<f32>, size: vec2<f32>) -> vec4<f32> {
  let mx = 1.0 - smoothstep(size.x * 0.20, size.x * 0.34, px.x);
  let my = 1.0 - smoothstep(size.y * 0.12, size.y * 0.22, px.y);
  let mask = mx * my;
  if (mask < 0.002) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
  let cw = size.y * 0.044;
  let ch = size.y * 0.063;
  let da = diaCov(px, cw, ch, vec2<f32>(0.0, 0.0), 0.56);
  let db = diaCov(px, cw, ch, vec2<f32>(cw * 0.5, ch * 0.5), 0.56);
  let dc = diaCov(px, cw, ch, vec2<f32>(cw * 0.5, 0.0), 0.50);
  let creamD = vec3<f32>(0.945, 0.910, 0.825);
  let pinkF = vec3<f32>(0.97, 0.60, 0.71);
  let yellowF = vec3<f32>(0.98, 0.86, 0.45);
  let greenF = vec3<f32>(0.60, 0.84, 0.50);
  var ink = vec3<f32>(1.0, 1.0, 1.0);
  ink = ink * mix(vec3<f32>(1.0, 1.0, 1.0), pinkF, da);
  ink = ink * mix(vec3<f32>(1.0, 1.0, 1.0), yellowF, db);
  ink = ink * mix(vec3<f32>(1.0, 1.0, 1.0), greenF, dc);
  let rgb = creamD * ink;
  let cov = clamp(da + db + dc, 0.0, 1.0) * mask * 0.85;
  return vec4<f32>(rgb * cov, cov);
}

@fragment
fn fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  let vh = g.size.y * 0.40;                          // viewer region height
  let center = vec2<f32>(g.size.x * 0.5, vh * 0.55); // sit behind the mesh
  let S = max(vh * 0.40, 1.0);                       // blob scale
  let q = (fc.xy - center) / S;
  let t = g.time;

  // pink → yellow blob (smooth union of a few circles).
  var blob = sdC(q, vec2<f32>(-0.45, 0.05), 0.62);
  blob = smin(blob, sdC(q, vec2<f32>(0.45, -0.05), 0.66), 0.35);
  blob = smin(blob, sdC(q, vec2<f32>(0.05, 0.35), 0.55), 0.35);
  blob = smin(blob, sdC(q, vec2<f32>(-0.15, -0.35), 0.42), 0.30);
  let blobA = 1.0 - smoothstep(-0.01, 0.03, blob);
  let blobCol = mix(g.blobA.rgb, g.blobB.rgb, clamp(0.5 + q.y * 0.55, 0.0, 1.0));

  // Squiggle fill (themed) + a lighter offset edge that forms the sticker border.
  let green = g.squiggle.rgb;
  let cream = mix(green, vec3<f32>(1.0, 1.0, 1.0), 0.80);

  var rgb = blobCol;
  var a = blobA;

  // Three squiggles, each with a cream layer offset UP to form a border.
  let off = 0.07;
  let th = 0.085;
  for (var i = 0; i < 3; i = i + 1) {
    let fi = f32(i);
    let baseY = -0.42 + fi * 0.45 + sin(t * 0.8 + fi * 1.7) * 0.04;  // gentle bob
    let amp = 0.15 + fi * 0.015;
    let freq = 6.0 - fi * 0.4;
    let phase = t * (1.1 + fi * 0.25) + fi * 2.1;                    // travelling wave
    let xmin = -0.7 + fi * 0.12;
    let xmax = 0.55 + fi * 0.08;
    let cA = squig(q, baseY - off, amp, freq, phase, xmin, xmax, th * 1.08);
    rgb = mix(rgb, cream, cA);
    a = max(a, cA);
    let gA = squig(q, baseY, amp, freq, phase, xmin, xmax, th);
    rgb = mix(rgb, green, gA);
    a = max(a, gA);
  }

  // (Top-left diamond pattern hidden for now — see cornerDiamonds(); re-enable
  //  by compositing it under the blob here.)
  return vec4<f32>(rgb * a, a);   // premultiplied, blended over the bg
}
`;

// 3D wireframe TERRAIN — the "Polygon" theme backdrop. A dense (N+1)x(N+1) grid drawn as LINES, its height a
// 4-octave value-noise fBm (organic rolling mountains) that slowly scrolls, MVP-projected. Premultiplied, no
// depth (see-through wireframe). params = (time, relief, freq, _); color.w = line alpha; squiggle = color.rgb.
const WIRE_GRID_SHADER = /* wgsl */ `
struct WG { mvp: mat4x4<f32>, params: vec4<f32>, color: vec4<f32> };
@group(0) @binding(0) var<uniform> wg: WG;

fn hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn fbm(p: vec2<f32>) -> f32 {
  var s = 0.0;
  var amp = 0.5;
  var fr = 1.0;
  for (var k = 0; k < 4; k = k + 1) {
    s = s + amp * vnoise(p * fr);
    fr = fr * 2.0;
    amp = amp * 0.5;
  }
  return s;   // ~0 .. ~0.94, mean ~0.47
}

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) h: f32 };

@vertex
fn vs(@location(0) uv: vec2<f32>) -> VOut {
  let x = (uv.x - 0.5) * 2.0 * 2.0;     // X half-width 2.0 — WIDER (a long ridge across the screen)
  let zc = (uv.y - 0.5) * 2.0 * 0.65;   // Z half-depth 0.65 — depth of the ridge strip
  let t = wg.params.x;
  let relief = wg.params.y;
  let freq = wg.params.z;
  let n = fbm(vec2<f32>(x, zc) * freq + vec2<f32>(0.0, t * 0.06));   // fBm terrain, slowly scrolling toward us
  let hgt = (n - 0.47) * relief;
  var out: VOut;
  out.pos = wg.mvp * vec4<f32>(x, hgt, zc, 1.0);
  out.h = n;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let shade = 0.5 + 0.5 * clamp((in.h - 0.35) * 1.6, 0.0, 1.0);   // peaks brighter than valleys
  let aA = wg.color.a;
  return vec4<f32>(wg.color.rgb * shade * aA, aA);               // premultiplied
}
`;

// Dwell countdown ring: a thin green arc around the focused tile that depletes
// from a full circle to nothing over the dwell duration.
const RING_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> globals: Globals;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) local: vec2<f32>, @location(1) data: vec4<f32> };

@vertex
fn vs(@location(0) corner: vec2<f32>, @location(1) a: vec4<f32>) -> VsOut {
  let R = a.z * 0.62;                          // quad half-extent (tileSize = a.z)
  let origin = a.xy - vec2<f32>(R, R);
  let px = origin + corner * vec2<f32>(R * 2.0, R * 2.0);
  let clip = vec2<f32>(px.x / globals.size.x * 2.0 - 1.0, 1.0 - px.y / globals.size.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.local = px - a.xy;
  out.data = a;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let p = in.local;
  let tile = in.data.z;
  let prog = in.data.w;                        // 1 → 0 over the dwell
  let ringR = tile * 0.50;
  let d = abs(length(p) - ringR);
  let aa = fwidth(d);                          // ~1 device px
  let band = 1.0 - smoothstep(0.0, aa, d);         // crisp ~1px hairline ring
  let a01 = fract(atan2(p.x, -p.y) / 6.2831 + 1.0);   // 0..1 from top, clockwise
  let arc = step(a01, prog);                   // remaining arc (depletes back to the top)
  // Themed ring colour: frog green (as is), pinwheel black, moon dusty white.
  var ringCol = vec3<f32>(0.36, 0.78, 0.36);                                  // frog
  if (globals.dark > 0.5) { ringCol = vec3<f32>(0.84, 0.84, 0.82); }          // moon: dusty white
  else if (globals.rainbow > 0.5) { ringCol = vec3<f32>(0.07, 0.07, 0.09); }  // pinwheel: black
  let a = band * arc;
  return vec4<f32>(ringCol * a, a);
}
`;

// HTML-in-Canvas: draw a live DOM element's texture as a screen-space quad,
// so it composites into the scene (and picks up the grain) while the real
// element stays interactive.
const HTML_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> g: Globals;
@group(1) @binding(0) var<uniform> rect: vec4<f32>;   // x, y, w, h device px
@group(1) @binding(1) var tex: texture_2d<f32>;
@group(1) @binding(2) var smp: sampler;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var c = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));
  let q = c[vi];
  let px = rect.xy + q * rect.zw;
  let clip = vec2<f32>(px.x / g.size.x * 2.0 - 1.0, 1.0 - px.y / g.size.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.uv = q;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let t = textureSample(tex, smp, in.uv);
  return vec4<f32>(t.rgb * t.a, t.a);   // premultiplied
}
`;

// Illustrations project grid: square thumbnail cards mapped onto a horizontal
// cylinder (columns angle back at the L/R edges; rows stay level). The curve is
// a screen-space parabola matched on the CPU in shell-layout `gridProjectX`.
const GRID_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> g: Globals;
@group(1) @binding(0) var thumbTex: texture_2d<f32>;
@group(1) @binding(1) var thumbSmp: sampler;

const CURVE: f32 = ${GRID_CURVE.toFixed(4)};

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,        // 0..1 within the card
  @location(1) uvRect: vec4<f32>,    // atlas rect
  @location(2) info: vec3<f32>,      // hasThumb, hover, alpha
  @location(3) halfpx: vec2<f32>,    // card half-size (px) for px-accurate window chrome
};

@vertex
fn vs(
  @location(0) q: vec2<f32>,                 // unit quad 0..1
  @location(1) ch: vec4<f32>,                // center.xy, half.xy (px)
  @location(2) uvRect: vec4<f32>,
  @location(3) info: vec4<f32>,              // hasThumb, hover, alpha, _
) -> VsOut {
  let corner = q * 2.0 - 1.0;                // -1..1
  let halfW = g.size.x * 0.5;
  let vx = ch.x + corner.x * ch.z;           // this corner's base screen x
  let vy = ch.y + corner.y * ch.w;           // this corner's base screen y
  // Per-corner X scale → trapezoid (outer corner pulls in more → angles back).
  let ncxC = (vx - halfW) / halfW;
  let scC = 1.0 - CURVE * ncxC * ncxC;
  // Center-column scale → uniform vertical shrink so the row stays level at ch.y.
  let ncxM = (ch.x - halfW) / halfW;
  let scM = 1.0 - CURVE * ncxM * ncxM;
  let fx = halfW + (vx - halfW) * scC;       // no hover lift/scale
  let fy = ch.y + corner.y * ch.w * scM;
  let clip = vec2<f32>(fx / g.size.x * 2.0 - 1.0, 1.0 - fy / g.size.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.uv = q;
  out.uvRect = uvRect;
  out.info = info.xyz;
  out.halfpx = ch.zw;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  // NOTE: the title-bar geometry here (b, titleH, close-button slot) must match
  // the label placement in shell-ui-manager buildProjectGrid.
  let sizePx = in.halfpx * 2.0;
  let px = in.uv * sizePx;
  let b = clamp(min(sizePx.x, sizePx.y) * 0.012, 1.5, 2.5);   // thin 2-tone bevel
  let titleH = max(9.0, sizePx.y * 0.10);
  let xr = sizePx.x - px.x;
  let yb = sizePx.y - px.y;

  // Win9x grey palette.
  let face = vec3<f32>(0.76, 0.76, 0.74);
  let hi   = vec3<f32>(1.00, 1.00, 0.99);
  let lite = vec3<f32>(0.87, 0.87, 0.85);
  let dk   = vec3<f32>(0.50, 0.50, 0.52);
  let dk2  = vec3<f32>(0.27, 0.27, 0.29);

  // Sample the thumbnail unconditionally (uniform control flow). Content region
  // sits below the title bar + separator.
  let cx0 = 2.0 * b; let cx1 = sizePx.x - 2.0 * b;
  let cy0 = 4.0 * b + titleH; let cy1 = sizePx.y - 2.0 * b;
  let cu = clamp((px.x - cx0) / max(1.0, cx1 - cx0), 0.0, 1.0);
  let cv = clamp((px.y - cy0) / max(1.0, cy1 - cy0), 0.0, 1.0);
  let auv = mix(in.uvRect.xy, in.uvRect.zw, vec2<f32>(cu, cv));
  let tex = textureSample(thumbTex, thumbSmp, auv);
  let thumb = select(vec3<f32>(0.30, 0.31, 0.36), tex.rgb, in.info.x > 0.5);

  // ── raised outer bevel: two thin rings (outer white/black, inner light/grey) ──
  var col = face;
  if (px.x < 2.0 * b || px.y < 2.0 * b) { col = lite; }
  if (xr < 2.0 * b || yb < 2.0 * b) { col = dk; }
  if (px.x < b || px.y < b) { col = hi; }
  if (xr < b || yb < b) { col = dk2; }

  let in_x = px.x >= 2.0 * b && px.x < sizePx.x - 2.0 * b;

  // ── content (thumbnail) ──
  if (px.x >= cx0 && px.x < cx1 && px.y >= cy0 && px.y < cy1) { col = thumb; }

  // ── grey separator under the title bar (dark line + light line = a groove) ──
  let sepY = 2.0 * b + titleH;
  if (in_x && px.y >= sepY && px.y < sepY + b) { col = dk; }
  if (in_x && px.y >= sepY + b && px.y < sepY + 2.0 * b) { col = hi; }

  // ── title bar: green gradient + a raised close button with a black ✕ ──
  if (in_x && px.y >= 2.0 * b && px.y < 2.0 * b + titleH) {
    let gg = (px.y - 2.0 * b) / titleH;
    col = mix(vec3<f32>(0.46, 0.66, 0.44), vec3<f32>(0.22, 0.43, 0.25), gg);
    let bs = titleH * 0.70;                        // close-button size
    let bx1 = sizePx.x - 2.0 * b - b * 1.5;
    let bx0 = bx1 - bs;
    let by0 = 2.0 * b + (titleH - bs) * 0.5;
    let by1 = by0 + bs;
    if (px.x >= bx0 && px.x < bx1 && px.y >= by0 && px.y < by1) {
      col = face;                                  // raised grey button
      if (px.x < bx0 + b || px.y < by0 + b) { col = hi; }
      if (px.x >= bx1 - b || px.y >= by1 - b) { col = dk2; }
      let bc = vec2<f32>((bx0 + bx1) * 0.5, (by0 + by1) * 0.5);
      let dp = px - bc;
      let inBox = step(abs(dp.x), bs * 0.22) * step(abs(dp.y), bs * 0.22);
      let dd = min(abs(dp.x - dp.y), abs(dp.x + dp.y)) * 0.70710678;
      let cross = inBox * (1.0 - smoothstep(0.6, 1.6, dd));
      col = mix(col, vec3<f32>(0.10, 0.10, 0.12), cross);   // black ✕
    }
  }

  col = col + in.info.y * 0.06;                    // hover brighten
  let alpha = in.info.z;
  return vec4<f32>(col * alpha, alpha);            // premultiplied
}
`;

// Mode cross-fade scrim: a full-screen dip to the background gradient. Drawn
// over everything at the transition midpoint (alpha peaks at 0.5) so the
// home↔grid model swap happens unseen, then fades back to reveal the new view.
const SCRIM_SHADER = /* wgsl */ `
struct S { top: vec4<f32>, bottom: vec4<f32>, params: vec4<f32> };   // params.x = alpha
@group(0) @binding(0) var<uniform> s: S;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: VsOut;
  out.pos = vec4<f32>(p[vi], 0.0, 1.0);
  out.uv = vec2<f32>((p[vi].x + 1.0) * 0.5, (1.0 - p[vi].y) * 0.5);
  return out;
}
@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let a = s.params.x;
  let col = mix(s.top.rgb, s.bottom.rgb, clamp(in.uv.y, 0.0, 1.0));
  return vec4<f32>(col * a, a);   // premultiplied
}
`;

// Win9x window frame as a chrome overlay: raised bevel + green title bar (+ a
// raised close button with a black ✕) + a separator, with a TRANSPARENT interior
// so the region's existing content (panel, viewer, …) shows through. Instanced.
const WINDOW_SHADER = /* wgsl */ `
${GLOBALS_WGSL}
@group(0) @binding(0) var<uniform> g: Globals;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,    // px within the window
  @location(1) size: vec2<f32>,     // window size (px)
  @location(2) titleH: f32,         // title bar height (px); 0 = frame only
  @location(3) controls: f32,       // 0 = close ✕, 1 = zoom −/+
};

@vertex
fn vs(@location(0) q: vec2<f32>, @location(1) rect: vec4<f32>, @location(2) params: vec4<f32>) -> VsOut {
  let px = rect.xy + q * rect.zw;
  let clip = vec2<f32>(px.x / g.size.x * 2.0 - 1.0, 1.0 - px.y / g.size.y * 2.0);
  var out: VsOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.local = q * rect.zw;
  out.size = rect.zw;
  out.titleH = params.x;
  out.controls = params.y;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let sizePx = in.size;
  let px = in.local;
  let b = clamp(min(sizePx.x, sizePx.y) * 0.006, 2.0, 3.5);
  let titleH = in.titleH;
  let xr = sizePx.x - px.x;
  let yb = sizePx.y - px.y;

  let dim = select(1.0, 0.825, g.squiggle.w > 0.5);   // dim the silver bevel on Polygon (glares on black); titlebar stays green
  let face = vec3<f32>(0.76, 0.76, 0.74) * dim;
  let hi   = vec3<f32>(1.00, 1.00, 0.99) * dim;
  let lite = vec3<f32>(0.87, 0.87, 0.85) * dim;
  let dk   = vec3<f32>(0.50, 0.50, 0.52) * dim;
  let dk2  = vec3<f32>(0.27, 0.27, 0.29) * dim;

  var col = vec3<f32>(0.0, 0.0, 0.0);
  var a = 0.0;

  // raised outer bevel (two thin rings) — opaque chrome
  if (px.x < 2.0*b || px.y < 2.0*b || xr < 2.0*b || yb < 2.0*b) { col = face; a = 1.0; }
  if (px.x < 2.0*b || px.y < 2.0*b) { col = lite; }
  if (xr < 2.0*b || yb < 2.0*b) { col = dk; }
  if (px.x < b || px.y < b) { col = hi; }
  if (xr < b || yb < b) { col = dk2; }

  let in_x = px.x >= 2.0*b && px.x < sizePx.x - 2.0*b;
  let sepY = 2.0*b + titleH;

  // separator under the title bar (dark + light = groove)
  if (titleH > 0.5 && in_x && px.y >= sepY && px.y < sepY + b) { col = dk; a = 1.0; }
  if (titleH > 0.5 && in_x && px.y >= sepY + b && px.y < sepY + 2.0*b) { col = hi; a = 1.0; }

  // title bar: green gradient + raised close button with a black ✕
  if (titleH > 0.5 && in_x && px.y >= 2.0*b && px.y < 2.0*b + titleH) {
    let gg = (px.y - 2.0*b) / titleH;
    let tbBase = select(vec3<f32>(0.46, 0.66, 0.44), g.squiggle.rgb, g.squiggle.w > 0.5);  // 3D themes: titlebar = grid colour
    col = mix(tbBase, tbBase * 0.62, gg);
    a = 1.0;
    // Button slot(s): zoom −/+ (controls=1) or a single close ✕. Geometry here
    // must match the hit-rects in shell-ui-manager buildChrome.
    let bs = titleH * 0.62;
    let by0 = 2.0*b + (titleH - bs) * 0.5;
    let by1 = by0 + bs;
    var bx0 = -1.0; var bx1 = -1.0; var sym = 0.0;   // 1 = −, 2 = +, 3 = ✕
    if (in.controls > 0.5) {
      let pbx1 = sizePx.x - 2.0*b - b*1.2; let pbx0 = pbx1 - bs;   // +
      let mbx1 = pbx0 - b*1.2; let mbx0 = mbx1 - bs;               // −
      if (px.x >= pbx0 && px.x < pbx1) { bx0 = pbx0; bx1 = pbx1; sym = 2.0; }
      if (px.x >= mbx0 && px.x < mbx1) { bx0 = mbx0; bx1 = mbx1; sym = 1.0; }
    } else {
      let cbx1 = sizePx.x - 2.0*b - b*1.5; let cbx0 = cbx1 - bs;
      if (px.x >= cbx0 && px.x < cbx1) { bx0 = cbx0; bx1 = cbx1; sym = 3.0; }
    }
    if (sym > 0.5 && px.y >= by0 && px.y < by1) {
      col = face;
      if (px.x < bx0 + b || px.y < by0 + b) { col = hi; }
      if (px.x >= bx1 - b || px.y >= by1 - b) { col = dk2; }
      let bc = vec2<f32>((bx0+bx1)*0.5, (by0+by1)*0.5);
      let dp = px - bc;
      var mark = 0.0;
      if (sym < 1.5) {
        mark = step(abs(dp.y), bs*0.07) * step(abs(dp.x), bs*0.26);          // −
      } else if (sym < 2.5) {
        let hl = step(abs(dp.y), bs*0.07) * step(abs(dp.x), bs*0.26);
        let vl = step(abs(dp.x), bs*0.07) * step(abs(dp.y), bs*0.26);
        mark = max(hl, vl);                                                  // +
      } else {
        let inBox = step(abs(dp.x), bs*0.22) * step(abs(dp.y), bs*0.22);
        let dd = min(abs(dp.x - dp.y), abs(dp.x + dp.y)) * 0.70710678;
        mark = inBox * (1.0 - smoothstep(0.6, 1.6, dd));                     // ✕
      }
      col = mix(col, vec3<f32>(0.10, 0.10, 0.12), mark);
    }
  }

  return vec4<f32>(col * a, a);   // premultiplied; interior a=0 → content shows
}
`;

interface TileAnim { hover: number; select: number; appear: number; }

export class ShellRenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private canvas: HTMLCanvasElement;

  private quadBuf!: GPUBuffer;
  private globalsBuf!: GPUBuffer;
  private bgBuf!: GPUBuffer;
  private panelBuf!: GPUBuffer;
  private globalsBGL!: GPUBindGroupLayout;
  private globalsBindGroup!: GPUBindGroup;

  private bgPipeline!: GPURenderPipeline;
  private bgBindGroup!: GPUBindGroup;
  private panelPipeline!: GPURenderPipeline;
  private panelBindGroup!: GPUBindGroup;

  private tilePipeline!: GPURenderPipeline;
  private tileBuf!: GPUBuffer;
  private tileCap = INITIAL_TILE_CAP;

  private gridPipeline!: GPURenderPipeline;   // illustrations project grid
  private gridBuf!: GPUBuffer;
  private gridCap = INITIAL_GRID_CAP;

  private scrimPipeline!: GPURenderPipeline;  // mode cross-fade dip
  private scrimBuf!: GPUBuffer;
  private scrimBindGroup!: GPUBindGroup;

  private windowPipeline!: GPURenderPipeline;  // Win9x window-frame overlays
  private windowBuf!: GPUBuffer;
  private windowCap = 16;

  private arrowPipeline!: GPURenderPipeline;
  private arrowBuf!: GPUBuffer;

  private badgePipeline!: GPURenderPipeline;
  private badgeBuf!: GPUBuffer;
  private badgeCap = 16;

  private grainPipeline!: GPURenderPipeline;
  private backdropPipeline!: GPURenderPipeline;
  // 3D wireframe grid backdrop (Polygon theme).
  private wireGridPipeline!: GPURenderPipeline;
  private wireGridVB!: GPUBuffer;
  private wireGridIB!: GPUBuffer;
  private wireGridUBO!: GPUBuffer;
  private wireGridBindGroup!: GPUBindGroup;
  private wireGridIndexCount = 0;
  private gridProj = mat4.create();
  private gridView = mat4.create();
  private gridMvp = mat4.create();
  private gridScreen = mat4.create();   // post-projection NDC scale (smaller) + up-shift (behind the logo)

  private ringPipeline!: GPURenderPipeline;
  private ringBuf!: GPUBuffer;

  private htmlLayer!: ShellHtmlLayer;
  private htmlPipeline!: GPURenderPipeline;
  private htmlBGL!: GPUBindGroupLayout;
  private htmlRectBuf!: GPUBuffer;
  private htmlSampler!: GPUSampler;
  private htmlBindGroup: GPUBindGroup | null = null;
  private htmlBoundTex: GPUTexture | null = null;

  private labelPipeline!: GPURenderPipeline;
  private labelBuf!: GPUBuffer;
  private labelCap = INITIAL_LABEL_CAP;
  private labelAtlasBGL!: GPUBindGroupLayout;
  private labelAtlas: ShellLabelAtlas;
  private labelSampler!: GPUSampler;
  private labelBindGroup: GPUBindGroup | null = null;
  private labelBoundTexture: GPUTexture | null = null;

  private thumbAtlas: ShellThumbnailAtlas;
  private thumbSampler!: GPUSampler;
  private thumbBindGroup!: GPUBindGroup;
  private thumbBGL!: GPUBindGroupLayout;

  private viewer: CartridgeViewer;

  private model: ShellRenderModel | null = null;
  private destroyed = false;
  private rafId: number | null = null;
  private running = false;

  // animation state
  private anim = new Map<string, TileAnim>();
  private lastTime = 0;
  private mountTime = 0;
  private pointer: [number, number] = [0, 0];
  private pointerTarget: [number, number] = [0, 0];

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, canvas: HTMLCanvasElement) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.canvas = canvas;
    this.labelAtlas = new ShellLabelAtlas(device);
    this.thumbAtlas = new ShellThumbnailAtlas(device);
    this.viewer = new CartridgeViewer(device, format, this.thumbAtlas);
    this.mountTime = performance.now() / 1000;
    this.buildShared();
    this.buildBgPipeline();
    this.buildPanelPipeline();
    this.buildTilePipeline();
    this.buildGridPipeline();
    this.buildScrimPipeline();
    this.buildWindowPipeline();
    this.buildArrowPipeline();
    this.buildBadgePipeline();
    this.buildGrainPipeline();
    this.buildBackdropPipeline();
    this.buildWireGridPipeline();
    this.buildRingPipeline();
    this.htmlLayer = new ShellHtmlLayer(this.device, this.canvas);
    this.buildHtmlPipeline();
    this.buildLabelPipeline();
  }

  requestThumbnail(id: string, dataUrl: string): void { this.thumbAtlas.request(id, dataUrl); }

  /** Drop the cached text atlas so labels re-rasterize (e.g. after a web font
   *  loads). The next render rebuilds it with the new font. */
  invalidateText(): void { this.labelAtlas.invalidate(); }

  /** Register a Billboard3D cutout mesh for a system-app icon (by key). */
  setSystemIcon(key: string, geo: import('../3d/billboard-3d').Billboard3DGeometry): void {
    this.viewer.setBillboard(key, geo);
  }

  /** Normalized pointer position (-1..1 from canvas center), drives parallax. */
  setPointer(nx: number, ny: number): void {
    this.pointerTarget = [Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny))];
  }

  start(): void {
    if (this.running || this.destroyed) return;
    this.running = true;
    this.lastTime = performance.now() / 1000;
    const tick = () => {
      if (!this.running || this.destroyed) { this.rafId = null; return; }
      this.render();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  setModel(model: ShellRenderModel): void {
    this.model = model;
    if (!this.running) this.render();
  }

  // ── pipeline construction ──

  private blend(): GPUBlendState {
    return {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
  }

  private buildShared(): void {
    const quad = new Float32Array([0,0, 1,0, 1,1, 0,0, 1,1, 0,1]);
    this.quadBuf = this.device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.quadBuf, 0, quad);

    this.globalsBuf = this.device.createBuffer({ size: GLOBALS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bgBuf = this.device.createBuffer({ size: BG_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.panelBuf = this.device.createBuffer({ size: PANEL_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.globalsBGL = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.globalsBindGroup = this.device.createBindGroup({ layout: this.globalsBGL, entries: [{ binding: 0, resource: { buffer: this.globalsBuf } }] });

    this.thumbSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.labelSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    this.thumbBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.thumbBindGroup = this.device.createBindGroup({
      layout: this.thumbBGL,
      entries: [{ binding: 0, resource: this.thumbAtlas.getView() }, { binding: 1, resource: this.thumbSampler }],
    });
  }

  private buildBgPipeline(): void {
    const module = this.device.createShaderModule({ code: BG_SHADER });
    const bgl = this.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.bgBindGroup = this.device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: this.bgBuf } }] });
    this.bgPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildPanelPipeline(): void {
    const module = this.device.createShaderModule({ code: PANEL_SHADER });
    const panelBGL = this.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.panelBindGroup = this.device.createBindGroup({ layout: panelBGL, entries: [{ binding: 0, resource: { buffer: this.panelBuf } }] });
    this.panelPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL, panelBGL] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildTilePipeline(): void {
    const module = this.device.createShaderModule({ code: TILE_SHADER });
    this.tileBuf = this.device.createBuffer({ size: this.tileCap * TILE_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.tilePipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL, this.thumbBGL] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: TILE_STRIDE, stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0,  format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
              { shaderLocation: 3, offset: 32, format: 'float32x4' },
              { shaderLocation: 4, offset: 48, format: 'float32x4' },
              { shaderLocation: 5, offset: 64, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildGridPipeline(): void {
    const module = this.device.createShaderModule({ code: GRID_SHADER });
    this.gridBuf = this.device.createBuffer({ size: this.gridCap * GRID_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.gridPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL, this.thumbBGL] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: GRID_STRIDE, stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0,  format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
              { shaderLocation: 3, offset: 32, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildWindowPipeline(): void {
    const module = this.device.createShaderModule({ code: WINDOW_SHADER });
    this.windowBuf = this.device.createBuffer({ size: this.windowCap * WINDOW_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.windowPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: WINDOW_STRIDE, stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0,  format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private growWindowBuf(n: number): void {
    if (n <= this.windowCap) return;
    let cap = this.windowCap; while (cap < n) cap *= 2;
    this.windowBuf.destroy();
    this.windowBuf = this.device.createBuffer({ size: cap * WINDOW_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.windowCap = cap;
  }

  private buildScrimPipeline(): void {
    const module = this.device.createShaderModule({ code: SCRIM_SHADER });
    this.scrimBuf = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bgl = this.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.scrimBindGroup = this.device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: this.scrimBuf } }] });
    this.scrimPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildArrowPipeline(): void {
    const module = this.device.createShaderModule({ code: ARROW_SHADER });
    this.arrowBuf = this.device.createBuffer({ size: 2 * ARROW_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.arrowPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: ARROW_STRIDE, stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0,  format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildRingPipeline(): void {
    const module = this.device.createShaderModule({ code: RING_SHADER });
    this.ringBuf = this.device.createBuffer({ size: RING_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.ringPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          { arrayStride: RING_STRIDE, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildHtmlPipeline(): void {
    const module = this.device.createShaderModule({ code: HTML_SHADER });
    this.htmlRectBuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.htmlSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.htmlBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.htmlPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL, this.htmlBGL] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private ensureHtmlBindGroup(tex: GPUTexture): void {
    if (this.htmlBoundTex === tex && this.htmlBindGroup) return;
    this.htmlBindGroup = this.device.createBindGroup({
      layout: this.htmlBGL,
      entries: [
        { binding: 0, resource: { buffer: this.htmlRectBuf } },
        { binding: 1, resource: tex.createView() },
        { binding: 2, resource: this.htmlSampler },
      ],
    });
    this.htmlBoundTex = tex;
  }

  /** True when the experimental HTML-in-Canvas API is available. */
  get htmlSupported(): boolean { return this.htmlLayer.supported; }

  /** Mount a live DOM element to render in-scene (or overlay fallback). */
  mountHtml(el: HTMLElement): void { this.htmlLayer.mount(el); }
  setHtmlRect(x: number, y: number, w: number, h: number): void { this.htmlLayer.setRect(x, y, w, h); }
  setHtmlAnchor(ax: number, ay: number, mx: number, my: number): void { this.htmlLayer.setAnchor(ax, ay, mx, my); }
  unmountHtml(): void { this.htmlLayer.unmount(); }

  private buildBadgePipeline(): void {
    const module = this.device.createShaderModule({ code: BADGE_SHADER });
    this.badgeBuf = this.device.createBuffer({ size: this.badgeCap * BADGE_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.badgePipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: BADGE_STRIDE, stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0,  format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
              { shaderLocation: 3, offset: 32, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildBackdropPipeline(): void {
    const module = this.device.createShaderModule({ code: BACKDROP_SHADER });
    this.backdropPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildWireGridPipeline(): void {
    // Screen placement (tuning): scale the projected terrain DOWN and shift it UP in NDC so it sits small,
    // behind the Frogmarks logo. A clip-space matrix (col-major): scales xy, adds GRID_YSHIFT*w to y.
    const GRID_SCALE = 0.35, GRID_YSHIFT = 0.55;
    this.gridScreen = mat4.fromValues(GRID_SCALE, 0, 0, 0,  0, GRID_SCALE, 0, 0,  0, 0, 1, 0,  0, GRID_YSHIFT, 0, 1);

    // (N+1)^2 grid of UV points + a line-list index buffer (horizontal + vertical edges). The vertex shader
    // displaces + projects them; the heightfield animates via the time uniform (no per-frame buffer rewrite).
    const N = 80;   // dense mesh → fine wireframe like the reference
    const verts = new Float32Array((N + 1) * (N + 1) * 2);
    let v = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { verts[v++] = i / N; verts[v++] = j / N; }
    const at = (i: number, j: number) => j * (N + 1) + i;
    const idx: number[] = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i < N; i++) { idx.push(at(i, j), at(i + 1, j)); }   // rows
    for (let j = 0; j < N; j++) for (let i = 0; i <= N; i++) { idx.push(at(i, j), at(i, j + 1)); }   // cols
    const indices = new Uint16Array(idx);
    this.wireGridIndexCount = indices.length;
    this.wireGridVB = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.wireGridVB, 0, verts);
    this.wireGridIB = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.wireGridIB, 0, indices);
    this.wireGridUBO = this.device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // mat4(64) + params(16) + color(16)

    const module = this.device.createShaderModule({ code: WIRE_GRID_SHADER });
    const bgl = this.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
    this.wireGridBindGroup = this.device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: this.wireGridUBO } }] });
    this.wireGridPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'line-list' },
    });
  }

  private buildGrainPipeline(): void {
    const module = this.device.createShaderModule({ code: GRAIN_SHADER });
    this.grainPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{
          format: this.format,
          // result = dst * src (multiply); keep dst alpha.
          blend: {
            color: { srcFactor: 'zero', dstFactor: 'src', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  private buildLabelPipeline(): void {
    const module = this.device.createShaderModule({ code: LABEL_SHADER });
    this.labelBuf = this.device.createBuffer({ size: this.labelCap * LABEL_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.labelAtlasBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.labelPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalsBGL, this.labelAtlasBGL] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          {
            arrayStride: LABEL_STRIDE, stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0,  format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
              { shaderLocation: 3, offset: 32, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: this.blend() }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  private growTileBuf(n: number): void {
    if (n <= this.tileCap) return;
    let cap = this.tileCap; while (cap < n) cap *= 2;
    this.tileBuf.destroy();
    this.tileBuf = this.device.createBuffer({ size: cap * TILE_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.tileCap = cap;
  }
  private growLabelBuf(n: number): void {
    if (n <= this.labelCap) return;
    let cap = this.labelCap; while (cap < n) cap *= 2;
    this.labelBuf.destroy();
    this.labelBuf = this.device.createBuffer({ size: cap * LABEL_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.labelCap = cap;
  }
  private growGridBuf(n: number): void {
    if (n <= this.gridCap) return;
    let cap = this.gridCap; while (cap < n) cap *= 2;
    this.gridBuf.destroy();
    this.gridBuf = this.device.createBuffer({ size: cap * GRID_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.gridCap = cap;
  }

  /** Ease per-tile hover/select/appear toward their targets. */
  private tickAnim(dt: number): void {
    const m = this.model;
    if (!m) return;
    const k = 1 - Math.exp(-dt / 0.09);          // ~90ms time constant
    const mountElapsed = performance.now() / 1000 - this.mountTime;
    const seen = new Set<string>();
    m.tiles.forEach((t, i) => {
      seen.add(t.id);
      let a = this.anim.get(t.id);
      if (!a) { a = { hover: 0, select: 0, appear: 0 }; this.anim.set(t.id, a); }
      a.hover += ((t.hovered ? 1 : 0) - a.hover) * k;
      a.select += ((t.selected ? 1 : 0) - a.select) * k;
      // staggered appear by tile index
      const at = Math.max(0, Math.min(1, (mountElapsed - i * 0.025) / 0.30));
      a.appear = at * at * (3 - 2 * at);          // smoothstep
    });
    for (const id of [...this.anim.keys()]) if (!seen.has(id)) this.anim.delete(id);
    // ease pointer
    const pk = 1 - Math.exp(-dt / 0.12);
    this.pointer[0] += (this.pointerTarget[0] - this.pointer[0]) * pk;
    this.pointer[1] += (this.pointerTarget[1] - this.pointer[1]) * pk;
  }

  // ── Per-frame staging scratch (audit 5.11) ────────────────────────────────
  // The shell animation loop was allocating ~10 fresh Float32Arrays per frame
  // purely as writeBuffer staging. Keep one persistent array per call-site
  // (keyed by name), sized to capacity and grown geometrically — every user
  // below passes an explicit element count to writeBuffer so spare capacity is
  // never uploaded. Variable-count sites must write EVERY slot of each row
  // (zero the conditional ones) since the arrays are no longer zero-fresh.
  private readonly _scratch = new Map<string, Float32Array>();
  private readonly _scratchU32 = new Map<string, Uint32Array>();
  private scratch(key: string, len: number): Float32Array {
    let a = this._scratch.get(key);
    if (!a || a.length < len) {
      a = new Float32Array(Math.max(len, (a?.length ?? 0) * 2));
      this._scratch.set(key, a);
      this._scratchU32.set(key, new Uint32Array(a.buffer));
    }
    return a;
  }
  /** u32 view over the same backing store as scratch(key) — for bitmask slots. */
  private scratchU32(key: string): Uint32Array {
    return this._scratchU32.get(key)!;
  }

  private prepareLabels(): number {
    const m = this.model;
    if (!m || m.labels.length === 0) return 0;
    this.labelAtlas.build(m.labels.map(l => ({ text: l.text, maxWidthPx: l.maxWidthPx, fontPx: l.fontPx, fontFamily: l.fontFamily, scaleX: l.scaleX, scaleY: l.scaleY })), FONT_FAMILY);
    const tex = this.labelAtlas.getTexture();
    if (!tex) return 0;
    if (this.labelBoundTexture !== tex) {
      this.labelBindGroup = this.device.createBindGroup({ layout: this.labelAtlasBGL, entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: this.labelSampler }] });
      this.labelBoundTexture = tex;
    }
    this.growLabelBuf(m.labels.length);
    const data = this.scratch('labels', m.labels.length * (LABEL_STRIDE / 4));
    let n = 0;
    for (const l of m.labels) {
      const e = this.labelAtlas.get(l.text, l.maxWidthPx, l.fontPx, l.fontFamily ?? FONT_FAMILY, l.scaleX ?? 1, l.scaleY ?? 1);
      if (!e) continue;
      const x = l.centerX - e.wPx / 2, o = n * 12;
      data[o+0]=x; data[o+1]=l.topY; data[o+2]=e.wPx; data[o+3]=e.hPx;
      data[o+4]=e.u0; data[o+5]=e.v0; data[o+6]=e.u1; data[o+7]=e.v1;
      data[o+8]=l.color[0]; data[o+9]=l.color[1]; data[o+10]=l.color[2]; data[o+11]=l.color[3];
      n++;
    }
    if (n > 0) this.device.queue.writeBuffer(this.labelBuf, 0, data, 0, n * (LABEL_STRIDE / 4));
    return n;
  }

  render(): void {
    if (this.destroyed) return;
    const m = this.model;
    const w = this.canvas.width, h = this.canvas.height;
    if (!m || w === 0 || h === 0) return;

    const now = performance.now() / 1000;
    const dt = Math.min(0.05, Math.max(0, now - this.lastTime));
    this.lastTime = now;
    this.tickAnim(dt);

    // globals + themed ink/accent colors + flags (rainbow patterns, dark blend)
    {
      const gd = this.scratch('globals', 36);
      gd[0] = w; gd[1] = h; gd[2] = now; gd[3] = now - this.mountTime; gd[4] = this.pointer[0]; gd[5] = this.pointer[1];
      gd[6] = m.rainbow ? 1 : 0; gd[7] = m.dark ? 1 : 0;
      gd[8]  = m.ink[0];     gd[9]  = m.ink[1];     gd[10] = m.ink[2];     gd[11] = m.ink[3];
      gd[12] = m.accentA[0]; gd[13] = m.accentA[1]; gd[14] = m.accentA[2]; gd[15] = m.accentA[3];
      gd[16] = m.accentB[0]; gd[17] = m.accentB[1]; gd[18] = m.accentB[2]; gd[19] = m.accentB[3];
      gd[20] = m.blobA[0];   gd[21] = m.blobA[1];   gd[22] = m.blobA[2];   gd[23] = m.blobA[3];
      gd[24] = m.blobB[0];   gd[25] = m.blobB[1];   gd[26] = m.blobB[2];   gd[27] = m.blobB[3];
      gd[28] = m.squiggle[0]; gd[29] = m.squiggle[1]; gd[30] = m.squiggle[2]; gd[31] = m.backdropGrid ? 1 : 0;   // .w = Polygon flag (dims the window chrome)
      gd[32] = m.panelBorder[0]; gd[33] = m.panelBorder[1]; gd[34] = m.panelBorder[2]; gd[35] = m.panelBorder[3];
      this.device.queue.writeBuffer(this.globalsBuf, 0, gd, 0, 36);
    }

    // Dwell ring: full while the countdown is paused (pointer still over the
    // tile → ringCountdownStart undefined); otherwise it depletes over
    // RING_SECONDS from when the pointer left.
    const ringId = m.ringTileId ?? null;
    const ringTile = ringId ? m.tiles.find(t => t.id === ringId) : undefined;
    const ringProg = !ringTile ? 0
      : m.ringCountdownStart === undefined ? 1
      : Math.max(0, 1 - (now - m.ringCountdownStart) / RING_SECONDS);
    const drawRing = !!ringTile && ringProg > 0.001;
    if (drawRing && ringTile) {
      const [rx, ry, rw, rh] = ringTile.rect;
      const rd = this.scratch('ring', 4);
      rd[0] = rx + rw / 2; rd[1] = ry + rh / 2; rd[2] = rw; rd[3] = ringProg;
      this.device.queue.writeBuffer(this.ringBuf, 0, rd, 0, 4);
    }

    // HTML-in-Canvas: re-anchor to the element's current size, then snapshot it
    // into its texture (queued before the render pass that samples it).
    if (this.htmlLayer.hasElement()) this.htmlLayer.layout(w, h);
    const htmlReady = this.htmlLayer.hasElement() ? this.htmlLayer.paint() : false;
    const htmlTex = htmlReady ? this.htmlLayer.getTexture() : null;
    if (htmlTex) {
      const r = this.htmlLayer.getRect();
      const hd = this.scratch('htmlRect', 4);
      hd[0] = r[0]; hd[1] = r[1]; hd[2] = r[2]; hd[3] = r[3];
      this.device.queue.writeBuffer(this.htmlRectBuf, 0, hd, 0, 4);
      this.ensureHtmlBindGroup(htmlTex);
    }
    // background colors + time + aspect (time.y)
    {
      const topLen = m.bgTop.length, botLen = m.bgBottom.length;
      const bgLen = topLen + botLen + 4;
      const bgd = this.scratch('bg', bgLen);
      bgd.set(m.bgTop, 0);
      bgd.set(m.bgBottom, topLen);
      const bo = topLen + botLen;
      bgd[bo] = now; bgd[bo + 1] = w / Math.max(1, h); bgd[bo + 2] = m.backdropGrid ? 1 : 0; bgd[bo + 3] = 0;
      this.device.queue.writeBuffer(this.bgBuf, 0, bgd, 0, bgLen);
    }
    // panel uniform (frosted card)
    const g = m.grid;
    // Bitmask of cells (row*cols+col == tile index) that hold a 3D tile — system
    // apps, FrogCarts, Install Cart — so the panel shader skips the riso/pattern
    // behind them. Tiles fill cells in order, so tile i sits at cell i.
    let occupied = 0;
    for (let i = 0; i < m.tiles.length && i < 32; i++) {
      const t = m.tiles[i];
      if (t.discIcon || t.cd || t.billboardKey) occupied |= (1 << i);
    }
    const pcLen = m.panelColor.length, icLen = m.insetColor.length;
    const pLen = 12 + pcLen + icLen + 8;
    const panelData = this.scratch('panel', pLen);
    panelData[0] = g.left;       panelData[1] = g.top;     panelData[2]  = g.colPitch; panelData[3]  = g.rowPitch;
    panelData[4] = g.tileSize;   panelData[5] = g.corner;  panelData[6]  = g.columns;  panelData[7]  = g.rows;
    panelData[8] = g.cardCorner; panelData[9] = 0;         panelData[10] = 0;          panelData[11] = 0;   // [9] = occupied bitmask (written as u32 below)
    panelData.set(m.panelColor, 12);
    panelData.set(m.insetColor, 12 + pcLen);
    const po = 12 + pcLen + icLen;
    panelData[po]     = g.cardX; panelData[po + 1] = g.cardY;      panelData[po + 2] = g.cardW; panelData[po + 3] = g.cardH;
    panelData[po + 4] = 0;       panelData[po + 5] = g.regionTop;  panelData[po + 6] = w;       panelData[po + 7] = g.regionHeight;
    this.scratchU32('panel')[9] = occupied >>> 0;   // same backing store as panelData
    this.device.queue.writeBuffer(this.panelBuf, 0, panelData, 0, pLen);

    // arrows
    const arrows = m.arrows;
    if (arrows.length > 0) {
      const alen = arrows.length * (ARROW_STRIDE / 4);
      const adata = this.scratch('arrows', alen);
      for (let i = 0; i < arrows.length; i++) {
        const a = arrows[i], o = i * 8;
        adata[o+0]=a.cx; adata[o+1]=a.cy; adata[o+2]=a.radius; adata[o+3]=a.dir;
        adata[o+4]=a.hovered ? 1 : 0; adata[o+5]=0; adata[o+6]=0; adata[o+7]=0;
      }
      this.device.queue.writeBuffer(this.arrowBuf, 0, adata, 0, alen);
    }

    // tiles (coin tiles — system apps + Install Cart — are drawn as 3D discs
    // below, so exclude them here; the flat circle would otherwise sit under
    // the coin)
    const tiles = m.tiles.filter(t => !t.discIcon && !t.cd && !t.billboardKey);
    this.growTileBuf(Math.max(1, tiles.length));
    if (tiles.length > 0) {
      const stride = TILE_STRIDE / 4;
      const data = this.scratch('tiles', tiles.length * stride);
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const a = this.anim.get(t.id) ?? { hover: 0, select: 0, appear: 1 };
        const thumb = this.thumbAtlas.get(t.id);
        const o = i * stride;
        data[o+0]=t.rect[0]; data[o+1]=t.rect[1]; data[o+2]=t.rect[2]; data[o+3]=t.rect[3];
        data[o+4]=t.fill[0]; data[o+5]=t.fill[1]; data[o+6]=t.fill[2]; data[o+7]=t.fill[3];
        data[o+8]=t.cornerRadius; data[o+9]=thumb ? 1 : 0; data[o+10]=0; data[o+11]=0;
        // scratch is reused across frames — zero the thumb UVs when absent
        if (thumb) { data[o+12]=thumb.u0; data[o+13]=thumb.v0; data[o+14]=thumb.u1; data[o+15]=thumb.v1; }
        else       { data[o+12]=0;        data[o+13]=0;        data[o+14]=0;        data[o+15]=0; }
        data[o+16]=a.hover; data[o+17]=a.select; data[o+18]=a.appear; data[o+19]=0;
      }
      this.device.queue.writeBuffer(this.tileBuf, 0, data, 0, tiles.length * stride);
    }

    // project grid (illustrations mode) — curved floating thumbnail cards
    const grid = m.projectGrid;
    const inGrid = !!grid;
    let gridCount = 0;
    if (grid && grid.length > 0) {
      this.growGridBuf(grid.length);
      const gstride = GRID_STRIDE / 4;
      const gdata = this.scratch('grid', grid.length * gstride);
      for (let i = 0; i < grid.length; i++) {
        const it = grid[i];
        const thumb = this.thumbAtlas.get(it.id);
        const o = i * gstride;
        gdata[o+0] = it.rect[0] + it.rect[2] / 2;   // center x
        gdata[o+1] = it.rect[1] + it.rect[3] / 2;   // center y
        gdata[o+2] = it.rect[2] / 2;                // half w
        gdata[o+3] = it.rect[3] / 2;                // half h
        // scratch is reused across frames — zero the thumb UVs when absent
        if (thumb) { gdata[o+4]=thumb.u0; gdata[o+5]=thumb.v0; gdata[o+6]=thumb.u1; gdata[o+7]=thumb.v1; }
        else       { gdata[o+4]=0;        gdata[o+5]=0;        gdata[o+6]=0;        gdata[o+7]=0; }
        gdata[o+8] = thumb ? 1 : 0;
        gdata[o+9] = it.hover;
        gdata[o+10] = 1;                            // opaque; the scrim drives the cross-fade
        gdata[o+11] = 0;                            // pad (was zero-fresh before scratch reuse)
      }
      this.device.queue.writeBuffer(this.gridBuf, 0, gdata, 0, grid.length * gstride);
      gridCount = grid.length;
    }

    // window frames (Win9x chrome overlays — bottom panel, etc.)
    const windows = m.windows ?? [];
    if (windows.length > 0) {
      this.growWindowBuf(windows.length);
      const wstride = WINDOW_STRIDE / 4;
      const wdata = this.scratch('windows', windows.length * wstride);
      for (let i = 0; i < windows.length; i++) {
        const win = windows[i], o = i * wstride;
        wdata[o+0] = win.rect[0]; wdata[o+1] = win.rect[1]; wdata[o+2] = win.rect[2]; wdata[o+3] = win.rect[3];
        wdata[o+4] = win.titleH;
        wdata[o+5] = win.controls === 'zoom' ? 1 : 0;
        wdata[o+6] = 0; wdata[o+7] = 0;   // pad (was zero-fresh before scratch reuse)
      }
      this.device.queue.writeBuffer(this.windowBuf, 0, wdata, 0, windows.length * wstride);
    }

    // badges (chrome pills)
    const badges = m.badges;
    if (badges.length > 0) {
      if (badges.length > this.badgeCap) {
        let cap = this.badgeCap; while (cap < badges.length) cap *= 2;
        this.badgeBuf.destroy();
        this.badgeBuf = this.device.createBuffer({ size: cap * BADGE_STRIDE, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        this.badgeCap = cap;
      }
      const blen = badges.length * (BADGE_STRIDE / 4);
      const bdata = this.scratch('badges', blen);
      for (let i = 0; i < badges.length; i++) {
        const b = badges[i], o = i * 12;
        bdata[o+0]=b.rect[0]; bdata[o+1]=b.rect[1]; bdata[o+2]=b.rect[2]; bdata[o+3]=b.rect[3];
        bdata[o+4]=b.fill[0]; bdata[o+5]=b.fill[1]; bdata[o+6]=b.fill[2]; bdata[o+7]=b.fill[3];
        bdata[o+8]=b.corner; bdata[o+9]=0; bdata[o+10]=0; bdata[o+11]=0;
      }
      this.device.queue.writeBuffer(this.badgeBuf, 0, bdata, 0, blen);
    }

    const labelCount = this.prepareLabels();

    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();

    // ── Pass 1: background (gradient + ephemera) ──
    const bgPass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: m.bgBottom[0], g: m.bgBottom[1], b: m.bgBottom[2], a: 1 }, loadOp: 'clear', storeOp: 'store' }],
    });
    bgPass.setPipeline(this.bgPipeline);
    bgPass.setBindGroup(0, this.bgBindGroup);
    bgPass.draw(3);
    // Home backdrop, behind the viewer mesh (hidden in the illustrations grid). Polygon theme = a 3D
    // wireframe grid surface; every other theme = the riso sticker (blob + squiggle ribbons).
    if (!inGrid) {
      if (m.backdropGrid) {
        const aspect = w / Math.max(1, h);
        mat4.perspective(this.gridProj, 0.6, aspect, 0.1, 20);
        const yaw = Math.sin(now * 0.1) * 0.08;             // very subtle left/right sway (mostly head-on)
        const R = 2.6;
        mat4.lookAt(this.gridView, [Math.sin(yaw) * R, 1.2, Math.cos(yaw) * R], [0, 0.05, 0], [0, 1, 0]);   // eyeY = look-down angle (higher = more top-down)
        mat4.multiply(this.gridMvp, this.gridProj, this.gridView);
        mat4.multiply(this.gridMvp, this.gridScreen, this.gridMvp);   // shrink + lift up behind the logo
        const wgd = this.scratch('wiregrid', 24);
        wgd.set(this.gridMvp as Float32Array, 0);
        wgd[16] = now; wgd[17] = 0.85; wgd[18] = 2.2; wgd[19] = 0;                       // params: time, relief, freq, _
        wgd[20] = m.squiggle[0]; wgd[21] = m.squiggle[1]; wgd[22] = m.squiggle[2]; wgd[23] = 0.72; // grid-line color + alpha
        this.device.queue.writeBuffer(this.wireGridUBO, 0, wgd, 0, 24);
        bgPass.setPipeline(this.wireGridPipeline);
        bgPass.setBindGroup(0, this.wireGridBindGroup);
        bgPass.setVertexBuffer(0, this.wireGridVB);
        bgPass.setIndexBuffer(this.wireGridIB, 'uint16');
        bgPass.drawIndexed(this.wireGridIndexCount);
      } else {
        bgPass.setPipeline(this.backdropPipeline);
        bgPass.setBindGroup(0, this.globalsBindGroup);
        bgPass.draw(3);
      }
    }
    bgPass.end();

    // ── Pass 2: 3D viewer (cartridge / sketchbook / billboard) over the bg ──
    if (m.viewer && !inGrid) {
      const vh = m.viewerFraction * h;
      const thumb = m.viewerThumbId ? this.thumbAtlas.get(m.viewerThumbId) : null;
      this.viewer.render(encoder, view, w, h, { x: 0, y: 0, w, h: vh }, m.viewer, now, thumb);
    }

    // ── Pass 3: all 2D UI on top (so chrome sits ABOVE the viewer) ──
    const ui = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }],
    });

    // inset panel (home only — the illustrations grid floats with no panel)
    if (!inGrid) {
      ui.setPipeline(this.panelPipeline);
      ui.setBindGroup(0, this.globalsBindGroup);
      ui.setBindGroup(1, this.panelBindGroup);
      ui.draw(6);
    }

    // illustrations project grid (curved floating thumbnail cards)
    if (gridCount > 0) {
      ui.setPipeline(this.gridPipeline);
      ui.setBindGroup(0, this.globalsBindGroup);
      ui.setBindGroup(1, this.thumbBindGroup);
      ui.setVertexBuffer(0, this.quadBuf);
      ui.setVertexBuffer(1, this.gridBuf);
      ui.draw(6, gridCount);
    }

    // tiles
    if (tiles.length > 0) {
      ui.setPipeline(this.tilePipeline);
      ui.setBindGroup(0, this.globalsBindGroup);
      ui.setBindGroup(1, this.thumbBindGroup);
      ui.setVertexBuffer(0, this.quadBuf);
      ui.setVertexBuffer(1, this.tileBuf);
      ui.draw(6, tiles.length);
    }

    // window frames (Win9x chrome overlays) — over the panel/tiles, under labels
    if (windows.length > 0) {
      ui.setPipeline(this.windowPipeline);
      ui.setBindGroup(0, this.globalsBindGroup);
      ui.setVertexBuffer(0, this.quadBuf);
      ui.setVertexBuffer(1, this.windowBuf);
      ui.draw(6, windows.length);
    }

    // dwell countdown ring around the focused tile
    if (drawRing) {
      ui.setPipeline(this.ringPipeline);
      ui.setBindGroup(0, this.globalsBindGroup);
      ui.setVertexBuffer(0, this.quadBuf);
      ui.setVertexBuffer(1, this.ringBuf);
      ui.draw(6, 1);
    }

    // chrome badges (pills behind chrome text)
    if (badges.length > 0) {
      ui.setPipeline(this.badgePipeline);
      ui.setBindGroup(0, this.globalsBindGroup);
      ui.setVertexBuffer(0, this.quadBuf);
      ui.setVertexBuffer(1, this.badgeBuf);
      ui.draw(6, badges.length);
    }

    // labels
    if (labelCount > 0 && this.labelBindGroup) {
      ui.setPipeline(this.labelPipeline);
      ui.setBindGroup(0, this.globalsBindGroup);
      ui.setBindGroup(1, this.labelBindGroup);
      ui.setVertexBuffer(0, this.quadBuf);
      ui.setVertexBuffer(1, this.labelBuf);
      ui.draw(6, labelCount);
    }

    // page arrows
    if (arrows.length > 0) {
      ui.setPipeline(this.arrowPipeline);
      ui.setBindGroup(0, this.globalsBindGroup);
      ui.setVertexBuffer(0, this.quadBuf);
      ui.setVertexBuffer(1, this.arrowBuf);
      ui.draw(6, arrows.length);
    }

    // HTML-in-Canvas element (drawn before grain so the grain prints over it)
    if (htmlTex && this.htmlBindGroup) {
      ui.setPipeline(this.htmlPipeline);
      ui.setBindGroup(0, this.globalsBindGroup);
      ui.setBindGroup(1, this.htmlBindGroup);
      ui.draw(6);
    }

    // riso paper grain over the whole composite (multiply) — drawn last
    ui.setPipeline(this.grainPipeline);
    ui.draw(3);
    ui.end();

    // System-app 3D discs — drawn over the composited 2D tiles, each in its own
    // depth pass at the tile's screen rect.
    if (this.viewer) {
      let discSlot = 0;
      for (const t of m.tiles) {
        const region = { x: t.rect[0], y: t.rect[1], w: t.rect[2], h: t.rect[3] };
        if (t.cd) {
          this.viewer.drawCD(encoder, view, w, h, region, null, now, discSlot);  // null cover = holographic (P1)
          discSlot++;
        } else if (t.billboardKey) {
          const icon = this.thumbAtlas.get(t.billboardKey);
          this.viewer.drawBillboard(encoder, view, w, h, region, t.billboardKey, icon, now, discSlot, m.billboardOutline, m.backdropGrid);
          discSlot++;
        } else if (t.discIcon) {
          const icon = this.thumbAtlas.get(t.discIcon);
          this.viewer.drawDisc(encoder, view, w, h, region, icon, now, discSlot);
          discSlot++;
        }
      }
    }

    // ── Mode cross-fade scrim (drawn over everything, incl. the 3D tiles) ──
    // modeFade 0→1; the dip peaks at the midpoint, hiding the home↔grid swap.
    const modeFade = m.modeFade ?? (m.projectGrid ? 1 : 0);
    const scrimAlpha = 1 - Math.abs(2 * modeFade - 1);
    if (scrimAlpha > 0.001) {
      const sd = this.scratch('scrim', 12);
      sd[0] = m.bgTop[0];    sd[1] = m.bgTop[1];    sd[2]  = m.bgTop[2];    sd[3]  = 1;
      sd[4] = m.bgBottom[0]; sd[5] = m.bgBottom[1]; sd[6]  = m.bgBottom[2]; sd[7]  = 1;
      sd[8] = scrimAlpha;    sd[9] = 0;             sd[10] = 0;             sd[11] = 0;
      this.device.queue.writeBuffer(this.scrimBuf, 0, sd, 0, 12);
      const scrimPass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }],
      });
      scrimPass.setPipeline(this.scrimPipeline);
      scrimPass.setBindGroup(0, this.scrimBindGroup);
      scrimPass.draw(3);
      scrimPass.end();
    }

    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.quadBuf.destroy();
    this.globalsBuf.destroy();
    this.bgBuf.destroy();
    this.panelBuf.destroy();
    this.htmlLayer.destroy();
    this.htmlRectBuf.destroy();
    this.tileBuf.destroy();
    this.arrowBuf.destroy();
    this.badgeBuf.destroy();
    this.ringBuf.destroy();
    this.labelBuf.destroy();
    this.labelAtlas.destroy();
    this.thumbAtlas.destroy();
    this.viewer.destroy();
  }
}
