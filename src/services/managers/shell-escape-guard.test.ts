import { describe, it, expect } from 'vitest';
import { isHostModalOpen, shellShouldIgnoreEscape, SHELL_MODAL_SELECTOR } from './shell-escape-guard';

const esc = (over: Partial<{ defaultPrevented: boolean; target: unknown }> = {}) =>
  ({ key: 'Escape', defaultPrevented: false, target: null, ...over }) as Parameters<typeof shellShouldIgnoreEscape>[0];

describe('shell Escape guard (a dialog Escape must not flip the Shell behind it)', () => {
  it('acts on a plain Escape with no modal open', () => {
    expect(shellShouldIgnoreEscape(esc(), false)).toBe(false);
  });

  it('ignores an Escape a dialog already consumed (defaultPrevented)', () => {
    expect(shellShouldIgnoreEscape(esc({ defaultPrevented: true }), false)).toBe(true);
  });

  it('ignores any Escape while a modal is open', () => {
    expect(shellShouldIgnoreEscape(esc(), true)).toBe(true);
  });

  it('ignores an Escape typed into an editable field', () => {
    expect(shellShouldIgnoreEscape(esc({ target: { tagName: 'input' } as unknown as EventTarget }), false)).toBe(true);
    expect(shellShouldIgnoreEscape(esc({ target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }), false)).toBe(true);
    expect(shellShouldIgnoreEscape(esc({ target: { tagName: 'CANVAS' } as unknown as EventTarget }), false)).toBe(false);
  });

  it('other keys are never the Shell Escape', () => {
    expect(shellShouldIgnoreEscape({ key: 'Enter', defaultPrevented: false }, false)).toBe(true);
  });

  it('isHostModalOpen queries the modal selector (and survives a missing / throwing document)', () => {
    let asked = '';
    expect(isHostModalOpen({ querySelector: (s: string) => { asked = s; return {} as Element; } } as Pick<Document, 'querySelector'>)).toBe(true);
    expect(asked).toBe(SHELL_MODAL_SELECTOR);
    expect(isHostModalOpen({ querySelector: () => null } as Pick<Document, 'querySelector'>)).toBe(false);
    expect(isHostModalOpen({ querySelector: () => { throw new Error('x'); } } as unknown as Pick<Document, 'querySelector'>)).toBe(false);
    expect(isHostModalOpen(null)).toBe(false);
  });
});
