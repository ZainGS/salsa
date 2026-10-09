/**
 * ShellUIManager × FrogCart disc art (docs/specs/frogcart-cd-art-and-launch.md Part B): install stores the cart's disc
 * art + pattern seed on its slot, the one-time idle backfill fills carts installed before, the tiles carry their
 * pattern, the Demo cart is gone, and the top viewer shows the HOVERED (else selected) cart's CD.
 * Runs against fakes: no GPU, no OPFS (the art → data URL step is stubbed: it needs a browser canvas).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./shell-cart-art', async (importActual) => {
  const actual = await importActual<typeof import('./shell-cart-art')>();
  return { ...actual, cartArtToThumbDataUrl: vi.fn(async (b: Blob) => `data:${b.type};base64,QUJD`) };
});

import { ShellUIManager } from './shell-ui-manager';
import { packFrogcart } from '../persistence/frogcart';
import { cartDiscSeedFromId } from '../../renderer/3d/cd-disc/cart-disc-pattern';
import type { ManagerContext } from './manager-context';
import type { ShellSlot } from '../persistence/shell-storage';
import type { ShellTileSpec, ViewerSpec } from '../../renderer/shell/shell-layout';

type Internals = {
  registry: { version: 2; slots: ShellSlot[] };
  storage: Record<string, unknown>;
  renderer: unknown;
  view: { mode: string; hoveredSlotId: string | null; selectedSlotId: string | null };
  currentModel: { tiles: { id: string; cd?: boolean }[] };
  installLocalCart(f: File): Promise<void>;
  buildSpecs(): ShellTileSpec[];
  buildViewerSpec(): ViewerSpec;
  viewerCartId(): string | null;
  scheduleCartArtBackfill(): void;
};

const scene = () => new Blob([new Uint8Array([80, 75, 3, 4])], { type: 'application/zip' });
async function cartBytes(meta: Parameters<typeof packFrogcart>[0]['meta'], sceneId = 'cart-1'): Promise<ArrayBuffer> {
  return (await packFrogcart({ scenePackage: scene(), meta, stateMachineJSON: null, sceneId })).arrayBuffer();
}

function manager(slots: ShellSlot[] = []) {
  const ctx = { webgpuRenderer: { resumeRendering: vi.fn(), play: vi.fn(), getDevice: () => null } } as unknown as ManagerContext;
  const m = new ShellUIManager(ctx);
  const mi = m as unknown as Internals;
  mi.registry = { version: 2, slots };
  const files = new Map<string, ArrayBuffer>();
  mi.storage = {
    writeLocalCart: async (id: string, data: ArrayBuffer) => { files.set(id, data); return `/carts/${id}.frogcart`; },
    readLocalCart: async (id: string) => files.get(id) ?? null,
    readCachedCart: async (id: string) => files.get(id) ?? null,
    saveRegistry: vi.fn(async () => {}),
    deleteCartBinaries: vi.fn(async () => {}),
  };
  return { m, mi, files };
}

beforeEach(() => { vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({}) } }); });   // ShellStorage.isAvailable()
afterEach(() => { vi.unstubAllGlobals(); });

describe('install → the slot carries its disc', () => {
  it('a 1.1 cart: thumbnailDataUrl = its disc art, cdPattern = its seed, artChecked', async () => {
    const { mi } = manager();
    const bytes = await cartBytes({ title: 'Night Market', cdArt: new Blob([new Uint8Array([1, 2])], { type: 'image/webp' }), cdPattern: { seed: 42 } });
    await mi.installLocalCart(new File([bytes], 'night.frogcart'));
    const s = mi.registry.slots[0];
    expect(s.name).toBe('Night Market');
    expect(s.thumbnailDataUrl).toBe('data:image/webp;base64,QUJD');
    expect(s.cdPattern).toEqual({ seed: 42 });
    expect(s.artChecked).toBe(true);
  });

  it('a cart with no art: no thumbnail (the disc prints its pattern: from the sceneId when none is stored)', async () => {
    const { mi } = manager();
    await mi.installLocalCart(new File([await cartBytes({ title: 'Plain' }, 'cart-plain')], 'plain.frogcart'));
    const s = mi.registry.slots[0];
    expect(s.thumbnailDataUrl).toBeUndefined();
    expect(s.cdPattern).toEqual({ seed: cartDiscSeedFromId('cart-plain') });
  });
});

describe('the one-time idle backfill', () => {
  it('reads every unchecked cart once and stores its art + seed', async () => {
    const { mi, files } = manager([
      { id: 'old1', type: 'local', name: 'Old', order: 3, opfsPath: '/carts/old1.frogcart' },
      { id: 'done', type: 'local', name: 'Done', order: 4, artChecked: true },
    ]);
    files.set('old1', await cartBytes({ title: 'Old', cdArt: new Blob([new Uint8Array([3])], { type: 'image/png' }), cdPattern: { seed: 7, family: 'dots' } }));
    mi.renderer = { mountAgeMs: 10_000 };   // mounted + calm
    mi.scheduleCartArtBackfill();
    await vi.waitFor(() => expect(mi.registry.slots[0].artChecked).toBe(true));
    expect(mi.registry.slots[0].thumbnailDataUrl).toBe('data:image/png;base64,QUJD');
    expect(mi.registry.slots[0].cdPattern).toEqual({ seed: 7, family: 'dots' });
    expect(mi.registry.slots[1].thumbnailDataUrl).toBeUndefined();   // already checked: untouched
  });
});

describe('tiles + the top viewer', () => {
  const slots = (): ShellSlot[] => [
    { id: 'c1', type: 'local', name: 'One', order: 3, cdPattern: { seed: 11 } },
    { id: 'c2', type: 'local', name: 'Two', order: 4 },
  ];

  it('cart tiles are CDs with their pattern; there is no Demo cart', () => {
    const { mi } = manager(slots());
    mi.view.mode = 'shell';
    const specs = mi.buildSpecs();
    expect(specs.find(s => s.id === '__demo_cart__')).toBeUndefined();
    expect(specs.find(s => s.id === 'c1')).toMatchObject({ cd: true, cdPattern: { seed: 11 } });
    expect(specs.find(s => s.id === 'c2')).toMatchObject({ cd: true, cdPattern: { seed: cartDiscSeedFromId('c2') } });
    expect(specs.filter(s => s.kind === 'system').every(s => !s.cdPattern)).toBe(true);
  });

  it('the viewer shows the HOVERED cart (not the selected one); with no hover, the selected cart as a CD', () => {
    const { mi } = manager(slots());
    mi.view.mode = 'shell';
    mi.currentModel = { tiles: [{ id: 'c1', cd: true }, { id: 'c2', cd: true }] } as never;
    mi.view.selectedSlotId = 'c1';
    mi.view.hoveredSlotId = 'c2';
    expect(mi.viewerCartId()).toBe('c2');
    expect(mi.buildViewerSpec()).toMatchObject({ kind: 'cd', cdPattern: { seed: cartDiscSeedFromId('c2') } });
    mi.view.hoveredSlotId = null;
    expect(mi.viewerCartId()).toBe('c1');
    expect(mi.buildViewerSpec()).toMatchObject({ kind: 'cd', cdPattern: { seed: 11 } });   // not the cartridge slab
    mi.view.selectedSlotId = null;
    expect(mi.viewerCartId()).toBeNull();
    expect(mi.buildViewerSpec().kind).not.toBe('cd');
  });
});
