/**
 * shell-escape-guard.ts — when the Shell's window-level Escape (Illustrations grid → home) must NOT act.
 *
 * The Shell listens for Escape on `window`, so an Escape pressed in a host dialog (a Material dialog, the host's own
 * Settings modal) used to close the dialog AND flip the Shell grid back to the home behind it. It now ignores:
 *  - an event a handler already consumed (`defaultPrevented` — the CDK dialog prevents the Escape it closes on);
 *  - any Escape while a modal is open in the page (a CDK backdrop, an `aria-modal` dialog, an open `<dialog>`);
 *  - an Escape typed into an editable field (it belongs to that field).
 */

/** Selector for "a modal is open over the page". */
export const SHELL_MODAL_SELECTOR = '.cdk-overlay-backdrop-showing, [aria-modal="true"], dialog[open]';

/** True when the page shows a modal (dialog / overlay backdrop) above the Shell. */
export function isHostModalOpen(doc: Pick<Document, 'querySelector'> | null | undefined): boolean {
  if (!doc) return false;
  try { return !!doc.querySelector(SHELL_MODAL_SELECTOR); } catch { return false; }
}

/** The bits of a KeyboardEvent the guard reads (a plain object in tests). */
export interface ShellEscapeEventLike {
  key: string;
  defaultPrevented: boolean;
  target?: EventTarget | null;
}

function isEditableTarget(t: unknown): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** Should the Shell ignore this keydown (for its Escape action)? `modalOpen` = isHostModalOpen(document). */
export function shellShouldIgnoreEscape(e: ShellEscapeEventLike, modalOpen: boolean): boolean {
  if (e.key !== 'Escape') return true;
  return e.defaultPrevented || modalOpen || isEditableTarget(e.target);
}
