import { describe, it, expect } from 'vitest';
import { shellCartCountLabel, shellEmptyGridLines, whenStylesheetLoaded, type StylesheetLinkLike } from './shell-chrome-logic';

describe('shellCartCountLabel', () => {
  it('uses plain words, never "0 CARTS"', () => {
    expect(shellCartCountLabel(0)).toBe('No carts yet');
    expect(shellCartCountLabel(1)).toBe('1 cart');
    expect(shellCartCountLabel(7)).toBe('7 carts');
    expect(shellCartCountLabel(-3)).toBe('No carts yet');
    expect(shellCartCountLabel(Number.NaN)).toBe('No carts yet');
  });
});

describe('shellEmptyGridLines', () => {
  it('names the dashboard and the button that starts a project (tap on touch, click otherwise)', () => {
    expect(shellEmptyGridLines('illustration', true)).toEqual(['No illustrations yet', 'Tap + New Project to start one']);
    expect(shellEmptyGridLines('illustration', false)[1]).toBe('Click + New Project to start one');
    expect(shellEmptyGridLines('packaging', true)).toEqual(['No packaging projects yet', 'Tap + New Product Packaging to start one']);
  });
});

/** A fake <link>: fire('load' | 'error') runs the listeners like the browser would. */
function fakeLink(sheet: unknown = null) {
  const ls = new Map<string, Set<() => void>>();
  const link: StylesheetLinkLike & { fire(t: string): void; count(): number } = {
    sheet,
    addEventListener(t, cb) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t)!.add(cb); },
    removeEventListener(t, cb) { ls.get(t)?.delete(cb); },
    fire(t) { for (const cb of [...(ls.get(t) ?? [])]) cb(); },
    count() { let n = 0; for (const s of ls.values()) n += s.size; return n; },
  };
  return link;
}

describe('whenStylesheetLoaded (first-load fallback-font fix)', () => {
  const timers = () => {
    const pending: { cb: () => void; ms: number; cleared: boolean }[] = [];
    return {
      pending,
      set: (cb: () => void, ms: number) => { const t = { cb, ms, cleared: false }; pending.push(t); return t; },
      clear: (t: unknown) => { (t as { cleared: boolean }).cleared = true; },
    };
  };

  it('resolves at once when the sheet is already there', async () => {
    const t = timers();
    await whenStylesheetLoaded(fakeLink({}), 5000, t.set, t.clear);
    expect(t.pending).toHaveLength(0);
  });

  it('waits for load (not before), then drops its listeners and timer', async () => {
    const t = timers();
    const link = fakeLink();
    let done = false;
    const p = whenStylesheetLoaded(link, 5000, t.set, t.clear).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    link.fire('load');
    await p;
    expect(done).toBe(true);
    expect(link.count()).toBe(0);
    expect(t.pending[0].cleared).toBe(true);
  });

  it('a failed sheet or the timeout also resolves (the Shell falls back to the system font)', async () => {
    const t1 = timers();
    const l1 = fakeLink();
    const p1 = whenStylesheetLoaded(l1, 5000, t1.set, t1.clear);
    l1.fire('error');
    await p1;
    const t2 = timers();
    const l2 = fakeLink();
    const p2 = whenStylesheetLoaded(l2, 5000, t2.set, t2.clear);
    expect(t2.pending[0].ms).toBe(5000);
    t2.pending[0].cb();
    await p2;
    expect(l2.count()).toBe(0);
  });
});
