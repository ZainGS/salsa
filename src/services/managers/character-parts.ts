// PURE procedural-character generation (body → body-fit → garments → hair) — no scene-graph / DOM / WebGPU, so it
// runs in the 'character' worker lane (src/services/workers/character-jobs.ts) AND is the single source the main
// thread's sync setters use (generateGarment / normalizeGarmentParams / hairCollisionVerts / headFrameFromBBox), so
// worker-precomputed parts are byte-identical to what Scene3DCharacter would build itself (performance-plan P3.2d).
//
// Everything here mirrors the main-thread inputs exactly: the body's BodyFit is built from the generator result the
// same way Scene3DCharacter._buildBodyFit builds it from the live mesh + skeleton (same arrays: the mesh's geometry
// IS result.geometry, its jointIndices/Weights are copies of result.skinning's, its joints' inverse binds are copies
// of result.skinning.inverseBindMatrices), the hair's collision soup is the body + garments in the fixed slot order,
// and the head frame is the same weighted-head bbox.

import { generateBodyResult, type BodyParams } from './body-generator';
import {
    generateTop, generateBottom, generateShoe, generateSock, generateUndershirt, generateUnderpants, normSleeveLength,
    type BodyFit, type ClothingParams, type TopParams, type ShoeParams,
} from './clothing-generator';
import type { SkirtSteer } from './skirt-steer';
import type { MeshGeometry } from '../../renderer/3d/mesh-generators';
import { generateHair, type HairParams, type HairResult, type HeadFrame } from './hair-generator';
import { buildBodyFitFrom, headRegionBBoxOf } from './body-fit';
import { layerOutfit, type LayerSlot } from './garment-layers';

export type CharacterGarmentSlot = 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants';
/** The order the hair's collision soup concatenates garments in (Scene3DCharacter._collisionVertsForHair). */
export const HAIR_COLLISION_SLOT_ORDER: readonly CharacterGarmentSlot[] = ['top', 'bottom', 'shoes', 'socks', 'undershirt', 'underpants'];

export type BodyGenResult = ReturnType<typeof generateBodyResult>;
export interface GarmentGenResult { geometry: MeshGeometry; jointIndices: Uint8Array; jointWeights: Float32Array; skirtSteer?: SkirtSteer }

/** The garment params a setter actually generates from (a 'top' sleeveLength preset name → its number). Returns the
 *  SAME object when nothing changes (as setClothingParams always did). */
export function normalizeGarmentParams(params: ClothingParams): ClothingParams {
    if (params.slot === 'top') {
        const raw = (params as TopParams).sleeveLength as number | string;
        const n = normSleeveLength(raw);
        if (raw !== n) return { ...(params as TopParams), sleeveLength: n };
    }
    return params;
}

/** One garment from a fit — the slot dispatch Scene3DCharacter.setClothingParams uses. `shoes` only affects 'bottom'
 *  (hems pile onto the shoe). */
export function generateGarment(fit: BodyFit, params: ClothingParams, shoes: ShoeParams | null): GarmentGenResult {
    return (params.slot === 'top' ? generateTop(fit, params)
        : params.slot === 'bottom' ? generateBottom(fit, params, shoes)
        : params.slot === 'shoes' ? generateShoe(fit, params)
        : params.slot === 'socks' ? generateSock(fit, params)
        : params.slot === 'undershirt' ? generateUndershirt(fit, params)
        : generateUnderpants(fit, params)) as GarmentGenResult;
}

/** Hair collision soup: body verts + each present garment's verts (≥ 1 vertex), concatenated in slot order. Returns
 *  the body array itself when it is the only part (no copy — as before). */
export function hairCollisionVerts(parts: (Float32Array | undefined | null)[]): Float32Array | undefined {
    const ps = parts.filter((p): p is Float32Array => !!p && p.length >= 12);
    if (ps.length === 0) return undefined;
    if (ps.length === 1) return ps[0];
    let n = 0; for (const p of ps) n += p.length;
    const out = new Float32Array(n);
    let o = 0; for (const p of ps) { out.set(p, o); o += p.length; }
    return out;
}

export function headFrameFromBBox(bb: { min: [number, number, number]; max: [number, number, number] }): HeadFrame {
    return {
        cx: (bb.min[0]+bb.max[0])*0.5, cy: (bb.min[1]+bb.max[1])*0.5, cz: (bb.min[2]+bb.max[2])*0.5,
        rx: (bb.max[0]-bb.min[0])*0.5, ry: (bb.max[1]-bb.min[1])*0.5, rz: (bb.max[2]-bb.min[2])*0.5,
    };
}

/** The BodyFit of a freshly generated body — identical to Scene3DCharacter._buildBodyFit on the mesh built from it. */
export function bodyFitFromResult(r: BodyGenResult): BodyFit {
    const s = r.skinning;
    return buildBodyFitFrom({
        verts: r.geometry.vertices, ji: s.jointIndices, jw: s.jointWeights, indices: r.geometry.indices,
        joints: s.jointNames.map((name, i) => ({
            index: i, name, parentIndex: s.jointParents![i],
            inverseBindMatrix: s.inverseBindMatrices.subarray(i * 16, i * 16 + 16),
        })),
        armSurface: r.armSurface, legSurface: r.legSurface, torsoSurface: r.torsoSurface,
    });
}

export interface CharacterPartsSpec {
    /** FULL body params (already merged with defaults/seamBlend by the caller — generated as given). */
    body: Partial<BodyParams>;
    /** Garments to pre-generate (any order; 'bottom' always piles onto `shoes` from this list when present). */
    garments?: ClothingParams[];
    /** Hair to pre-generate, fitted against the body + ALL the garments above (= the final dressed state). */
    hair?: HairParams | null;
}

export interface GarmentPart { params: ClothingParams; shoes: ShoeParams | null; result: GarmentGenResult }
export interface CharacterParts {
    body: BodyGenResult;
    garments: GarmentPart[];
    hair: { params: HairParams; garmentParams: ClothingParams[]; result: HairResult } | null;
}

/** Body + garments + hair for one character, as plain data. The garments are fitted to the body (no spring joints
 *  yet — garments are generated BEFORE hair, the order createFullCharacter3D / the auto player use), the hair to the
 *  body + all garments. `hair.garmentParams` = the garment params the collision soup was built from, in
 *  HAIR_COLLISION_SLOT_ORDER (the main thread checks its live rigs match before using the hair). */
export function generateCharacterParts(spec: CharacterPartsSpec): CharacterParts {
    const body = generateBodyResult(spec.body);
    const garments: GarmentPart[] = [];
    const list = (spec.garments ?? []).filter((g) => g && typeof g === 'object');
    if (list.length || spec.hair) {
        const fit = bodyFitFromResult(body);
        const shoesP = (list.find((g) => g.slot === 'shoes') as ShoeParams | undefined) ?? null;
        const seen = new Set<string>();
        for (const g of list) {
            if (seen.has(g.slot)) continue;   // one per slot (a later duplicate would just replace it main-side)
            seen.add(g.slot);
            const params = normalizeGarmentParams(g);
            const shoes = params.slot === 'bottom' ? shoesP : null;
            garments.push({ params, shoes, result: generateGarment(fit, params, shoes) });
        }
    }
    let hair: CharacterParts['hair'] = null;
    if (spec.hair) {
        const s = body.skinning;
        const headIdx = s.jointNames.indexOf('head');
        const bb = headIdx >= 0 ? headRegionBBoxOf(body.geometry.vertices, s.jointIndices, s.jointWeights, headIdx) : null;
        if (bb) {
            const bySlot = new Map(garments.map((g) => [g.params.slot, g] as const));
            const ordered = HAIR_COLLISION_SLOT_ORDER.map((sl) => bySlot.get(sl)).filter((g): g is GarmentPart => !!g);
            // The garments as DRAWN (layered: garment-layers.ts) — what Scene3DCharacter's hair soup reads off the meshes.
            const layered = layerOutfit(Object.fromEntries(garments.map((g) => [g.params.slot, g.result])) as Partial<Record<LayerSlot, GarmentGenResult>>,
                (s) => s === 'bottom' && (bySlot.get('bottom')?.params as { bottomStyle?: string } | undefined)?.bottomStyle === 'skirt');
            const coll = hairCollisionVerts([body.geometry.vertices, ...ordered.map((g) => (layered[g.params.slot as LayerSlot] ?? g.result).geometry.vertices)]);
            hair = { params: spec.hair, garmentParams: ordered.map((g) => g.params), result: generateHair(headFrameFromBBox(bb), spec.hair, coll) };
        }
    }
    return { body, garments, hair };
}
