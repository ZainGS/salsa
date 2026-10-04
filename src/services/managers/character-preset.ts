/**
 * character-preset.ts — portable JSON character presets (export / import a whole procedural character's LOOK).
 *
 * v1 (before audit 2026-09-28 C2) exported body + hair + clothing + renderStyle, but import applied ONLY the `top` and
 * `bottom` slots — shoes/socks/undershirt/underpants were silently dropped, slots the preset lacked were never removed,
 * and skin tone, face/eyes and charms were never exported at all. v2 is the complete look, and import REPLACES the
 * character's look with the preset's (it no longer merges onto whatever was there).
 *
 * Kept engine-free behind {@link CharacterPresetHost} (ShapeManager implements it) so it unit-tests without a GPU.
 * Not included: hand-DRAWN face textures (PNG pixels — they ride the full document save, not a JSON preset);
 * procedural (slider) eye expressions ARE included.
 */

import type { ClothingParams } from './clothing-generator';
import type { HairParams } from './hair-generator';
import type { BodyParams } from './body-generator';
import type { EyeParams } from './eye-generator';
import type { FaceFeatureParams } from './face-features';
import type { AttachmentParams, AttachmentPlacement, AttachmentType } from './attachment-generator';
import type { FaceBlinkConfig, FaceExpression } from './scene3d-manager';
import type { RenderStyle } from '../../renderer/3d/material-3d';

export const CLOTHING_SLOTS = ['top', 'bottom', 'shoes', 'socks', 'undershirt', 'underpants'] as const;
export type CharacterClothingSlot = typeof CLOTHING_SLOTS[number];

export const CHARACTER_PRESET_VERSION = 2;

export interface CharacterPresetFace {
  /** Procedural (slider) expressions only, in order. Drawn expressions aren't portable — see file header. */
  expressions: { name: string; isBlink: boolean; eyeParams: EyeParams }[];
  /** Index into `expressions` of the held/active expression, or -1. */
  activeIndex: number;
  /** Index into `expressions` of the blink frame, or -1. */
  blinkIndex: number;
  blink: FaceBlinkConfig;
  /** Face kit params (face-features.ts). Absent in presets made before the kit / for faces without it. */
  features?: FaceFeatureParams | null;
}

export interface CharacterPreset {
  kind: 'salsa-character';
  version: number;
  body: BodyParams | null;
  skinTone?: string | null;
  hair: HairParams | null;
  clothing: Partial<Record<CharacterClothingSlot, ClothingParams>>;
  attachments?: { type: AttachmentType; placement: AttachmentPlacement; params: AttachmentParams }[];
  face?: CharacterPresetFace | null;
  renderStyle?: RenderStyle;
}

/** The slice of ShapeManager a preset needs. */
export interface CharacterPresetHost {
  getBodyParams(bodyId: string): BodyParams | null;
  setBodyParams(bodyId: string, params: BodyParams): Promise<void>;
  getSkinTone(bodyId: string): string | null;
  setSkinTone(bodyId: string, hex: string): void;
  getHairParams(bodyId: string): HairParams | null;
  setHairParams(bodyId: string, params: HairParams): void;
  removeHair(bodyId: string): void;
  getClothingParams(bodyId: string, slot: CharacterClothingSlot): ClothingParams | null;
  setClothingParams(bodyId: string, params: ClothingParams): void;
  removeClothing(bodyId: string, slot: CharacterClothingSlot): void;
  listAttachments(bodyId: string): { id: string; type: AttachmentType; placement: AttachmentPlacement; params: AttachmentParams }[];
  addAttachment(bodyId: string, type: AttachmentType, placement: AttachmentPlacement, params: AttachmentParams): string | null;
  removeAttachment(id: string): void;
  getFaceExpressions(bodyId: string): { expressions: FaceExpression[]; activeId: string | null; blinkId: string | null; blink: FaceBlinkConfig } | null;
  ensureFace(bodyId: string): boolean;
  createFaceExpression(bodyId: string, name: string): string | null;
  deleteFaceExpression(bodyId: string, exprId: string): void;
  setFaceExpressionProcedural(bodyId: string, exprId: string, params: EyeParams): void;
  setActiveFaceExpression(bodyId: string, exprId: string): void;
  setFaceBlinkExpression(bodyId: string, exprId: string | null): void;
  setFaceBlinkConfig(bodyId: string, cfg: Partial<FaceBlinkConfig>): void;
  /** Face kit (optional on the host so older hosts / test doubles still satisfy the interface). */
  getFaceFeatures?(bodyId: string): FaceFeatureParams | null;
  setFaceFeatures?(bodyId: string, params: Partial<FaceFeatureParams>): void;
  getRenderStyle(bodyId: string): RenderStyle;
  setRenderStyle(bodyId: string, style: RenderStyle): void;
}

const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** Snapshot a body's full look as a preset object. */
export function exportCharacterPreset(host: CharacterPresetHost, bodyId: string): CharacterPreset {
  const clothing: CharacterPreset['clothing'] = {};
  for (const slot of CLOTHING_SLOTS) {
    const p = host.getClothingParams(bodyId, slot);
    if (p) clothing[slot] = clone(p);
  }

  let face: CharacterPresetFace | null = null;
  const f = host.getFaceExpressions(bodyId);
  if (f) {
    const procedural = f.expressions.filter((e) => !!e.eyeParams);
    face = {
      expressions: procedural.map((e) => ({ name: e.name, isBlink: e.isBlink, eyeParams: clone(e.eyeParams!) })),
      activeIndex: procedural.findIndex((e) => e.id === f.activeId),
      blinkIndex: procedural.findIndex((e) => e.id === f.blinkId),
      blink: clone(f.blink),
      features: clone(host.getFaceFeatures?.(bodyId) ?? null),
    };
  }

  return {
    kind: 'salsa-character',
    version: CHARACTER_PRESET_VERSION,
    body: clone(host.getBodyParams(bodyId)),
    skinTone: host.getSkinTone(bodyId),
    hair: clone(host.getHairParams(bodyId)),
    clothing,
    attachments: host.listAttachments(bodyId).map((a) => ({ type: a.type, placement: clone(a.placement), params: clone(a.params) })),
    face,
    renderStyle: host.getRenderStyle(bodyId),
  };
}

/** Parse + validate a preset (string or object). Throws a readable error on anything that isn't one. */
export function parseCharacterPreset(preset: string | object): CharacterPreset {
  let data: unknown;
  try { data = typeof preset === 'string' ? JSON.parse(preset) : preset; }
  catch { throw new Error('importCharacter3D: invalid JSON'); }
  const d = data as Partial<CharacterPreset> | null;
  if (!d || d.kind !== 'salsa-character') throw new Error('importCharacter3D: not a salsa-character preset');
  if (typeof d.version === 'number' && d.version > CHARACTER_PRESET_VERSION) {
    throw new Error(`importCharacter3D: preset version ${d.version} is newer than this build (${CHARACTER_PRESET_VERSION})`);
  }
  return d as CharacterPreset;
}

/**
 * Apply a preset to a body, REPLACING its look. Order: body first (it regenerates + re-fits overlays), then skin,
 * hair, every clothing slot (applied or removed), charms, face, render style.
 *
 * Sections a v1 preset never carried (skin tone, attachments, face) are LEFT AS-IS when absent, so importing an old
 * preset doesn't wipe a character's charms or eyes. Present-but-empty sections do replace (an empty attachment list
 * removes all charms; `face: null` leaves the face alone — there's nothing portable to apply).
 */
export async function applyCharacterPreset(host: CharacterPresetHost, bodyId: string, preset: string | object): Promise<void> {
  const p = parseCharacterPreset(preset);

  if (p.body) await host.setBodyParams(bodyId, clone(p.body));
  if (typeof p.skinTone === 'string') host.setSkinTone(bodyId, p.skinTone);

  if (p.hair) host.setHairParams(bodyId, clone(p.hair));
  else if ('hair' in p) host.removeHair(bodyId);                 // explicit null = bald

  if (p.clothing && typeof p.clothing === 'object') {
    for (const slot of CLOTHING_SLOTS) {
      const params = p.clothing[slot];
      if (params) host.setClothingParams(bodyId, { ...clone(params), slot } as ClothingParams);
      else if (host.getClothingParams(bodyId, slot)) host.removeClothing(bodyId, slot);
    }
  }

  if (Array.isArray(p.attachments)) {
    for (const a of host.listAttachments(bodyId)) host.removeAttachment(a.id);
    for (const a of p.attachments) host.addAttachment(bodyId, a.type, clone(a.placement), clone(a.params));
  }

  if (p.face && Array.isArray(p.face.expressions) && p.face.expressions.length) {
    host.ensureFace(bodyId);
    for (const e of host.getFaceExpressions(bodyId)?.expressions ?? []) host.deleteFaceExpression(bodyId, e.id);
    const ids = p.face.expressions.map((e) => {
      const id = host.createFaceExpression(bodyId, e.name);
      if (id) host.setFaceExpressionProcedural(bodyId, id, clone(e.eyeParams));
      return id;
    });
    const active = ids[p.face.activeIndex];
    if (active) host.setActiveFaceExpression(bodyId, active);
    host.setFaceBlinkExpression(bodyId, ids[p.face.blinkIndex] ?? null);
    if (p.face.blink) host.setFaceBlinkConfig(bodyId, clone(p.face.blink));
  }
  // Face kit: a preset that carries it applies it (even with drawn eyes); one without leaves the kit as-is.
  if (p.face?.features && host.setFaceFeatures) host.setFaceFeatures(bodyId, clone(p.face.features));

  if (p.renderStyle) host.setRenderStyle(bodyId, p.renderStyle);
}
