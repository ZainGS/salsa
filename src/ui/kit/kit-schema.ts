/**
 * src/ui/kit/kit-schema.ts
 *
 * Per-kind property schema for the UI kit — the single source of truth for (a) every kind's defaults (a widget's
 * `props` may omit any key) and (b) the generic controls the authoring panel renders. Colour props take a palette
 * TOKEN ('primary' | 'ink' | 'paper' | 'accent') or a CSS hex, so a whole HUD re-themes by changing the palette.
 */

import type { UIKitKind, UIKitPropSpec, UIKitPropValue, UIKitWidget, UIKitPalette } from './kit-types';

/** Default palette: loud red, ink black, warm paper white, yellow accent. */
export const KIT_PALETTE: Required<UIKitPalette> = {
  primary: '#e3141f',
  ink: '#0c0b0d',
  paper: '#f6f2ea',
  accent: '#ffe23a',
};

export const KIT_COLOR_TOKENS = ['primary', 'ink', 'paper', 'accent'] as const;
export const KIT_FONTS = ['impact', 'sans', 'serif', 'slab', 'mono', 'script'] as const;
export const KIT_PATTERNS = ['none', 'halftone', 'stripes', 'gradient', 'lines', 'checker'] as const;
export const KIT_ANCHORS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'] as const;
export const KIT_INTROS = ['none', 'slide', 'pop', 'punch', 'drop', 'spin'] as const;

const n = (key: string, label: string, def: number, min: number, max: number, step = 1): UIKitPropSpec => ({ key, label, type: 'number', def, min, max, step });
const t = (key: string, label: string, def: string): UIKitPropSpec => ({ key, label, type: 'text', def });
const c = (key: string, label: string, def: string): UIKitPropSpec => ({ key, label, type: 'color', def });
const b = (key: string, label: string, def: boolean): UIKitPropSpec => ({ key, label, type: 'bool', def });
const s = (key: string, label: string, def: string, options: readonly string[]): UIKitPropSpec => ({ key, label, type: 'select', def, options: [...options] });

const PATTERN_PROPS: UIKitPropSpec[] = [
  s('pattern', 'Pattern', 'none', KIT_PATTERNS),
  c('patternColor', 'Pattern colour', 'ink'),
  n('patternScale', 'Pattern size', 10, 3, 60),
  n('patternAngle', 'Pattern angle', 45, -90, 90),
  n('patternAmount', 'Pattern amount', 0.5, 0, 1, 0.05),
];
const DROP_PROPS: UIKitPropSpec[] = [
  b('drop', 'Drop shape', true),
  n('dropX', 'Drop X', 14, -80, 80),
  n('dropY', 'Drop Y', 12, -80, 80),
  c('dropColor', 'Drop colour', 'ink'),
];

/** Every kind's controls, in panel order. */
export const KIT_SCHEMA: Record<UIKitKind, UIKitPropSpec[]> = {
  panel: [
    n('w', 'Width', 520, 20, 1920), n('h', 'Height', 120, 10, 1080),
    n('skew', 'Slant', 0.25, -1, 1, 0.01),
    c('fill', 'Fill', 'primary'),
    n('border', 'Border', 0, 0, 40), c('borderColor', 'Border colour', 'paper'),
    n('jag', 'Jagged edge', 0, 0, 40), n('jagWave', 'Jag spacing', 26, 4, 120), n('seed', 'Seed', 1, 0, 999),
    ...PATTERN_PROPS, ...DROP_PROPS,
  ],
  card: [
    n('w', 'Width', 300, 40, 1200), n('h', 'Height', 400, 40, 1080),
    c('fill', 'Fill', 'ink'), n('border', 'Border', 10, 0, 40), c('borderColor', 'Border colour', 'paper'),
    n('cornerCut', 'Corner cut', 46, 0, 300),
    t('title', 'Title', 'CARD'), n('titleSize', 'Title size', 44, 8, 200), c('titleColor', 'Title colour', 'paper'),
    s('font', 'Font', 'impact', KIT_FONTS),
    { ...PATTERN_PROPS[0], def: 'halftone' }, { ...PATTERN_PROPS[1], def: 'primary' }, ...PATTERN_PROPS.slice(2),
    ...DROP_PROPS.map((p) => (p.key === 'dropColor' ? { ...p, def: 'primary' } : p)),
  ],
  tone: [
    b('full', 'Full screen', true), n('w', 'Width', 800, 10, 1920), n('h', 'Height', 400, 10, 1080),
    s('pattern', 'Pattern', 'halftone', KIT_PATTERNS.filter((p) => p !== 'none')),
    c('color', 'Colour', 'ink'), n('alpha', 'Opacity', 0.35, 0, 1, 0.05),
    n('patternScale', 'Size', 14, 3, 80), n('patternAngle', 'Angle', 45, -90, 90), n('patternAmount', 'Amount', 0.6, 0, 1, 0.05),
    s('fade', 'Fade', 'right', ['none', 'left', 'right', 'up', 'down', 'radial']),
  ],
  heading: [
    t('text', 'Text', 'HEADING'), n('size', 'Size', 96, 8, 400), s('font', 'Font', 'impact', KIT_FONTS),
    n('slant', 'Slant', 0.22, -0.6, 0.6, 0.01),
    c('fill', 'Fill', 'paper'), c('outline', 'Outline', 'ink'), n('outlineW', 'Outline width', 9, 0, 40),
    c('shadow', 'Shadow', 'primary'), n('shadowX', 'Shadow X', 10, -60, 60), n('shadowY', 'Shadow Y', 9, -60, 60),
    b('underline', 'Slash underline', true), c('underlineColor', 'Underline colour', 'primary'),
  ],
  ransom: [
    t('text', 'Text', 'TAKE YOUR TIME'), n('size', 'Size', 84, 8, 300), n('seed', 'Seed', 7, 0, 999),
    n('jitter', 'Tile rotation', 10, 0, 40), n('spacing', 'Spacing', 0.06, -0.3, 0.6, 0.01),
    b('tiles', 'Paper tiles', true), b('mixFonts', 'Mixed fonts', true), b('outlineLetters', 'Outline letters', true),
  ],
  bar: [
    t('label', 'Label', 'HP'), n('value', 'Value', 72, 0, 9999), n('max', 'Max', 100, 1, 9999),
    t('valueVar', 'Value variable', ''), t('maxVar', 'Max variable', ''),
    n('w', 'Width', 340, 40, 1600), n('h', 'Height', 26, 6, 200), n('slant', 'End slant', 0.6, 0, 3, 0.05),
    c('fillColor', 'Fill', 'accent'), c('back', 'Back', 'ink'), c('frame', 'Frame', 'paper'),
    b('showNumber', 'Show number', true),
  ],
  status: [
    t('name', 'Name', 'KAITO'), n('level', 'Level', 12, 1, 99),
    n('hp', 'HP', 82, 0, 9999), n('hpMax', 'HP max', 100, 1, 9999), n('sp', 'SP', 40, 0, 9999), n('spMax', 'SP max', 60, 1, 9999),
    t('hpVar', 'HP variable', ''), t('spVar', 'SP variable', ''),
    c('portraitColor', 'Portrait colour', 'primary'), c('hpColor', 'HP colour', 'accent'), c('spColor', 'SP colour', '#3cc8ff'),
    s('portrait', 'Portrait', 'mask', ['mask', 'silhouette', 'star']),
  ],
  date: [
    n('month', 'Month', 10, 1, 12), n('day', 'Day', 4, 1, 31), t('weekday', 'Weekday', 'SUN'),
    t('time', 'Time of day', 'AFTER SCHOOL'), s('weather', 'Weather', 'sunny', ['sunny', 'cloudy', 'rain', 'night']),
    t('dayVar', 'Day variable', ''), t('timeVar', 'Time variable', ''), t('weatherVar', 'Weather variable', ''),
  ],
  minimap: [
    n('size', 'Size', 260, 60, 800), s('shape', 'Shape', 'diamond', ['diamond', 'square', 'circle']),
    t('label', 'District', 'KITAZAWA'), n('heading', 'Player heading', 30, -180, 180), n('seed', 'Street seed', 3, 0, 999),
    t('headingVar', 'Heading variable', ''),
  ],
  prompt: [
    t('key', 'Key', 'E'), t('label', 'Label', 'TALK'), s('style', 'Key cap', 'circle', ['circle', 'square', 'diamond']),
    n('size', 'Size', 44, 10, 200),
  ],
  menu: [
    t('items', 'Items (| separated)', 'RESUME|PARTY|ITEMS|SYSTEM|QUIT'),
    n('size', 'Text size', 62, 10, 200), n('spacing', 'Spacing', 88, 20, 300), n('stagger', 'Stagger', 30, -120, 120),
    n('selected', 'Selected', 0, 0, 20), t('selectedVar', 'Selected variable', ''),
    c('highlight', 'Highlight', 'primary'), c('text', 'Text', 'paper'), c('selText', 'Selected text', 'ink'),
    s('font', 'Font', 'impact', KIT_FONTS),
    b('keyNav', 'Arrow-key navigation', true), b('cursor', 'Cursor', true), n('wobble', 'Wobble', 1, 0, 3, 0.1),
  ],
  splash: [
    t('text', 'Text', 'CRITICAL!'), n('size', 'Size', 150, 20, 400), s('textStyle', 'Text style', 'ransom', ['ransom', 'heading']),
    b('burst', 'Burst', true), n('spikes', 'Burst spikes', 14, 5, 40), c('burstColor', 'Burst colour', 'primary'),
    b('stripes', 'Radial stripes', true), n('seed', 'Seed', 4, 0, 999),
  ],
  damage: [
    t('value', 'Value', '1337'), n('size', 'Size', 96, 10, 300), b('crit', 'Critical', false), c('color', 'Colour', 'accent'),
  ],
  banner: [
    t('title', 'Title', 'KITAZAWA 3-CHOME'), t('subtitle', 'Subtitle', 'SHOPPING ARCADE'), n('w', 'Width', 760, 100, 1920),
    c('fill', 'Fill', 'ink'), c('stripe', 'Stripe', 'primary'),
  ],
  callout: [
    t('text', 'Text', 'TALK'), t('key', 'Key', 'E'), t('icon', 'Icon', '!'), s('tail', 'Tail', 'down', ['down', 'left', 'right', 'none']),
    n('size', 'Size', 1, 0.3, 4, 0.05),
  ],
};

export const KIT_KIND_LABELS: Record<UIKitKind, string> = {
  panel: 'Slanted panel', card: 'Card', tone: 'Screen tone', heading: 'Heading', ransom: 'Ransom letters',
  bar: 'HP/SP bar', status: 'Status panel', date: 'Date / weather', minimap: 'Mini-map frame', prompt: 'Button prompt',
  menu: 'Menu list', splash: 'Splash text', damage: 'Damage number', banner: 'Location banner', callout: 'Call-out',
};

/** Default `props` bag for a kind (a fresh object). */
export function kitDefaults(kind: UIKitKind): Record<string, UIKitPropValue> {
  const out: Record<string, UIKitPropValue> = {};
  for (const p of KIT_SCHEMA[kind] ?? []) out[p.key] = p.def;
  return out;
}

/** Read a prop with the schema default as fallback. */
export function kitProp<T extends UIKitPropValue>(w: UIKitWidget, key: string): T {
  const v = w.props?.[key];
  if (v !== undefined) return v as T;
  const spec = KIT_SCHEMA[w.kind]?.find((p) => p.key === key);
  return (spec?.def ?? 0) as T;
}
export const kitNum = (w: UIKitWidget, key: string): number => { const v = Number(kitProp(w, key)); return Number.isFinite(v) ? v : 0; };
export const kitStr = (w: UIKitWidget, key: string): string => String(kitProp(w, key) ?? '');
export const kitBool = (w: UIKitWidget, key: string): boolean => { const v = kitProp(w, key); return v === true || v === 'true' || v === 1; };

/** Parse '#rgb' / '#rrggbb' / '#rrggbbaa' (or a palette token) → linear-free straight RGBA 0..1 (sRGB values). */
export function kitColor(v: string | undefined, pal: Required<UIKitPalette>): [number, number, number, number] {
  let hex = (v ?? '').trim();
  if ((KIT_COLOR_TOKENS as readonly string[]).includes(hex)) hex = pal[hex as keyof UIKitPalette];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
  if (!m) return [1, 0, 1, 1];
  let h = m[1];
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, bl = parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [r, g, bl, a];
}

/** A widget's resolved palette (defaults + its overrides). */
export function kitPalette(w: UIKitWidget): Required<UIKitPalette> {
  return { ...KIT_PALETTE, ...(w.palette ?? {}) } as Required<UIKitPalette>;
}
