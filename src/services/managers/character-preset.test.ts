import { describe, it, expect } from 'vitest';
import {
  exportCharacterPreset, applyCharacterPreset, parseCharacterPreset, CLOTHING_SLOTS, CHARACTER_PRESET_VERSION,
  type CharacterPresetHost, type CharacterClothingSlot,
} from './character-preset';

/** An in-memory character: just enough state to observe what export/import do. */
function fakeCharacter() {
  const s = {
    body: { height: 1.6 } as any,
    skin: '#f0c8a0' as string | null,
    hair: { style: 'bob' } as any,
    clothing: new Map<CharacterClothingSlot, any>(),
    attachments: new Map<string, any>(),
    face: null as null | { expressions: any[]; activeId: string | null; blinkId: string | null; blink: any },
    style: 'default' as any,
    nextId: 1,
  };
  const host: CharacterPresetHost = {
    getBodyParams: () => s.body,
    setBodyParams: async (_id, p) => { s.body = p; },
    getSkinTone: () => s.skin,
    setSkinTone: (_id, hex) => { s.skin = hex; },
    getHairParams: () => s.hair,
    setHairParams: (_id, p) => { s.hair = p; },
    removeHair: () => { s.hair = null; },
    getClothingParams: (_id, slot) => s.clothing.get(slot) ?? null,
    setClothingParams: (_id, p) => { s.clothing.set(p.slot as CharacterClothingSlot, p); },
    removeClothing: (_id, slot) => { s.clothing.delete(slot); },
    listAttachments: () => [...s.attachments.entries()].map(([id, a]) => ({ id, ...a })),
    addAttachment: (_id, type, placement, params) => { const id = `a${s.nextId++}`; s.attachments.set(id, { type, placement, params }); return id; },
    removeAttachment: (id) => { s.attachments.delete(id); },
    getFaceExpressions: () => (s.face ? { ...s.face, expressions: s.face.expressions.map((e) => ({ ...e })) } : null),
    ensureFace: () => { s.face ??= { expressions: [], activeId: null, blinkId: null, blink: { mode: 'random', minSec: 2, maxSec: 6, holdMs: 110 } }; return true; },
    createFaceExpression: (_id, name) => { const id = `e${s.nextId++}`; s.face!.expressions.push({ id, name, isBlink: false }); return id; },
    deleteFaceExpression: (_id, eid) => { s.face!.expressions = s.face!.expressions.filter((e) => e.id !== eid); },
    setFaceExpressionProcedural: (_id, eid, params) => { const e = s.face!.expressions.find((x) => x.id === eid); if (e) e.eyeParams = params; },
    setActiveFaceExpression: (_id, eid) => { s.face!.activeId = eid; },
    setFaceBlinkExpression: (_id, eid) => { s.face!.blinkId = eid; },
    setFaceBlinkConfig: (_id, cfg) => { s.face!.blink = { ...s.face!.blink, ...cfg }; },
    getRenderStyle: () => s.style,
    setRenderStyle: (_id, st) => { s.style = st; },
  };
  return { s, host };
}

function dressFully(c: ReturnType<typeof fakeCharacter>) {
  for (const slot of CLOTHING_SLOTS) c.s.clothing.set(slot, { slot, color: `c-${slot}` });
  c.host.addAttachment('b', 'pendant', { joint: 'neck' } as any, { type: 'pendant', size: 2 } as any);
  c.host.ensureFace('b');
  const smile = c.host.createFaceExpression('b', 'Smile')!;
  c.host.setFaceExpressionProcedural('b', smile, { irisColor: '#9b6fb0' } as any);
  const blink = c.host.createFaceExpression('b', 'Blink')!;
  c.host.setFaceExpressionProcedural('b', blink, { closed: true } as any);
  c.host.createFaceExpression('b', 'Hand-drawn');                 // no eyeParams → not portable
  c.host.setActiveFaceExpression('b', smile);
  c.host.setFaceBlinkExpression('b', blink);
  c.s.style = 'cel';
}

describe('character presets (audit 2026-09-28 C2)', () => {
  it('export captures the COMPLETE look: every clothing slot, skin tone, charms, procedural eyes, render style', () => {
    const c = fakeCharacter();
    dressFully(c);
    const p = exportCharacterPreset(c.host, 'b');
    expect(p.version).toBe(CHARACTER_PRESET_VERSION);
    expect(Object.keys(p.clothing).sort()).toEqual([...CLOTHING_SLOTS].sort());
    expect(p.skinTone).toBe('#f0c8a0');
    expect(p.attachments).toEqual([{ type: 'pendant', placement: { joint: 'neck' }, params: { type: 'pendant', size: 2 } }]);
    expect(p.face!.expressions.map((e) => e.name)).toEqual(['Smile', 'Blink']);   // the drawn one is skipped
    expect(p.face!.activeIndex).toBe(0);
    expect(p.face!.blinkIndex).toBe(1);
    expect(p.renderStyle).toBe('cel');
  });

  it('export → import onto a bare body reproduces the look (all 6 slots — v1 applied only top/bottom)', async () => {
    const src = fakeCharacter();
    dressFully(src);
    const json = JSON.stringify(exportCharacterPreset(src.host, 'b'));

    const dst = fakeCharacter();
    dst.s.skin = '#333333'; dst.s.hair = null;
    await applyCharacterPreset(dst.host, 'b', json);
    expect([...dst.s.clothing.keys()].sort()).toEqual([...CLOTHING_SLOTS].sort());
    expect(dst.s.clothing.get('shoes')).toMatchObject({ color: 'c-shoes' });
    expect(dst.s.skin).toBe('#f0c8a0');
    expect(dst.s.hair).toEqual({ style: 'bob' });
    expect([...dst.s.attachments.values()].map((a) => a.type)).toEqual(['pendant']);
    const face = dst.host.getFaceExpressions('b')!;
    expect(face.expressions.map((e) => e.name)).toEqual(['Smile', 'Blink']);
    expect(face.expressions.find((e) => e.id === face.activeId)?.name).toBe('Smile');
    expect(face.expressions.find((e) => e.id === face.blinkId)?.name).toBe('Blink');
    expect(dst.s.style).toBe('cel');
  });

  it('import REPLACES: slots and charms the preset lacks are removed', async () => {
    const dst = fakeCharacter();
    dressFully(dst);
    await applyCharacterPreset(dst.host, 'b', {
      kind: 'salsa-character', version: 2, body: null, hair: null,
      clothing: { top: { slot: 'top', color: 'new' } }, attachments: [],
    });
    expect([...dst.s.clothing.keys()]).toEqual(['top']);
    expect(dst.s.attachments.size).toBe(0);
    expect(dst.s.hair).toBeNull();                                    // explicit null = remove
  });

  it('an OLD v1 preset still imports, and leaves skin/charms/face alone (it never carried them)', async () => {
    const dst = fakeCharacter();
    dressFully(dst);
    const v1 = { kind: 'salsa-character', version: 1, body: { height: 1.9 }, hair: { style: 'long' },
      clothing: { top: { slot: 'top' }, bottom: { slot: 'bottom' } }, renderStyle: 'default' };
    await applyCharacterPreset(dst.host, 'b', v1);
    expect(dst.s.body).toEqual({ height: 1.9 });
    expect([...dst.s.clothing.keys()].sort()).toEqual(['bottom', 'top']);
    expect(dst.s.skin).toBe('#f0c8a0');                                // untouched
    expect(dst.s.attachments.size).toBe(1);                           // untouched
    expect(dst.host.getFaceExpressions('b')!.expressions).toHaveLength(3);   // untouched
  });

  it('rejects non-presets and presets from a newer build', () => {
    expect(() => parseCharacterPreset('{not json')).toThrow(/invalid JSON/);
    expect(() => parseCharacterPreset({ kind: 'other' })).toThrow(/not a salsa-character/);
    expect(() => parseCharacterPreset({ kind: 'salsa-character', version: 99 })).toThrow(/newer than this build/);
  });
});
