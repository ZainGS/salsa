import { describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { packFrogcart } from '../persistence/frogcart';
import {
  openShellImportPicker, readCartListing, shellCartFilesToInstall, SHELL_CART_ACCEPT, SHELL_IMPORT_ACCEPT,
} from './shell-import';

const file = (name: string, bytes: Uint8Array | string = 'x') =>
  new File([typeof bytes === 'string' ? bytes : (bytes as unknown as BlobPart)], name);

/** A minimal stand-in for the hidden <input type=file> the picker creates. */
function fakeDoc() {
  const listeners: Record<string, () => void> = {};
  const input = {
    type: '', accept: '', multiple: false, style: {} as Record<string, string>, files: null as File[] | null,
    clicked: false, removed: false,
    addEventListener(type: string, fn: () => void) { listeners[type] = fn; },
    remove() { this.removed = true; },
    click() { this.clicked = true; },
  };
  const body = { appended: [] as unknown[], appendChild(el: unknown) { this.appended.push(el); return el; } };
  const doc = { createElement: () => input, body } as unknown as Pick<Document, 'createElement' | 'body'>;
  return { doc, input, body, fire: (type: string) => listeners[type]?.() };
}

describe('Shell Import picker', () => {
  it('opens a hidden picker with the given filter and hands over the chosen files', () => {
    const { doc, input, body, fire } = fakeDoc();
    const got = vi.fn();
    openShellImportPicker(doc, { accept: SHELL_IMPORT_ACCEPT, multiple: true }, got);
    expect(input.type).toBe('file');
    expect(input.accept).toBe(SHELL_IMPORT_ACCEPT);
    expect(input.multiple).toBe(true);
    expect(body.appended).toEqual([input]);
    expect(input.clicked).toBe(true);
    const a = file('a.frogcart'), b = file('b.frogmarks');
    input.files = [a, b];
    fire('change');
    expect(got).toHaveBeenCalledWith([a, b]);
    expect(input.removed).toBe(true);
  });

  it('a single-file picker passes one file; a dismissed picker passes none and removes the input', () => {
    const one = fakeDoc();
    const got = vi.fn();
    openShellImportPicker(one.doc, { accept: SHELL_CART_ACCEPT, multiple: false }, got);
    one.input.files = [file('a.frogcart'), file('b.frogcart')];
    one.fire('change');
    expect(got.mock.calls[0][0]).toHaveLength(1);

    const cancelled = fakeDoc();
    const none = vi.fn();
    openShellImportPicker(cancelled.doc, { accept: SHELL_CART_ACCEPT, multiple: false }, none);
    cancelled.fire('cancel');
    expect(cancelled.input.removed).toBe(true);
    expect(none).not.toHaveBeenCalled();
  });

  it('the routed filter takes carts, projects and a zipped / renamed copy; the plain one carts only', () => {
    for (const ext of ['.frogcart', '.frogmarks', '.frog', '.zip']) expect(SHELL_IMPORT_ACCEPT.split(',')).toContain(ext);
    expect(SHELL_CART_ACCEPT).toBe('.frogcart');
  });
});

describe('Shell Import routing (host handler)', () => {
  it('with no handler every picked file is a cart (the old behaviour)', async () => {
    const files = [file('a.frogcart')];
    expect(await shellCartFilesToInstall(files, null)).toEqual(files);
  });

  it('installs only the files the host returned as carts', async () => {
    const cart = file('a.frogcart'), project = file('b.frogmarks');
    const handler = vi.fn(async (fs: File[]) => fs.filter(f => f === cart));
    expect(await shellCartFilesToInstall([cart, project], handler)).toEqual([cart]);
    expect(handler).toHaveBeenCalledWith([cart, project]);
  });

  it('ignores files the host returns that were not picked, and a throwing / bad handler installs nothing', async () => {
    const a = file('a.frogcart');
    expect(await shellCartFilesToInstall([a], () => [a, file('other.frogcart')])).toEqual([a]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await shellCartFilesToInstall([a], () => { throw new Error('boom'); })).toEqual([]);
    warn.mockRestore();
    expect(await shellCartFilesToInstall([a], () => undefined as unknown as File[])).toEqual([]);
  });
});

describe('Shell cart listing (tile name)', () => {
  it('reads the title + description packFrogcart writes', async () => {
    const blob = await packFrogcart({
      scenePackage: new Blob([zipSync({ 'manifest.json': strToU8('{}') }) as unknown as BlobPart]),
      meta: { title: 'Night Market', description: 'A stroll' },
      stateMachineJSON: null,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(readCartListing(bytes, 'renamed.zip')).toEqual({ name: 'Night Market', description: 'A stroll' });
  });

  it('falls back to a manifest `name`, then the file name', () => {
    const named = zipSync({ 'manifest.json': strToU8(JSON.stringify({ name: 'Old Cart' })) });
    expect(readCartListing(named, 'x.frogcart').name).toBe('Old Cart');
    const bare = zipSync({ 'scene.salsa': new Uint8Array([1]) });
    expect(readCartListing(bare, 'My Cart.frogcart')).toEqual({ name: 'My Cart', description: undefined });
    expect(readCartListing(strToU8('not a zip'), '.frogcart').name).toBe('Cart');
  });
});
