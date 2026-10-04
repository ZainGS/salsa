/**
 * src/ui/kit/kit-presets.ts
 *
 * Insertable presets for the UI kit — single pieces ("shape presets") and the two demo LAYERS: a "Persona HUD"
 * (status panels, date / weather, mini-map, prompts, location banner, call-out, a splash state) and a pause menu
 * (screen tone + red slab + ransom heading + menu + card + prompts) with kit transitions between the states.
 * Everything here is plain data; UIManager.insertKitPreset / insertKitDemo add it to a layer.
 */

import type { UIKitWidget, UIKitKind } from './kit-types';
import type { UIStateMachine, StateTransition, SceneVariable } from '../ui-types';
import { kitDefaults } from './kit-schema';

export type KitWidgetDraft = Omit<UIKitWidget, 'id'>;

export interface UIKitPreset { id: string; label: string; kind: UIKitKind; make(): KitWidgetDraft; }

const w = (kind: UIKitKind, anchor: UIKitWidget['anchor'], x: number, y: number, props: Record<string, number | string | boolean> = {}, extra: Partial<KitWidgetDraft> = {}): KitWidgetDraft =>
  ({ kind, anchor, x, y, props: { ...kitDefaults(kind), ...props }, ...extra });

/** Single-piece presets, in panel order. */
export const UI_KIT_PRESETS: UIKitPreset[] = [
  { id: 'panel-red', label: 'Slanted panel (red)', kind: 'panel', make: () => w('panel', 'c', 0, 0, {}, { intro: { type: 'slide', dir: 'left' } }) },
  { id: 'panel-torn', label: 'Torn panel (black, halftone)', kind: 'panel', make: () => w('panel', 'c', 0, 0, { fill: 'ink', jag: 9, jagWave: 22, pattern: 'halftone', patternColor: 'primary', patternAmount: 0.45, dropColor: 'primary', border: 6 }, { intro: { type: 'pop' } }) },
  { id: 'panel-stripes', label: 'Striped slab', kind: 'panel', make: () => w('panel', 'c', 0, 0, { w: 700, h: 200, skew: -0.4, fill: 'paper', pattern: 'stripes', patternColor: 'primary', patternScale: 22, patternAmount: 0.3, dropColor: 'ink' }) },
  { id: 'card', label: 'Card', kind: 'card', make: () => w('card', 'c', 0, 0, { title: 'THE WANDERER' }, { rotation: 8, intro: { type: 'spin' } }) },
  { id: 'tone-halftone', label: 'Screen tone (halftone fade)', kind: 'tone', make: () => w('tone', 'c', 0, 0) },
  { id: 'tone-stripes', label: 'Screen tone (stripes)', kind: 'tone', make: () => w('tone', 'c', 0, 0, { pattern: 'stripes', color: 'primary', alpha: 0.18, patternScale: 26, patternAmount: 0.25, fade: 'left' }) },
  { id: 'heading', label: 'Slanted heading', kind: 'heading', make: () => w('heading', 'tl', 420, 120, { text: 'MISSION LOG' }, { intro: { type: 'slide', dir: 'left' } }) },
  { id: 'ransom', label: 'Ransom letters', kind: 'ransom', make: () => w('ransom', 'c', 0, 0, {}, { intro: { type: 'pop' } }) },
  { id: 'bar-hp', label: 'HP bar', kind: 'bar', make: () => w('bar', 'bl', 300, -80) },
  { id: 'bar-sp', label: 'SP bar', kind: 'bar', make: () => w('bar', 'bl', 300, -40, { label: 'SP', value: 40, max: 60, fillColor: '#3cc8ff', h: 18 }) },
  { id: 'status', label: 'Status panel', kind: 'status', make: () => w('status', 'bl', 330, -130, {}, { intro: { type: 'slide', dir: 'left' } }) },
  { id: 'date', label: 'Date / weather corner', kind: 'date', make: () => w('date', 'tr', -270, 150, {}, { intro: { type: 'slide', dir: 'right' } }) },
  { id: 'minimap', label: 'Mini-map frame', kind: 'minimap', make: () => w('minimap', 'br', -230, -270, {}, { intro: { type: 'pop' } }) },
  { id: 'prompt', label: 'Button prompt', kind: 'prompt', make: () => w('prompt', 'br', -520, -64) },
  { id: 'menu', label: 'Menu list', kind: 'menu', make: () => w('menu', 'ml', 420, 0, {}, { intro: { type: 'slide', dir: 'left' } }) },
  { id: 'splash', label: 'Splash text + burst', kind: 'splash', make: () => w('splash', 'c', 0, -40, {}, { intro: { type: 'punch' } }) },
  { id: 'splash-assault', label: 'Full-assault splash', kind: 'splash', make: () => w('splash', 'c', 0, 0, { text: 'FULL ASSAULT!', size: 130, textStyle: 'heading', spikes: 18 }, { intro: { type: 'punch' } }) },
  { id: 'damage', label: 'Damage number', kind: 'damage', make: () => w('damage', 'c', 220, -160, {}, { intro: { type: 'drop' } }) },
  { id: 'damage-crit', label: 'Critical damage', kind: 'damage', make: () => w('damage', 'c', 220, -160, { crit: true, value: '4096' }, { intro: { type: 'punch' } }) },
  { id: 'banner', label: 'Location banner', kind: 'banner', make: () => w('banner', 'tl', 430, 110, {}, { intro: { type: 'slide', dir: 'left' } }) },
  { id: 'callout', label: 'Interaction call-out', kind: 'callout', make: () => w('callout', 'c', 240, -170, {}, { intro: { type: 'pop' } }) },
];

export function kitPreset(id: string): UIKitPreset | undefined { return UI_KIT_PRESETS.find((p) => p.id === id); }

// ── Demo layers ────────────────────────────────────────────────────────────────────────────────────────────
export interface KitDemo {
  name: string;
  widgets: KitWidgetDraft[];
  /** States / transitions / variables to MERGE into the layer's machine (ids are fixed so a re-insert is idempotent). */
  states: UIStateMachine['states'];
  transitions: StateTransition[];
  variables: SceneVariable[];
  initialStateId: string;
}

const HUD_STATES = ['hud', 'splash'];

/** The "Persona HUD" demo layer. */
export function personaHudDemo(): KitDemo {
  const inHud = { visibleInStates: HUD_STATES };
  return {
    name: 'Persona HUD',
    initialStateId: 'hud',
    widgets: [
      w('banner', 'tl', 440, 104, {}, { ...inHud, intro: { type: 'slide', dir: 'left', delayMs: 120 } }),
      w('date', 'tr', -270, 150, { weather: 'sunny', timeVar: 'timeOfDay' }, { ...inHud, intro: { type: 'slide', dir: 'right' } }),
      w('status', 'bl', 330, -250, { name: 'KAITO', level: 12, hpVar: 'hp', spVar: 'sp' }, { ...inHud, intro: { type: 'slide', dir: 'left', delayMs: 60 } }),
      w('status', 'bl', 300, -95, { name: 'RIN', level: 11, hp: 64, hpMax: 90, sp: 71, spMax: 80, portrait: 'silhouette', portraitColor: '#3cc8ff' }, { ...inHud, scale: 0.78, intro: { type: 'slide', dir: 'left', delayMs: 140 } }),
      w('minimap', 'br', -220, -350, { label: 'KITAZAWA', heading: 30, size: 240 }, { ...inHud, intro: { type: 'pop', delayMs: 100 } }),
      w('prompt', 'br', -870, -66, { key: 'E', label: 'TALK' }, { ...inHud, intro: { type: 'slide', dir: 'right', delayMs: 180 } }),
      w('prompt', 'br', -620, -66, { key: 'ESC', label: 'MENU', style: 'square', size: 44 }, { ...inHud, intro: { type: 'slide', dir: 'right', delayMs: 230 } }),
      w('callout', 'c', 250, -170, { text: 'TALK', key: 'E' }, { visibleInStates: ['hud'], intro: { type: 'pop', delayMs: 300 } }),
      w('splash', 'c', 0, -30, { text: 'FULL ASSAULT!', size: 120 }, { visibleInStates: ['splash'], z: 20, intro: { type: 'punch' } }),
      w('damage', 'c', 330, -200, { value: '4096', crit: true }, { visibleInStates: ['splash'], z: 21, intro: { type: 'drop', delayMs: 160 } }),
    ],
    states: [
      { id: 'hud', name: 'HUD' },
      { id: 'splash', name: 'Splash' },
    ],
    transitions: [
      { id: 'kit-hud-splash', fromState: 'hud', toState: 'splash', trigger: { type: 'keyDown', key: 'f' }, animation: { type: 'zoomPunch', duration: 460 } },
      { id: 'kit-splash-hud', fromState: 'splash', toState: 'hud', trigger: { type: 'timer', delay: 1700 } },
    ],
    variables: [
      { id: 'hp', name: 'HP', type: 'number', defaultValue: 82 },
      { id: 'sp', name: 'SP', type: 'number', defaultValue: 40 },
      { id: 'timeOfDay', name: 'Time of day', type: 'string', defaultValue: 'AFTER SCHOOL' },
    ],
  };
}

/** The pause-menu demo. `playState` = the state Escape opens it from (the HUD demo's 'hud', or a plain 'play'). */
export function personaPauseDemo(playState: string): KitDemo {
  const inPause = { visibleInStates: ['pause'] };
  return {
    name: 'Pause Menu',
    initialStateId: playState,
    widgets: [
      w('tone', 'c', 0, 0, { color: 'ink', alpha: 0.42, pattern: 'halftone', patternScale: 13, fade: 'right' }, { ...inPause, z: -10 }),
      w('panel', 'ml', 330, 40, { w: 760, h: 1500, skew: 0.18, fill: 'primary', pattern: 'halftone', patternColor: 'ink', patternAmount: 0.35, patternScale: 12, dropX: 34, dropY: 0, border: 0 }, { ...inPause, z: -5, rotation: 9, intro: { type: 'slide', dir: 'left', durationMs: 380 } }),
      w('panel', 'ml', 90, 40, { w: 120, h: 1500, skew: 0.18, fill: 'ink', drop: false }, { ...inPause, z: -4, rotation: 9, intro: { type: 'slide', dir: 'left', durationMs: 320 } }),
      w('ransom', 'tl', 330, 110, { text: 'PAUSE', size: 96, seed: 11 }, { ...inPause, z: 2, rotation: -6, intro: { type: 'drop', delayMs: 120 } }),
      w('menu', 'ml', 420, 60, { items: 'RESUME|PARTY|ITEMS|SYSTEM|QUIT', selectedVar: 'pauseSel', size: 66, spacing: 98, highlight: 'paper', selText: 'ink' }, { ...inPause, z: 5, intro: { type: 'slide', dir: 'left', delayMs: 80 } }),
      w('card', 'mr', -380, -30, { title: 'THE WANDERER', w: 320, h: 440 }, { ...inPause, z: 3, rotation: 7, intro: { type: 'spin', delayMs: 160 } }),
      w('heading', 'tr', -330, 96, { text: 'TOTAL  ¥ 48,200', size: 46, underline: false, shadowX: 6, shadowY: 5 }, { ...inPause, z: 3, intro: { type: 'slide', dir: 'right', delayMs: 200 } }),
      w('prompt', 'br', -700, -64, { key: '↑↓', label: 'SELECT', size: 40, style: 'square' }, { ...inPause, z: 4, intro: { type: 'slide', dir: 'right', delayMs: 220 } }),
      w('prompt', 'br', -440, -64, { key: '⏎', label: 'CONFIRM', size: 40 }, { ...inPause, z: 4, intro: { type: 'slide', dir: 'right', delayMs: 260 } }),
      w('prompt', 'br', -190, -64, { key: 'ESC', label: 'BACK', size: 40, style: 'square' }, { ...inPause, z: 4, intro: { type: 'slide', dir: 'right', delayMs: 300 } }),
    ],
    states: [
      { id: playState, name: playState === 'hud' ? 'HUD' : 'Play' },
      { id: 'pause', name: 'Pause', frozen: true, worldBlur: 0.55 },
    ],
    transitions: [
      { id: 'kit-open-pause', fromState: playState, toState: 'pause', trigger: { type: 'keyDown', key: 'Escape' }, animation: { type: 'stripeBurst', duration: 820 } },
      { id: 'kit-close-pause', fromState: 'pause', toState: playState, trigger: { type: 'keyDown', key: 'Escape' }, animation: { type: 'slash', duration: 700 } },
      // menu item ids are "<menuWidgetId>#<slug>" — patched in by insertKitDemo once the menu widget has an id
      { id: 'kit-resume', fromState: 'pause', toState: playState, trigger: { type: 'click', targetId: '@menu#resume' }, animation: { type: 'slash', duration: 700 } },
      { id: 'kit-quit', fromState: 'pause', toState: 'pause', trigger: { type: 'click', targetId: '@menu#quit' }, actions: [{ type: 'emitEvent', eventName: 'quit' }] },
    ],
    variables: [{ id: 'pauseSel', name: 'Pause selection', type: 'number', defaultValue: 0 }],
  };
}
