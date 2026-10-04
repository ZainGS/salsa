// ─────────────────────────────────────────────────────────────────────────────
// object-style.ts — a PERSISTED LOOK for a regenerated object (2026-09-29): render style + toon shadows + rim light.
//
// Procedural objects (the city, neighborhood blocks, the creator objects — buildings / foliage / vending / …) are
// REBUILT from their params on every edit and on reload, so a style set directly on their meshes was lost. Each owner
// now keeps an ObjectStyle in its save marker and re-applies it (applyObjectStyle) after every rebuild.
//
// Semantics: a field that is UNDEFINED is not overridden (the generator's own value stands — e.g. a toon-foliage
// layer). A patch with `null` CLEARS that field back to "not overridden".
// ─────────────────────────────────────────────────────────────────────────────

import type { RenderStyle } from '../../renderer/3d/material-3d';
import type { Node } from '../../scene-graph/shapes/base/node';

export interface ObjectStyle {
    /** 'default' (PBR) | 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud' — applied to every lit mesh of the object. */
    renderStyle?: RenderStyle;
    /** Coloured toon shadows (material bit 30; visible in Cel / Cel-HD). The look is scene-wide (setToonShadows3D). */
    toonShadow?: boolean;
    /** Rim light (the scene-wide look is setRimLight3D). */
    rimLight?: boolean;
}

/** A style edit: a value sets the field, `null` clears it (back to the generator's own value). */
export type ObjectStylePatch = { [K in keyof ObjectStyle]?: ObjectStyle[K] | null };

/** Merge a patch into a style (pure). Returns a NEW object; null fields are removed. */
export function mergeObjectStyle(base: ObjectStyle | undefined, patch: ObjectStylePatch): ObjectStyle {
    const out: ObjectStyle = { ...(base ?? {}) };
    for (const k of Object.keys(patch) as (keyof ObjectStyle)[]) {
        const v = patch[k];
        if (v === null) delete out[k];
        else if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
}

/** True if the patch CLEARS a field that `base` had set — the owner must rebuild to get the generator's value back. */
export function patchClearsField(base: ObjectStyle | undefined, patch: ObjectStylePatch): boolean {
    return (Object.keys(patch) as (keyof ObjectStyle)[]).some((k) => patch[k] === null && base?.[k] !== undefined);
}

export function isEmptyStyle(s: ObjectStyle | undefined): boolean {
    return !s || (s.renderStyle === undefined && s.toonShadow === undefined && s.rimLight === undefined);
}

/** A persisted style copied from a save marker, keeping only valid fields (old / foreign data loads safely). */
export function sanitizeObjectStyle(raw: unknown): ObjectStyle | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>, out: ObjectStyle = {};
    const STYLES = ['default', 'cel', 'cel-hd', 'sketch', 'ink', 'gouraud'];
    if (typeof r.renderStyle === 'string' && STYLES.includes(r.renderStyle)) out.renderStyle = r.renderStyle as RenderStyle;
    if (typeof r.toonShadow === 'boolean') out.toonShadow = r.toonShadow;
    if (typeof r.rimLight === 'boolean') out.rimLight = r.rimLight;
    return isEmptyStyle(out) ? undefined : out;
}

/** The mesh-ish shape applyObjectStyle writes (a structural subset of Mesh3D, so it's testable). */
interface StyledMesh {
    material?: { renderStyle?: RenderStyle; toonShadow?: boolean; rimEnabled?: boolean };
    isFaceDecal?: boolean;
    gpuDirty?: boolean;
    materialDirty?: boolean;
    stateDirty?: boolean;
}

/**
 * Apply `style` to every mesh under `root` (recursively). Skips UNLIT materials (labels, info cards, sprites that must
 * stay crisp) and face decals. Undefined fields are left alone. Returns how many meshes changed. Array-group copies
 * share their source mesh's material, so styling the source styles them all.
 */
export function applyObjectStyle(root: Node, style: ObjectStyle | undefined): number {
    if (isEmptyStyle(style)) return 0;
    const s = style!;
    let n = 0;
    const visit = (node: Node): void => {
        const m = node as unknown as StyledMesh;
        const mat = m.material;
        if (mat && !m.isFaceDecal && (mat.renderStyle as string) !== 'unlit') {
            if (s.renderStyle !== undefined) mat.renderStyle = s.renderStyle;
            if (s.toonShadow !== undefined) mat.toonShadow = s.toonShadow;
            if (s.rimLight !== undefined) mat.rimEnabled = s.rimLight;
            m.gpuDirty = true; m.materialDirty = true;
            n++;
        }
        for (const c of node.children ?? []) visit(c);
    };
    for (const c of root.children ?? []) visit(c);
    return n;
}

/** Neutral values for clearing a style IN PLACE (for owners too heavy to rebuild — the city). */
export function neutralizeClearedFields(base: ObjectStyle | undefined, patch: ObjectStylePatch): ObjectStyle {
    const out: ObjectStyle = {};
    for (const k of Object.keys(patch) as (keyof ObjectStyle)[]) {
        if (patch[k] !== null || base?.[k] === undefined) continue;
        if (k === 'renderStyle') out.renderStyle = 'default';
        else (out as Record<string, unknown>)[k] = false;
    }
    return out;
}
