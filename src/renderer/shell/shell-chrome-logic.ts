/**
 * shell-chrome-logic.ts — small pure helpers for the Shell's chrome (no GPU, no DOM beyond the duck-typed link):
 * the cart-count wording, the empty-grid message, and waiting for the web-font stylesheet before the font load.
 * Unit-tested in shell-chrome-logic.test.ts.
 */

/** The cart count in the top-right cluster: plain words, not "0 CARTS". */
export function shellCartCountLabel(n: number): string {
  const c = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return c === 0 ? 'No carts yet' : c === 1 ? '1 cart' : `${c} carts`;
}

/** The two lines shown on an EMPTY Illustrations / Package grid (heading, hint). `coarse` = a touch screen. */
export function shellEmptyGridLines(kind: 'illustration' | 'packaging', coarse: boolean): [string, string] {
  const verb = coarse ? 'Tap' : 'Click';
  return kind === 'packaging'
    ? ['No packaging projects yet', `${verb} + New Product Packaging to start one`]
    : ['No illustrations yet', `${verb} + New Project to start one`];
}

/** The parts of an HTMLLinkElement {@link whenStylesheetLoaded} uses. */
export interface StylesheetLinkLike {
  /** Non-null once the stylesheet has loaded (also for a cross-origin sheet). */
  readonly sheet: unknown;
  addEventListener(type: 'load' | 'error', cb: () => void, opts?: { once?: boolean }): void;
  removeEventListener(type: 'load' | 'error', cb: () => void): void;
}

/**
 * Resolves once `link`'s stylesheet has loaded (or failed, or `timeoutMs` passed). The Shell's web fonts come from a
 * Google Fonts stylesheet: `document.fonts.load()` called BEFORE that sheet has arrived finds no @font-face for
 * "Bungee" and resolves at once with nothing — the labels were then rasterised in the fallback font and never redone
 * (the first-load fallback-font bug). Waiting for the sheet first makes the font load real.
 */
export function whenStylesheetLoaded(
  link: StylesheetLinkLike,
  timeoutMs: number,
  setTimer: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
  clearTimer: (t: unknown) => void = (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
): Promise<void> {
  if (link.sheet) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: unknown = null;
    const done = () => {
      link.removeEventListener('load', done);
      link.removeEventListener('error', done);
      if (timer !== null) clearTimer(timer);
      resolve();
    };
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    timer = setTimer(done, Math.max(0, timeoutMs));
  });
}
