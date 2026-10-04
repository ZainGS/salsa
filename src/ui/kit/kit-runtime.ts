/**
 * src/ui/kit/kit-runtime.ts
 *
 * Runtime state of the UI kit: which widgets are shown (per the layer's current UI state + runtime visibility
 * overrides), their intro / clip animations, menu selections (snap + wobble), the in-flight kit TRANSITION, and the
 * pointer targets of the last frame. Pure (no GPU / DOM): `build()` lays everything out into one PrimList the GPU
 * renderer uploads, and returns whether anything is still moving so the host keeps scheduling frames.
 *
 * UI time: a monotonic ms clock (performance.now) that is never paused by freezeWorld — or a fixed override
 * (`setClock`) so a transition can be captured frame by frame.
 */

import type { UIValue } from '../ui-types';
import type { UIKitWidget, UIKitIntro, UIKitClip, UIKitTransitionType, UIKitPalette } from './kit-types';
import { PrimList, type KitTextProvider, type V2 } from './kit-prims';
import { layoutWidget, layoutTransition, KIT_TRANSITION_COVER, KIT_TRANSITION_DEFAULT_MS, menuItems, type KitHit, type KitMenuState, type KitLayoutCtx } from './kit-layout';
import { introXf, clipXf, composeXf, kitClipDuration, KIT_XF_IDENTITY } from './kit-anim';
import { kitStr, kitNum, kitBool, KIT_PALETTE } from './kit-schema';

/** What the runtime needs to know about one UI layer. */
export interface KitLayerView {
  id: string;
  visible: boolean;
  kit: readonly UIKitWidget[];
  currentState: string | null;
  /** Ids with ShapeInteractionProps on this layer (a kit widget listed here is a pointer target). */
  interactive: (id: string) => boolean;
  vars: (id: string) => UIValue | undefined;
}

interface WState {
  shown: boolean;
  introAt: number;
  introOverride?: UIKitIntro;
  clip?: { name: UIKitClip; at: number };
  menu?: KitMenuState;
}

export interface KitTransitionState { type: UIKitTransitionType; at: number; duration: number; from: string | null; to: string; layerId?: string; }

export class UIKitRuntime {
  private _clock: number | null = null;
  private readonly _ws = new Map<string, WState>();
  private readonly _visOverride = new Map<string, boolean>();
  private _transition: KitTransitionState | null = null;
  readonly list = new PrimList();
  /** Pointer targets of the last build (device px). */
  hits: KitHit[] = [];
  /** Last build's canvas size (device px) and CSS→device ratio (pointer coordinates arrive in CSS px). */
  lastW = 0; lastH = 0; cssToDevice = 1;
  /** Palette for transitions (the kit default; set from the transition's layer if it has a themed widget). */
  transitionPalette: Required<UIKitPalette> = { ...KIT_PALETTE };

  /** UI time in ms (override or performance.now). */
  now(): number { return this._clock ?? (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
  /** Freeze the kit clock at `ms` (frame-sequence capture / tests); null = live clock. */
  setClock(ms: number | null): void { this._clock = ms; }

  // ── visibility overrides (state shapeVisibility / show/hide/toggle actions on a widget id) ──
  setVisibleOverride(id: string, visible: boolean): void { this._visOverride.set(id, visible); }
  clearVisibleOverrides(): void { this._visOverride.clear(); }
  visibleOverride(id: string): boolean | undefined { return this._visOverride.get(id); }

  private _state(id: string): WState {
    let s = this._ws.get(id);
    if (!s) { s = { shown: false, introAt: -1e9 }; this._ws.set(id, s); }
    return s;
  }
  /** Forget a widget's runtime state (deleted). */
  forget(id: string): void { this._ws.delete(id); this._visOverride.delete(id); }

  // ── animation ──
  /** Play a clip on a widget ('intro' replays its own intro). */
  play(id: string, clip: UIKitClip = 'intro'): void {
    const s = this._state(id), t = this.now();
    if (clip === 'intro') { s.introAt = t; s.introOverride = undefined; s.clip = undefined; }
    else s.clip = { name: clip, at: t };
  }
  stop(id: string): void { const s = this._ws.get(id); if (s) { s.clip = undefined; s.introAt = -1e9; } }

  // ── transitions ──
  startTransition(type: UIKitTransitionType, durationMs: number | undefined, from: string | null, to: string, layerId?: string): void {
    this._transition = { type, at: this.now(), duration: Math.max(60, durationMs || KIT_TRANSITION_DEFAULT_MS[type]), from, to, layerId };
  }
  get transition(): Readonly<KitTransitionState> | null { return this._transition; }
  /** Treat every shown widget as entering again on the next build (a panelSlide / zoomPunch PREVIEW replays the
   *  entrances it drives; a real state change does this naturally for the incoming widgets). */
  replayEntrances(): void { for (const s of this._ws.values()) s.shown = false; }
  /** 0..1 progress of the in-flight transition (null when none). */
  transitionProgress(now = this.now()): number | null {
    const t = this._transition;
    if (!t) return null;
    const p = (now - t.at) / t.duration;
    return p >= 1 ? null : Math.max(0, p);
  }

  // ── menus ──
  /** The menu's live selection state; a `selectedVar` binding (when defined) is the source of truth. */
  menuState(w: UIKitWidget, vars?: (id: string) => UIValue | undefined): KitMenuState {
    const s = this._state(w.id);
    if (!s.menu) { const i = kitNum(w, 'selected'); s.menu = { sel: i, prev: i, changedAt: -1e9 }; }
    const vid = kitStr(w, 'selectedVar');
    if (vid && vars) {
      const v = Number(vars(vid));
      if (Number.isFinite(v) && v !== s.menu.sel) this._moveMenu(s.menu, v);
    }
    return s.menu;
  }
  private _moveMenu(m: KitMenuState, to: number): void {
    // retarget from where the highlight currently is (a quick double tap still reads as a snap)
    m.prev = m.sel; m.sel = to; m.changedAt = this.now();
  }
  /** Set a menu's selection (wraps). Returns the new index. */
  setMenuSelection(w: UIKitWidget, index: number): number {
    const n = Math.max(1, menuItems(w).length);
    const m = this.menuState(w);
    const i = ((Math.round(index) % n) + n) % n;
    if (i !== m.sel) this._moveMenu(m, i);
    return i;
  }

  // ── visibility ──
  /** The state id a layer's widgets are evaluated against (the OLD state while a cover transition closes in). */
  private _visState(layer: KitLayerView, now: number): string | null {
    const t = this._transition;
    if (t && layer.currentState === t.to && (!t.layerId || t.layerId === layer.id)) {
      const p = (now - t.at) / t.duration, cover = KIT_TRANSITION_COVER[t.type];
      if (p < cover) return t.from;
    }
    return layer.currentState;
  }
  isShown(layer: KitLayerView, w: UIKitWidget, stateId: string | null): boolean {
    if (!layer.visible || w.visible === false) return false;
    const ov = this._visOverride.get(w.id);
    if (ov === false) return false;
    if (w.visibleInStates && w.visibleInStates.length) {
      if (ov === true) return true;
      return stateId != null && w.visibleInStates.includes(stateId);
    }
    return true;
  }

  // ── frame ──
  /** Lay out every shown widget (+ the transition overlay on top) into `this.list`. Returns true while anything
   *  animates (the host schedules another frame). */
  build(layers: readonly KitLayerView[], W: number, H: number, text: KitTextProvider, interactive: boolean): boolean {
    const now = this.now();
    this.lastW = W; this.lastH = H;
    this.list.reset();
    this.hits = [];
    let animating = false;
    const t = this._transition;
    if (t && now - t.at >= t.duration) this._transition = null;
    const tr = this._transition;
    const L: KitLayoutCtx = { list: this.list, text, now, interactive, ks: 1, pal: { ...KIT_PALETTE }, vars: () => undefined, hits: this.hits, z: 0 };
    layers.forEach((layer, li) => {
      const st = this._visState(layer, now);
      const sorted = [...layer.kit].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
      let entering = 0;
      for (const w of sorted) {
        const ws = this._state(w.id);
        const shown = this.isShown(layer, w, st);
        if (shown && !ws.shown) {
          ws.introAt = now; ws.introOverride = undefined; ws.clip = undefined;
          if (tr && (tr.type === 'panelSlide' || tr.type === 'zoomPunch') && now - tr.at < tr.duration * 0.5) {
            ws.introOverride = tr.type === 'panelSlide'
              ? { type: 'slide', dir: 'left', delayMs: 40 * entering, durationMs: 460 }
              : { type: 'punch', delayMs: 25 * entering, durationMs: 380 };
          }
          entering++;
        }
        ws.shown = shown;
        if (!shown) continue;
        const intro = ws.introOverride ?? w.intro;
        const ie = now - ws.introAt;
        let xf = introXf(intro, ie);
        if (intro && intro.type !== 'none' && ie < kitClipDuration('intro', intro)) animating = true;
        if (ws.clip) {
          const ce = now - ws.clip.at;
          if (ce < kitClipDuration(ws.clip.name, w.intro)) { xf = composeXf(xf, clipXf(ws.clip.name, ce, w.intro)); animating = true; }
          else ws.clip = undefined;
        }
        L.vars = layer.vars;
        L.z = li * 1000 + (w.z ?? 0);
        L.menu = w.kind === 'menu' ? this.menuState(w, layer.vars) : undefined;
        if (L.menu && now - L.menu.changedAt < 1400) animating = true;
        if (interactive && (w.kind === 'menu' || w.kind === 'splash' || (w.kind === 'date' && kitStr(w, 'weather') === 'sunny'))) animating = true;
        layoutWidget(L, w, W, H, xf ?? KIT_XF_IDENTITY, layer.interactive(w.id));
      }
    });
    if (tr) {
      const p = Math.max(0, Math.min(1, (now - tr.at) / tr.duration));
      layoutTransition(this.list, tr.type, p, W, H, this.transitionPalette, Math.floor(tr.at) % 997);
      animating = true;
    }
    return animating;
  }

  /** Top-most pointer target under a CSS-px point (from the last build), or null. */
  hitTest(cssX: number, cssY: number): KitHit | null {
    const x = cssX * this.cssToDevice, y = cssY * this.cssToDevice;
    let best: KitHit | null = null;
    for (const h of this.hits) if (pointInConvex(h.poly, x, y) && (!best || h.z >= best.z)) best = h;
    return best;
  }
}

/** Point-in-convex-polygon (either winding). */
export function pointInConvex(poly: readonly V2[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (Math.abs(c) < 1e-9) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** Is `w` a menu that accepts arrow keys right now? */
export const kitMenuTakesKeys = (w: UIKitWidget): boolean => w.kind === 'menu' && kitBool(w, 'keyNav');
