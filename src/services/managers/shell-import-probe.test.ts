import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { packFrogcart } from '../persistence/frogcart';
import { probeFrogcart, FROGCART_MAX_MAJOR } from './shell-import';

const scene = () => new Blob([zipSync({ 'manifest.json': strToU8('{}') }) as unknown as BlobPart]);
const zip = (files: Record<string, Uint8Array>) => zipSync(files);
const json = (o: unknown) => strToU8(JSON.stringify(o));

describe('probeFrogcart', () => {
  it('a cart packFrogcart wrote passes, with its title / author / description', async () => {
    const blob = await packFrogcart({
      scenePackage: scene(), meta: { title: ' Night Market ', author: 'Zain', description: 'A stroll' }, stateMachineJSON: null,
    });
    const r = probeFrogcart(new Uint8Array(await blob.arrayBuffer()));
    expect(r).toMatchObject({ ok: true, title: 'Night Market', author: 'Zain', description: 'A stroll' });
    expect(r.ok && r.version.startsWith('1.')).toBe(true);
  });

  it('a 1.x cart (e.g. one with CD art) still plays; an older manifest without a version counts as 1.0', () => {
    const s = new Uint8Array([1, 2, 3]);
    expect(probeFrogcart(zip({ 'manifest.json': json({ version: '1.1', title: 'Art' }), 'scene.salsa': s, 'cd-art.png': s })))
      .toMatchObject({ ok: true, title: 'Art', version: '1.1' });
    expect(probeFrogcart(zip({ 'manifest.json': json({ name: 'Old' }), 'scene.salsa': s })))
      .toEqual({ ok: true, title: 'Old', author: '', description: '', version: '1.0' });
  });

  it('a newer major version is too new', () => {
    const s = new Uint8Array([1]);
    expect(probeFrogcart(zip({ 'manifest.json': json({ version: `${FROGCART_MAX_MAJOR + 1}.0` }), 'scene.salsa': s })))
      .toEqual({ ok: false, reason: 'too-new' });
  });

  it('rejects what is not a cart', () => {
    const s = new Uint8Array([1]);
    expect(probeFrogcart(strToU8('not a zip'))).toEqual({ ok: false, reason: 'not-a-cart' });
    expect(probeFrogcart(new Uint8Array(0))).toEqual({ ok: false, reason: 'not-a-cart' });
    expect(probeFrogcart(zip({ 'scene.salsa': s }))).toEqual({ ok: false, reason: 'missing-manifest' });
    expect(probeFrogcart(zip({ 'manifest.json': json({ title: 'x' }) }))).toEqual({ ok: false, reason: 'missing-scene' });
    expect(probeFrogcart(zip({ 'manifest.json': json({}), 'scene.salsa': new Uint8Array(0) }))).toEqual({ ok: false, reason: 'missing-scene' });
    expect(probeFrogcart(zip({ 'manifest.json': strToU8('{oops'), 'scene.salsa': s }))).toEqual({ ok: false, reason: 'bad-manifest' });
    expect(probeFrogcart(zip({ 'manifest.json': json([1, 2]), 'scene.salsa': s }))).toEqual({ ok: false, reason: 'bad-manifest' });
    expect(probeFrogcart(zip({ 'manifest.json': strToU8('null'), 'scene.salsa': s }))).toEqual({ ok: false, reason: 'bad-manifest' });
    // a .frogmarks project (its own manifest, no scene.salsa) is not a cart
    expect(probeFrogcart(zip({ 'manifest.json': json({ docId: 'a', layers: [] }), 'scene3d.json': s }))).toEqual({ ok: false, reason: 'missing-scene' });
  });

  it('inflates only the manifest — a scene.salsa whose compressed data is garbage still probes fine', () => {
    const bytes = zipSync({ 'manifest.json': json({ title: 'Big' }), 'scene.salsa': [new Uint8Array(4096).fill(7), { level: 9 }] });
    // corrupt the scene's deflate stream (local header: 30 bytes + name + extra, then the data)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let o = 0; o + 30 < bytes.length; o++) {
      if (dv.getUint32(o, true) !== 0x04034b50) continue;
      const nameLen = dv.getUint16(o + 26, true), extraLen = dv.getUint16(o + 28, true);
      if (new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + nameLen)) !== 'scene.salsa') continue;
      const at = o + 30 + nameLen + extraLen;
      bytes.fill(0xff, at, at + dv.getUint32(o + 18, true));
    }
    expect(() => unzipSync(bytes)).toThrow();   // inflating it WOULD fail
    expect(probeFrogcart(bytes)).toMatchObject({ ok: true, title: 'Big' });
  });
});
