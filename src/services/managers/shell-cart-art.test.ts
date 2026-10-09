/**
 * shell-cart-art: what an installed cart's Shell disc prints — read from the .frogcart (art + pattern seed).
 */
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readCartArt, slotDiscPattern } from './shell-cart-art';
import { packFrogcart } from '../persistence/frogcart';
import { cartDiscSeedFromId } from '../../renderer/3d/cd-disc/cart-disc-pattern';

const scene = () => new Blob([new Uint8Array([80, 75, 3, 4, 1])], { type: 'application/zip' });
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const cartWith = (manifest: Record<string, unknown>, extra: Record<string, Uint8Array> = {}) =>
  zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'scene.salsa': new Uint8Array([80, 75, 3, 4]), ...extra });

describe('readCartArt', () => {
  it('a 1.1 cart: the cd-art entry + the stored pattern seed', async () => {
    const art = new Uint8Array([9, 8, 7, 6]);
    const cart = await packFrogcart({ scenePackage: scene(), stateMachineJSON: null, sceneId: 'cart-x',
      meta: { title: 'A', cdArt: new Blob([art], { type: 'image/png' }), cdPattern: { seed: 77, family: 'stripes' } } });
    const r = readCartArt(await bytesOf(cart));
    expect(r.sceneId).toBe('cart-x');
    expect(r.pattern).toEqual({ seed: 77, family: 'stripes' });
    expect(r.art?.type).toBe('image/png');
    expect([...await bytesOf(r.art!)]).toEqual([...art]);
  });

  it('order: cd-art first, else an explicit manifest.thumbnail data URL, else none (the pattern)', async () => {
    const png1px = 'data:image/png;base64,' + Buffer.from([1, 2, 3]).toString('base64');
    const both = cartWith({ sceneId: 's', cdArt: { file: 'cd-art.webp', mime: 'image/webp', sizePx: 512 }, thumbnail: png1px }, { 'cd-art.webp': new Uint8Array([5]) });
    expect(readCartArt(both).art?.type).toBe('image/webp');
    const thumbOnly = cartWith({ sceneId: 's', thumbnail: png1px });
    const t = readCartArt(thumbOnly);
    expect(t.art?.type).toBe('image/png');
    expect([...await bytesOf(t.art!)]).toEqual([1, 2, 3]);
    const none = readCartArt(cartWith({ sceneId: 's', thumbnail: null }));
    expect(none.art).toBeNull();
    expect(readCartArt(cartWith({ sceneId: 's', thumbnail: 'https://example.com/x.png' })).art).toBeNull();   // not embedded → ignored
  });

  it('an old cart (no cdPattern) gets a pattern from its sceneId; the nested scene thumbnail is NOT used', () => {
    const r = readCartArt(cartWith({ version: '1.0', sceneId: 'cart-old', thumbnail: null }));
    expect(r.pattern).toEqual({ seed: cartDiscSeedFromId('cart-old') });
    expect(r.art).toBeNull();
  });

  it('broken bytes / no manifest → nothing, never throws', () => {
    expect(readCartArt(new Uint8Array([1, 2, 3]))).toEqual({ art: null, pattern: null });
    expect(readCartArt(zipSync({ 'scene.salsa': new Uint8Array([1]) }))).toEqual({ art: null, pattern: null });
    expect(readCartArt(zipSync({ 'manifest.json': strToU8('{not json') }))).toEqual({ art: null, pattern: null });
  });

  it('a manifest pointing at a missing art entry → no art', () => {
    expect(readCartArt(cartWith({ sceneId: 's', cdArt: { file: 'cd-art.png', mime: 'image/png', sizePx: 512 } })).art).toBeNull();
  });
});

describe('slotDiscPattern', () => {
  it('the stored seed, else a stable hash of the slot id', () => {
    expect(slotDiscPattern({ id: 'a', cdPattern: { seed: 5, family: 'dots' } })).toEqual({ seed: 5, family: 'dots' });
    expect(slotDiscPattern({ id: 'slot-1' })).toEqual({ seed: cartDiscSeedFromId('slot-1') });
    expect(slotDiscPattern({ id: 'slot-1', cdPattern: { seed: 'bad' } })).toEqual({ seed: cartDiscSeedFromId('slot-1') });
  });
});
