/**
 * src/ui/ui-form-overlay.ts
 *
 * UIFormOverlay — the DOM half of Phase 4 HTML forms (spec §HtmlFormElement): a `<div class="salsa-ui-form-overlay">`
 * absolutely positioned over the canvas, holding one native control per mounted HtmlFormElement. The UIManager
 * decides WHICH elements are mounted (state-filtered) and owns all semantics (validity, submit values, variable
 * bindings); this class only renders controls, positions them at `canvasBounds` (canvas CSS px), and reports typing.
 *
 * Layout: the overlay div is appended to the canvas's PARENT and positioned at the canvas's offset; each control is
 * absolutely positioned inside it. Call `reposition()` after a canvas resize/move. Labels/decorative borders are
 * canvas-drawn by the author (spec) — the controls here are intentionally bare unless `style` overrides say otherwise.
 */

import type { HtmlFormElement } from './ui-types';
import type { UIFormAdapter } from '../services/managers/ui-manager';

export class UIFormOverlay implements UIFormAdapter {
  private readonly _canvas: HTMLCanvasElement;
  private readonly _onInput: (elementId: string, value: string | boolean) => void;
  private readonly _onSubmit: (formId: string) => void;
  private _root: HTMLDivElement | null = null;
  /** Mounted controls by element id (select/textarea/input). */
  private readonly _controls = new Map<string, { el: HtmlFormElement; node: HTMLElement }>();

  constructor(
    canvas: HTMLCanvasElement,
    hooks: {
      /** User typed/toggled a control (checkbox → boolean). */
      onInput: (elementId: string, value: string | boolean) => void;
      /** User pressed Enter in a single-line field — submit the element's form ('' when untagged). */
      onSubmit: (formId: string) => void;
    },
  ) {
    this._canvas = canvas;
    this._onInput = hooks.onInput;
    this._onSubmit = hooks.onSubmit;
  }

  // ── UIFormAdapter ─────────────────────────────────────────────────────────────────────────────────────────

  /** Mount/unmount so exactly `elements` exist (diffed by id; an id whose definition changed is re-created). */
  sync(elements: HtmlFormElement[]): void {
    if (!elements.length && !this._controls.size) return;
    const want = new Map(elements.map((e) => [e.id, e]));
    for (const [id, rec] of this._controls) {
      const next = want.get(id);
      if (!next || next !== rec.el) { rec.node.remove(); this._controls.delete(id); }   // gone or redefined
    }
    if (!elements.length) { this._root?.remove(); this._root = null; return; }
    const root = this._ensureRoot();
    for (const el of elements) if (!this._controls.has(el.id)) root.appendChild(this._createControl(el));
    this.reposition();
  }

  getValue(elementId: string): string | boolean | null {
    const rec = this._controls.get(elementId);
    if (!rec) return null;
    if (rec.el.type === 'checkbox') return (rec.node as HTMLInputElement).checked;
    if (rec.el.type === 'radio') {
      const checked = rec.node.querySelector<HTMLInputElement>('input:checked');
      return checked ? checked.value : '';
    }
    return (rec.node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  setValue(elementId: string, value: string | boolean): void {
    const rec = this._controls.get(elementId);
    if (!rec) return;
    if (rec.el.type === 'checkbox') { (rec.node as HTMLInputElement).checked = value === true; return; }
    if (rec.el.type === 'radio') {
      for (const r of rec.node.querySelectorAll<HTMLInputElement>('input')) r.checked = r.value === value;
      return;
    }
    (rec.node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value = String(value);
  }

  focus(elementId: string): void {
    const rec = this._controls.get(elementId);
    const target = rec?.node instanceof HTMLDivElement ? rec.node.querySelector<HTMLElement>('input') : rec?.node;
    (target as HTMLElement | null | undefined)?.focus();
  }

  // ── Layout ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Re-anchor the overlay to the canvas and re-place every control (call after a canvas resize/move). */
  reposition(): void {
    if (!this._root) return;
    this._root.style.left = `${this._canvas.offsetLeft}px`;
    this._root.style.top = `${this._canvas.offsetTop}px`;
    this._root.style.width = `${this._canvas.clientWidth}px`;
    this._root.style.height = `${this._canvas.clientHeight}px`;
    for (const { el, node } of this._controls.values()) {
      node.style.left = `${el.canvasBounds.x}px`;
      node.style.top = `${el.canvasBounds.y}px`;
      node.style.width = `${el.canvasBounds.width}px`;
      node.style.height = `${el.canvasBounds.height}px`;
    }
  }

  destroy(): void {
    this._root?.remove();
    this._root = null;
    this._controls.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────────────

  private _ensureRoot(): HTMLDivElement {
    if (this._root) return this._root;
    const div = document.createElement('div');
    div.className = 'salsa-ui-form-overlay';
    div.style.position = 'absolute';
    div.style.pointerEvents = 'none';   // the div passes through; the CONTROLS re-enable events
    div.style.overflow = 'hidden';
    (this._canvas.parentElement ?? document.body).appendChild(div);
    this._root = div;
    return div;
  }

  private _createControl(el: HtmlFormElement): HTMLElement {
    let node: HTMLElement;
    switch (el.type) {
      case 'textarea': {
        const t = document.createElement('textarea');
        if (el.placeholder) t.placeholder = el.placeholder;
        t.addEventListener('input', () => this._onInput(el.id, t.value));
        node = t;
        break;
      }
      case 'select': {
        const s = document.createElement('select');
        for (const opt of el.options ?? []) {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          s.appendChild(o);
        }
        s.addEventListener('change', () => this._onInput(el.id, s.value));
        node = s;
        break;
      }
      case 'radio': {
        // A group of radios inside one positioned container; the element VALUE is the checked option.
        const wrap = document.createElement('div');
        for (const opt of el.options ?? []) {
          const label = document.createElement('label');
          const r = document.createElement('input');
          r.type = 'radio'; r.name = `salsa-radio-${el.id}`; r.value = opt;
          r.addEventListener('change', () => { if (r.checked) this._onInput(el.id, opt); });
          label.appendChild(r); label.appendChild(document.createTextNode(opt));
          wrap.appendChild(label);
        }
        node = wrap;
        break;
      }
      case 'checkbox': {
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.addEventListener('change', () => this._onInput(el.id, c.checked));
        node = c;
        break;
      }
      default: {   // text / password / number / email / tel
        const i = document.createElement('input');
        i.type = el.type;
        if (el.placeholder) i.placeholder = el.placeholder;
        i.addEventListener('input', () => this._onInput(el.id, i.value));
        i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') this._onSubmit(el.formId ?? ''); });
        node = i;
        break;
      }
    }
    node.style.position = 'absolute';
    node.style.pointerEvents = 'auto';
    node.style.boxSizing = 'border-box';
    if (el.label) node.setAttribute('aria-label', el.label);
    if (el.required) node.setAttribute('aria-required', 'true');
    for (const [k, v] of Object.entries(el.style ?? {})) {
      // Spec style keys are camelCase CSS props; numbers mean px (fontSize/borderRadius).
      (node.style as unknown as Record<string, string>)[k] = typeof v === 'number' ? `${v}px` : v;
    }
    this._controls.set(el.id, { el, node });
    return node;
  }
}
