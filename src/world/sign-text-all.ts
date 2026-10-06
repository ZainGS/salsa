// ── Every TEXT sign plate of a city graph, in one list ──────────────────────────────────────────────────────────
// The 'World Sign Text' group: landmark / shop / shotengai plates (signtext.ts computeTextSigns), the signal street-name
// plates + STOP lettering (signals.ts computeSignalTextSigns) and the regulatory road-sign plates (road-sign.ts). ONE
// definition for the centre city (WorldManager._addTextSigns, main thread) and every streamed full tile (tile-build.ts,
// in the worker), so a tile's STOP signs / street names / NO PARKING plates are lettered like the centre's.
//
// The label rides ON the layer (`signText`, a plain field: it survives the worker's structured clone), and the main
// thread textures each mesh by its LAYER NAME (unique within a group), never by child index.

import type { WorldGraph, LayoutPreviewLayer } from './types';
import { computeTextSigns, type TextSignSpec } from './signtext';
import { computeSignalTextSigns } from './signals';
import { buildRoadSigns } from './road-sign';

/** What the rasterizer needs from a sign plate: its label, the square-canvas flag and the plate colour. */
export interface SignTextInfo { label: string; square?: boolean; color: [number, number, number] }
export type SignTextLayer = LayoutPreviewLayer & { signText?: SignTextInfo };

/** The text-sign group's name suffix (centre: exactly this; a tile: `World Tile x_z World Sign Text`). */
export const SIGN_TEXT_GROUP = 'World Sign Text';

/** Every text-sign spec of `graph` (`keep` = the region filter of the signal / road-sign builders, as their supports). */
export function cityTextSigns(graph: WorldGraph, keep?: ((region: number) => boolean) | null): TextSignSpec[] {
    return [...computeTextSigns(graph), ...computeSignalTextSigns(graph, keep), ...buildRoadSigns(graph, keep).textSigns];
}

/** The specs' layers, each carrying its label (`signText`) — what the 'World Sign Text' group is built from. */
export function signTextLayers(specs: readonly TextSignSpec[]): SignTextLayer[] {
    return specs.map(sp => {
        const L = sp.layer as SignTextLayer;
        L.signText = { label: sp.label, square: sp.square, color: sp.layer.color };
        return L;
    });
}

/** Layer name → label info for a group's layers (only the ones that carry a label). */
export function signTextByName(layers: readonly LayoutPreviewLayer[]): Map<string, SignTextInfo> {
    const out = new Map<string, SignTextInfo>();
    for (const L of layers as readonly SignTextLayer[]) if (L.signText) out.set(L.name, L.signText);
    return out;
}

/** The bitmap cache key of a plate (label + colour + canvas shape) — the same plate rasterizes once per session. */
export function signBitmapKey(s: SignTextInfo): string {
    return s.label + '|' + s.color.map(c => c.toFixed(3)).join(',') + (s.square ? '|sq' : '');
}
