/**
 * The Shell's Import tile: the file picker, the host's routing hook and the cart name read.
 *
 * Without a host handler the tile is what it always was: a .frogcart-only picker, one file, installed as a cart.
 * With one (ShellUIManager.setImportHandler) the picker takes several files of any Frogmarks kind (renamed ones too)
 * and hands them all to the host, which takes what it can open itself (a project file) and returns the ones that are
 * carts; the Shell installs those.
 */

import { unzipSync, strFromU8 } from 'fflate';

/** The host routes the picked files and returns the ones the Shell should install as carts (the rest it handled,
 *  or rejected with its own message). Runs after the picker closed (no user gesture). */
export type ShellImportHandler = (files: File[]) => File[] | Promise<File[]>;

/** Picker filter with no host handler: carts only (as before). */
export const SHELL_CART_ACCEPT = '.frogcart';
/** Picker filter with a host handler: carts, projects and a renamed / zipped copy of either. */
export const SHELL_IMPORT_ACCEPT = '.frogcart,.frogmarks,.frog,.zip,application/zip';

/** Open the OS file picker. Must run inside the user gesture (a click / key handler). `onFiles` gets the chosen
 *  files (never called for a dismissed picker). */
export function openShellImportPicker(
  doc: Pick<Document, 'createElement' | 'body'> | undefined,
  opts: { accept: string; multiple: boolean },
  onFiles: (files: File[]) => void,
): void {
  if (!doc) return;
  const input = doc.createElement('input');
  input.type = 'file';
  input.accept = opts.accept;
  input.multiple = opts.multiple;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    if (files.length) onFiles(opts.multiple ? files : files.slice(0, 1));
  }, { once: true });
  // Dismissing the picker fires `cancel` (not `change`) in modern browsers → the hidden input would otherwise
  // stay appended to <body> and accumulate on every cancelled import. Remove it on cancel too.
  input.addEventListener('cancel', () => input.remove(), { once: true });
  doc.body.appendChild(input);
  input.click();
}

/** The files to install as carts: all of them with no handler, else the ones the handler returned (only files that
 *  were picked; a throwing handler installs nothing). */
export async function shellCartFilesToInstall(files: File[], handler: ShellImportHandler | null): Promise<File[]> {
  if (!handler) return files;
  try {
    const carts = await handler(files);
    return Array.isArray(carts) ? carts.filter(f => files.includes(f)) : [];
  } catch (e) {
    console.warn('[Shell] import handler failed:', e);
    return [];
  }
}

/** A cart's tile name + description: the .frogcart manifest's `title` (packFrogcart), else `name`, else the file
 *  name. A file that is not a zip / has no manifest keeps the file name. */
export function readCartListing(bytes: Uint8Array, fileName: string): { name: string; description?: string } {
  let name = fileName.replace(/\.(frogcart|zip)$/i, '').trim() || 'Cart';
  let description: string | undefined;
  try {
    const mf = unzipSync(bytes, { filter: f => f.name === 'manifest.json' })['manifest.json'];
    if (mf) {
      const m = JSON.parse(strFromU8(mf)) as { title?: unknown; name?: unknown; description?: unknown };
      const title = typeof m.title === 'string' && m.title.trim() ? m.title.trim()
        : typeof m.name === 'string' && m.name.trim() ? m.name.trim() : null;
      if (title) name = title;
      if (typeof m.description === 'string' && m.description) description = m.description;
    }
  } catch { /* not a valid zip / no manifest → keep the filename */ }
  return { name, description };
}

/** The newest .frogcart manifest MAJOR version this build can play ('1.0', '1.1' … play; '2.0' is too new). */
export const FROGCART_MAX_MAJOR = 1;

/** probeFrogcart's verdict on a cart's bytes. */
export type FrogcartProbe =
  | { ok: true; title: string; author: string; description: string; version: string }
  | { ok: false; reason: 'not-a-cart' | 'missing-manifest' | 'missing-scene' | 'bad-manifest' | 'too-new' };

/**
 * A cheap "will this cart load?" check before the Shell hands a cart to the Player (the launch flow): the bytes are a
 * zip with a parseable manifest.json and a non-empty scene.salsa, and the manifest's major version is one this build
 * plays. Only the manifest is inflated — scene.salsa (the whole project, often MBs) is seen by its directory entry,
 * never decompressed. Never throws. Title / author / description come from the manifest ('' when absent).
 */
export function probeFrogcart(bytes: Uint8Array): FrogcartProbe {
  let scene = false;
  let manifestBytes: Uint8Array | undefined;
  try {
    manifestBytes = unzipSync(bytes, {
      filter: (f) => {
        if (f.name === 'scene.salsa') { scene = f.originalSize > 0; return false; }
        return f.name === 'manifest.json';
      },
    })['manifest.json'];
  } catch {
    return { ok: false, reason: 'not-a-cart' };
  }
  if (!manifestBytes) return { ok: false, reason: 'missing-manifest' };
  if (!scene) return { ok: false, reason: 'missing-scene' };
  let m: { version?: unknown; title?: unknown; name?: unknown; author?: unknown; description?: unknown };
  try {
    const parsed: unknown = JSON.parse(strFromU8(manifestBytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'bad-manifest' };
    m = parsed as typeof m;
  } catch {
    return { ok: false, reason: 'bad-manifest' };
  }
  const version = typeof m.version === 'string' ? m.version : '1.0';
  const major = Number.parseInt(version, 10);
  if (Number.isFinite(major) && major > FROGCART_MAX_MAJOR) return { ok: false, reason: 'too-new' };
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    ok: true,
    title: str(m.title) || str(m.name),
    author: str(m.author),
    description: str(m.description),
    version,
  };
}
