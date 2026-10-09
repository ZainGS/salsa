import { describe, it, expect, vi, afterEach } from 'vitest';
import { EphemeraService } from './ephemera-service';
import { isEphemeraParamVisible, type EphemeraParamSchema, type IEphemeraGenerator } from './ephemera-types';
import { BarcodeCode128Generator } from './generators/barcode-code128';

// Per-param visibility (showIf) for the Ephemera panel — UI dead-controls audit 2026-10-09.

function allGenerators(): IEphemeraGenerator[] {
  const svc = new EphemeraService();
  return svc.getCategories().flatMap(c => svc.getGeneratorsByCategory(c.id));
}

function schemaDefaults(schema: EphemeraParamSchema[]): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const s of schema) p[s.key] = s.default;
  return p;
}

/** A different value for `s` than `cur` (what a user could set the hidden row to). */
function perturb(s: EphemeraParamSchema, cur: unknown): unknown {
  switch (s.type) {
    case 'range': case 'number': {
      const lo = s.min ?? 0, hi = s.max ?? 100;
      return Number(cur) === hi ? lo : hi;
    }
    case 'toggle': return !cur;
    case 'color': return cur === '#123456' ? '#654321' : '#123456';
    case 'seed': return Number(cur) + 7;
    case 'text': return String(cur) + 'ZQ';
    case 'select': return (s.options ?? []).map(o => o.value).find(v => String(v) !== String(cur)) ?? cur;
  }
  return cur;
}

/** States to test: the defaults, plus each controlling key (one named by some showIf) set to each of its values. */
function states(schema: EphemeraParamSchema[]): Record<string, unknown>[] {
  const base = schemaDefaults(schema);
  const controllers = new Set<string>();
  for (const s of schema) {
    const c = s.showIf;
    if (c) for (const x of Array.isArray(c) ? c : [c]) controllers.add(x.key);
  }
  const out: Record<string, unknown>[] = [base];
  for (const key of controllers) {
    const s = schema.find(e => e.key === key)!;
    const values: unknown[] = s.type === 'select' ? (s.options ?? []).map(o => o.value)
      : s.type === 'toggle' ? [true, false]
      : [s.min ?? 0, s.max ?? 100, s.default];
    for (const v of values) out.push({ ...base, [key]: v });
  }
  return out;
}

describe('isEphemeraParamVisible', () => {
  it('always shows a param without showIf', () => {
    expect(isEphemeraParamVisible({}, {})).toBe(true);
  });

  it('equals / notEquals compare as strings (a select hands back "4" for 4)', () => {
    expect(isEphemeraParamVisible({ showIf: { key: 'n', equals: 4 } }, { n: '4' })).toBe(true);
    expect(isEphemeraParamVisible({ showIf: { key: 'n', equals: [1, 2] } }, { n: 3 })).toBe(false);
    expect(isEphemeraParamVisible({ showIf: { key: 'n', notEquals: 1 } }, { n: '1' })).toBe(false);
    expect(isEphemeraParamVisible({ showIf: { key: 'n', notEquals: ['a', 'b'] } }, { n: 'c' })).toBe(true);
  });

  it('truthy follows the toggle', () => {
    expect(isEphemeraParamVisible({ showIf: { key: 't', truthy: true } }, { t: true })).toBe(true);
    expect(isEphemeraParamVisible({ showIf: { key: 't', truthy: true } }, { t: false })).toBe(false);
    expect(isEphemeraParamVisible({ showIf: { key: 't', truthy: false } }, { t: false })).toBe(true);
  });

  it('an array of conditions must all hold', () => {
    const e = { showIf: [{ key: 'a', equals: 'x' }, { key: 'b', truthy: true }] };
    expect(isEphemeraParamVisible(e, { a: 'x', b: true })).toBe(true);
    expect(isEphemeraParamVisible(e, { a: 'x', b: false })).toBe(false);
    expect(isEphemeraParamVisible(e, { a: 'y', b: true })).toBe(false);
  });

  it('a missing value falls back to the schema default', () => {
    const schema = [{ key: 'shape', default: 'starburst' }];
    expect(isEphemeraParamVisible({ showIf: { key: 'shape', equals: 'starburst' } }, {}, schema)).toBe(true);
    expect(isEphemeraParamVisible({ showIf: { key: 'shape', equals: 'circle' } }, {}, schema)).toBe(false);
  });
});

describe('ephemera generator schemas — showIf', () => {
  afterEach(() => vi.restoreAllMocks());

  it('every showIf names a key of the same schema', () => {
    for (const g of allGenerators()) {
      const schema = g.getParamSchema();
      const keys = new Set(schema.map(s => s.key));
      for (const s of schema) {
        const c = s.showIf;
        if (!c) continue;
        for (const x of Array.isArray(c) ? c : [c]) expect(keys.has(x.key), `${g.typeId}.${s.key} → ${x.key}`).toBe(true);
      }
    }
  });

  it('a param hidden in a state really does nothing there (the SVG is unchanged when it changes)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);   // clip / pattern ids use Math.random
    let checked = 0;
    for (const g of allGenerators()) {
      const schema = g.getParamSchema();
      for (const st of states(schema)) {
        const svg = g.generate(st);
        for (const s of schema) {
          if (isEphemeraParamVisible(s, st, schema)) continue;
          const changed = { ...st, [s.key]: perturb(s, st[s.key]) };
          expect(g.generate(changed), `${g.typeId}: "${s.label}" hidden in ${JSON.stringify(st)}`).toBe(svg);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('hides the dead rows the audit listed', () => {
    const byId = new Map(allGenerators().map(g => [g.typeId, g]));
    const vis = (typeId: string, key: string, over: Record<string, unknown>) => {
      const schema = byId.get(typeId)!.getParamSchema();
      const entry = schema.find(s => s.key === key)!;
      return isEphemeraParamVisible(entry, { ...schemaDefaults(schema), ...over }, schema);
    };
    expect(vis('badge:standard', 'points', { shape: 'circle' })).toBe(false);
    expect(vis('badge:standard', 'points', { shape: 'starburst' })).toBe(true);
    expect(vis('rainbow-strip:standard', 'segments', { style: 'smooth' })).toBe(false);
    expect(vis('worn-edges:standard', 'foldCount', { style: 'torn' })).toBe(false);
    expect(vis('worn-edges:standard', 'foldCount', { style: 'all' })).toBe(true);
    expect(vis('barcode:code128', 'fontSize', { showText: false })).toBe(false);
    expect(vis('crosshair:standard', 'ringCount', { style: 'tactical' })).toBe(false);
    expect(vis('crosshair:standard', 'tickCount', { style: 'mil-dot' })).toBe(true);
    expect(vis('geometric-frame:standard', 'seed', { style: 'bracket' })).toBe(false);
    expect(vis('globe:orthographic', 'latLines', { style: 'filled' })).toBe(false);
    expect(vis('globe:orthographic', 'fillColor', { style: 'outline' })).toBe(false);
    expect(vis('motion-lines:standard', 'focusX', { style: 'parallel' })).toBe(false);
    expect(vis('motion-lines:standard', 'jitter', { style: 'shockwave' })).toBe(false);
    expect(vis('motion-lines:standard', 'taper', { style: 'diagonal' })).toBe(false);
    expect(vis('registration-marks:standard', 'gap', { style: 'dot-grid' })).toBe(false);
    expect(vis('serial-string:standard', 'pattern', { preset: 'serial' })).toBe(false);
    expect(vis('serial-string:standard', 'pattern', { preset: 'literal' })).toBe(true);
    expect(vis('serial-string:standard', 'layout', { lines: 1 })).toBe(false);
    expect(vis('stars-sparkles:standard', 'innerRatio', { style: 'starburst' })).toBe(false);
    expect(vis('stars-sparkles:standard', 'strokeWidth', { style: 'filled' })).toBe(false);
    expect(vis('warning-label:standard', 'stripeWidth', { showStripes: false })).toBe(false);
    expect(vis('warning-label:standard', 'style', { showSymbol: false })).toBe(false);
    expect(vis('waveform:standard', 'barCount', { style: 'ecg' })).toBe(false);
    expect(vis('waveform:standard', 'strokeWidth', { style: 'spectrum' })).toBe(false);
  });
});

describe('Code 128 — Bar height (was swapped with the width, audit 2026-10-09)', () => {
  const g = new BarcodeCode128Generator();
  const svgSize = (svg: string) => {
    const m = /<svg[^>]*width="([\d.]+)" height="([\d.]+)"/.exec(svg)!;
    return { w: +m[1], h: +m[2] };
  };

  it('the bars are Bar height tall and the svg is as wide as the code', () => {
    const p = g.getDefaultParams();
    const short = g.generate({ ...p, height: 40, showText: false });
    const tall = g.generate({ ...p, height: 160, showText: false });
    expect(svgSize(short).h).toBe(40);
    expect(svgSize(tall).h).toBe(160);
    expect(svgSize(short).w).toBe(svgSize(tall).w);   // width comes from the code, not the height
    expect(short).toMatch(/<rect x="[\d.]+" y="0" width="[\d.]+" height="40" fill="#000000"\/>/);
  });

  it('the human-readable line sits under the bars', () => {
    const svg = g.generate({ ...g.getDefaultParams(), height: 60, showText: true, fontSize: 10 });
    expect(svgSize(svg).h).toBe(60 + 10 + 6);
    expect(svg).toMatch(/<text x="[\d.]+" y="71"/);
  });

  it('escapes &, < and > in the value', () => {
    const svg = g.generate({ ...g.getDefaultParams(), value: 'A<B&C' });
    expect(svg).toContain('A&lt;B&amp;C');
  });
});
