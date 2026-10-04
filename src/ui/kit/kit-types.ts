/**
 * src/ui/kit/kit-types.ts
 *
 * Data model for the screen-space UI KIT (docs/ui/persona-ui-kit.md) — a set of reusable, parametric HUD / menu /
 * transition pieces in a bold "slanted panel + halftone + kinetic type" style, built on the UI System.
 *
 * A kit WIDGET is plain data stored on its UI layer (`UILayerData.kit`, optional → old documents are unchanged). It is
 * laid out in a 1920x1080 DESIGN space relative to a screen anchor, so it keeps its place and size at any canvas size,
 * and it is drawn by one instanced SDF/pattern shader in the post-process-immune overlay stage (full canvas
 * resolution — never touched by TAAU, resolution scaling, bloom, grading or the lo-fi pass).
 *
 * Kind-specific settings live in a flat `props` bag described by KIT_SCHEMA (kit-schema.ts), so the authoring panel
 * renders generic controls and persistence is a plain JSON copy.
 */

/** Every kit piece. */
export type UIKitKind =
  | 'panel'      // slanted panel: skew, jagged/torn edges, offset drop shape, pattern fill
  | 'card'       // tilted card with a border, inner pattern and a title
  | 'tone'       // screen-tone overlay (halftone / stripes / lines), full screen or a box
  | 'heading'    // slanted heading: outlined text with an offset shadow and a slash underline
  | 'ransom'     // cut-out letters: mixed fonts, rotated tiles, alternating fill / outline
  | 'bar'        // HP / SP bar with slanted ends
  | 'status'     // status panel: portrait card + name + HP/SP bars
  | 'date'       // date / time-of-day / weather corner widget
  | 'minimap'    // mini-map frame (stylised streets + player arrow)
  | 'prompt'     // button prompt: key cap + action label
  | 'menu'       // menu list: staggered items, snapping + wobbling highlight, cursor
  | 'splash'     // splash text with a burst + radial stripes behind it
  | 'damage'     // damage number pop
  | 'banner'     // location banner (district change)
  | 'callout';   // interaction call-out bubble (talk / open)

/** Screen anchor the widget's (x, y) offset is measured from. */
export type UIKitAnchor = 'tl' | 'tc' | 'tr' | 'ml' | 'c' | 'mr' | 'bl' | 'bc' | 'br';

export type UIKitPropValue = number | string | boolean;

/** Intro animation played when the widget becomes visible (state enter) or via a playAnimation action. */
export interface UIKitIntro {
  type: 'none' | 'slide' | 'pop' | 'punch' | 'drop' | 'spin';
  dir?: 'left' | 'right' | 'up' | 'down';
  delayMs?: number;
  durationMs?: number;
}

/** The kit palette (CSS hex). Widgets inherit the defaults (KIT_PALETTE) and may override any entry. */
export interface UIKitPalette {
  /** The loud colour (default red). */
  primary?: string;
  /** Ink / black. */
  ink?: string;
  /** Paper / white. */
  paper?: string;
  /** Accent (yellow by default; swap to cyan, pink…). */
  accent?: string;
}

/** One kit piece on a UI layer. */
export interface UIKitWidget {
  id: string;
  kind: UIKitKind;
  name?: string;
  anchor: UIKitAnchor;
  /** Offset from the anchor in DESIGN px (1920x1080 reference, y down). The widget's centre sits here. */
  x: number;
  y: number;
  /** Uniform scale (1 = design size). */
  scale?: number;
  /** Rotation in degrees (clockwise). */
  rotation?: number;
  /** Shown at all? (state-independent master switch). Default true. */
  visible?: boolean;
  /** State ids this widget shows in. Omitted / empty = every state. */
  visibleInStates?: string[];
  /** Draw order (higher = on top). */
  z?: number;
  /** 0..1 opacity. */
  opacity?: number;
  palette?: UIKitPalette;
  intro?: UIKitIntro;
  /** Kind-specific settings (see KIT_SCHEMA). Missing keys fall back to the schema defaults. */
  props: Record<string, UIKitPropValue>;
}

/** Kit transition types — added to TransitionAnimation.type and drawn by the kit (over everything). */
export type UIKitTransitionType = 'slash' | 'shatter' | 'stripeBurst' | 'panelSlide' | 'zoomPunch';
export const UI_KIT_TRANSITIONS: readonly UIKitTransitionType[] = ['slash', 'shatter', 'stripeBurst', 'panelSlide', 'zoomPunch'];
export function isKitTransition(t: string): t is UIKitTransitionType { return (UI_KIT_TRANSITIONS as readonly string[]).includes(t); }

/** Clip names a playAnimation action can play on a kit widget (targetId = the widget id). */
export type UIKitClip = 'intro' | 'slide' | 'pop' | 'punch' | 'drop' | 'spin' | 'shake' | 'wobble' | 'pulse';
export const UI_KIT_CLIPS: readonly UIKitClip[] = ['intro', 'slide', 'pop', 'punch', 'drop', 'spin', 'shake', 'wobble', 'pulse'];

/** Property descriptor for the authoring panel (one control). */
export interface UIKitPropSpec {
  key: string;
  label: string;
  type: 'number' | 'text' | 'color' | 'bool' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** Default used when the widget's props omit the key. */
  def: UIKitPropValue;
}
