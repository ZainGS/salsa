// ─────────────────────────────────────────────────────────────────────────────
// Creator registry — the param SCHEMAS for the 3D procedural creators (Vending first). This is part 3 of
// the procedural-creation system (docs/specs/creator-modes.md §5.2): a machine-readable description of a
// generator's editable params, so Frogmarks renders ONE schema-driven panel that serves every creator
// instead of hand-writing a control panel per generator.
//
// ★ ONE SCHEMA SHAPE. The 2D ephemera system already defined `EphemeraParamSchema` (key/label/type/default/
// min/max/step/options/group). We reuse it verbatim rather than invent a second convention — a slider is a
// slider whether it drives an SVG sticker or a 3D machine. It is re-exported here as `CreatorParamSchema`
// so 3D callers need not reach into the ephemera module by name.
//
// Layering: this lives in the managers layer (not `src/world`) because it imports the ephemera schema type
// and is host-facing — `src/world` is a leaf and must never import `src/services`. The param DEFAULTS come
// from each generator's own `DEFAULT_*_PARAMS` (single source of truth); the schema only adds UI metadata
// (labels, ranges, groups). A test ties the schema's ranges to the generator's `resolve*` clamps so the two
// can never silently disagree.
// ─────────────────────────────────────────────────────────────────────────────

import type { EphemeraParamSchema } from '../ephemera/ephemera-types';
import { DEFAULT_VENDING_PARAMS, VENDING_BRANDS } from '../../world/vending';
import { DEFAULT_FOLIAGE_PARAMS, foliageTypeNames } from '../../world/foliage';
import { DEFAULT_BIKE_RACK_PARAMS } from '../../world/bike-rack';
import { DEFAULT_BOLLARD_PARAMS, BOLLARD_CAPS, BOLLARD_FINISH_NAMES } from '../../world/bollard';
import { DEFAULT_LAMP_POST_PARAMS, LAMP_STYLES } from '../../world/lamp-post';
import { DEFAULT_TRASH_BIN_PARAMS, BIN_SHAPES, BIN_FINISH_NAMES } from '../../world/trash-bin';
import { DEFAULT_CRATE_PARAMS, CRATE_FINISH_NAMES } from '../../world/crate';
import { DEFAULT_VENT_PARAMS, VENT_STYLES } from '../../world/vent';
import { DEFAULT_ABOARD_PARAMS, ABOARD_FACE_NAMES } from '../../world/a-board';
import { DEFAULT_STALL_PARAMS, AWNING_COLOR_NAMES } from '../../world/stall';

/** The single param-schema field shape, shared with the 2D ephemera generators. */
export type CreatorParamSchema = EphemeraParamSchema;

/** One registered 3D creator: its stable id, a display label, and the schema that drives its panel. */
export interface Creator3DDef {
    typeId: string;
    label: string;
    schema: CreatorParamSchema[];
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ── Vending machine ─────────────────────────────────────────────────────────────────────────────
// Ranges mirror the clamps in resolveVendingParams() (world/vending.ts); creator-registry.test.ts asserts
// they stay consistent. Defaults are read from DEFAULT_VENDING_PARAMS so there is one source of truth.
export const VENDING_SCHEMA: CreatorParamSchema[] = [
    { key: 'brand', label: 'Brand', type: 'select', default: DEFAULT_VENDING_PARAMS.brand, group: 'Brand',
        options: VENDING_BRANDS.map((b, i) => ({ value: i, label: cap(b.name) })) },
    { key: 'heightM', label: 'Height (m)', type: 'range', default: DEFAULT_VENDING_PARAMS.heightM, min: 0.6, max: 2.6, step: 0.05, group: 'Dimensions' },
    { key: 'widthM',  label: 'Width (m)',  type: 'range', default: DEFAULT_VENDING_PARAMS.widthM,  min: 0.4, max: 1.4, step: 0.02, group: 'Dimensions' },
    { key: 'depthM',  label: 'Depth (m)',  type: 'range', default: DEFAULT_VENDING_PARAMS.depthM,  min: 0.3, max: 1.0, step: 0.02, group: 'Dimensions' },
    { key: 'productCols', label: 'Product columns', type: 'range', default: DEFAULT_VENDING_PARAMS.productCols, min: 1, max: 4, step: 1, group: 'Display' },
    { key: 'productRows', label: 'Product rows',    type: 'range', default: DEFAULT_VENDING_PARAMS.productRows, min: 1, max: 4, step: 1, group: 'Display' },
    { key: 'glow', label: 'Window glow', type: 'range', default: DEFAULT_VENDING_PARAMS.glow, min: 0, max: 2, step: 0.05, group: 'Display' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_VENDING_PARAMS.seed, group: 'Seed' },
];

// ── Foliage ─────────────────────────────────────────────────────────────────────────────────────
// A CURATED schema — the common knobs, not every FoliageParams field (colours, per-type extras and bloom
// stay on the existing typed panel for now). Proves the schema-driven panel is generic across a
// differently-shaped generator. The generic create fills the omitted params via resolveFoliageParams.
export const FOLIAGE_SCHEMA: CreatorParamSchema[] = [
    { key: 'type', label: 'Type', type: 'select', default: DEFAULT_FOLIAGE_PARAMS.type, group: 'Type',
        options: foliageTypeNames().map((t) => ({ value: t, label: t })) },
    { key: 'size',    label: 'Size (m)', type: 'range', default: DEFAULT_FOLIAGE_PARAMS.size,    min: 0.1, max: 10, step: 0.1, group: 'Shape' },
    { key: 'width',   label: 'Width (m)', type: 'range', default: DEFAULT_FOLIAGE_PARAMS.width,  min: 0.1, max: 10, step: 0.1, group: 'Shape' },
    { key: 'density', label: 'Density',  type: 'range', default: DEFAULT_FOLIAGE_PARAMS.density, min: 0, max: 1, step: 0.05, group: 'Shape' },
    { key: 'render',  label: 'Render',   type: 'select', default: DEFAULT_FOLIAGE_PARAMS.render, group: 'Render',
        options: [{ value: 'chunky', label: 'Chunky (low-poly)' }, { value: 'card', label: 'Cards (leafy)' }] },
    { key: 'celShade', label: 'Cel / toon shading', type: 'toggle', default: DEFAULT_FOLIAGE_PARAMS.celShade, group: 'Render' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_FOLIAGE_PARAMS.seed, group: 'Seed' },
];

// ── Bike rack ───────────────────────────────────────────────────────────────────────────────────
export const BIKE_RACK_SCHEMA: CreatorParamSchema[] = [
    { key: 'hoops',   label: 'Hoops',    type: 'range', default: DEFAULT_BIKE_RACK_PARAMS.hoops,   min: 1, max: 8, step: 1, group: 'Layout' },
    { key: 'lengthM', label: 'Run (m)',  type: 'range', default: DEFAULT_BIKE_RACK_PARAMS.lengthM, min: 0.3, max: 6, step: 0.1, group: 'Layout' },
    { key: 'widthM',  label: 'Width (m)', type: 'range', default: DEFAULT_BIKE_RACK_PARAMS.widthM, min: 0.3, max: 1.2, step: 0.05, group: 'Hoop' },
    { key: 'heightM', label: 'Height (m)', type: 'range', default: DEFAULT_BIKE_RACK_PARAMS.heightM, min: 0.4, max: 1.2, step: 0.05, group: 'Hoop' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_BIKE_RACK_PARAMS.seed, group: 'Seed' },
];

// ── Bollard ─────────────────────────────────────────────────────────────────────────────────────
export const BOLLARD_SCHEMA: CreatorParamSchema[] = [
    { key: 'cap', label: 'Cap', type: 'select', default: DEFAULT_BOLLARD_PARAMS.cap, group: 'Style',
        options: BOLLARD_CAPS.map((c) => ({ value: c, label: c })) },
    { key: 'finish', label: 'Finish', type: 'select', default: DEFAULT_BOLLARD_PARAMS.finish, group: 'Style',
        options: BOLLARD_FINISH_NAMES.map((f) => ({ value: f, label: f })) },
    { key: 'heightM', label: 'Height (m)', type: 'range', default: DEFAULT_BOLLARD_PARAMS.heightM, min: 0.3, max: 1.4, step: 0.05, group: 'Dimensions' },
    { key: 'radiusM', label: 'Radius (m)', type: 'range', default: DEFAULT_BOLLARD_PARAMS.radiusM, min: 0.04, max: 0.3, step: 0.01, group: 'Dimensions' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_BOLLARD_PARAMS.seed, group: 'Seed' },
];

// ── Lamp post ───────────────────────────────────────────────────────────────────────────────────
export const LAMP_POST_SCHEMA: CreatorParamSchema[] = [
    { key: 'style', label: 'Style', type: 'select', default: DEFAULT_LAMP_POST_PARAMS.style, group: 'Style',
        options: LAMP_STYLES.map((s) => ({ value: s, label: cap(s) })) },
    { key: 'heightM', label: 'Height (m)', type: 'range', default: DEFAULT_LAMP_POST_PARAMS.heightM, min: 2, max: 8, step: 0.1, group: 'Dimensions' },
    { key: 'banners', label: 'Banners', type: 'toggle', default: DEFAULT_LAMP_POST_PARAMS.banners, group: 'Banners' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_LAMP_POST_PARAMS.seed, group: 'Seed' },
];

// ── Trash bin ───────────────────────────────────────────────────────────────────────────────────
export const TRASH_BIN_SCHEMA: CreatorParamSchema[] = [
    { key: 'shape', label: 'Shape', type: 'select', default: DEFAULT_TRASH_BIN_PARAMS.shape, group: 'Style',
        options: BIN_SHAPES.map((s) => ({ value: s, label: cap(s) })) },
    { key: 'finish', label: 'Finish', type: 'select', default: DEFAULT_TRASH_BIN_PARAMS.finish, group: 'Style',
        options: BIN_FINISH_NAMES.map((f) => ({ value: f, label: cap(f) })) },
    { key: 'heightM', label: 'Height (m)', type: 'range', default: DEFAULT_TRASH_BIN_PARAMS.heightM, min: 0.4, max: 1.6, step: 0.05, group: 'Dimensions' },
    { key: 'radiusM', label: 'Radius (m)', type: 'range', default: DEFAULT_TRASH_BIN_PARAMS.radiusM, min: 0.1, max: 0.5, step: 0.01, group: 'Dimensions' },
    { key: 'lid', label: 'Lid', type: 'toggle', default: DEFAULT_TRASH_BIN_PARAMS.lid, group: 'Style' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_TRASH_BIN_PARAMS.seed, group: 'Seed' },
];

// ── Crate stack ─────────────────────────────────────────────────────────────────────────────────
export const CRATE_SCHEMA: CreatorParamSchema[] = [
    { key: 'count', label: 'Crates', type: 'range', default: DEFAULT_CRATE_PARAMS.count, min: 1, max: 6, step: 1, group: 'Stack' },
    { key: 'sizeM', label: 'Size (m)', type: 'range', default: DEFAULT_CRATE_PARAMS.sizeM, min: 0.2, max: 1.0, step: 0.02, group: 'Stack' },
    { key: 'finish', label: 'Finish', type: 'select', default: DEFAULT_CRATE_PARAMS.finish, group: 'Style',
        options: CRATE_FINISH_NAMES.map((f) => ({ value: f, label: cap(f) })) },
    { key: 'slats', label: 'Slatted', type: 'toggle', default: DEFAULT_CRATE_PARAMS.slats, group: 'Style' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_CRATE_PARAMS.seed, group: 'Seed' },
];

// ── Ground vent / grate ───────────────────────────────────────────────────────────────────────────
export const VENT_SCHEMA: CreatorParamSchema[] = [
    { key: 'style', label: 'Style', type: 'select', default: DEFAULT_VENT_PARAMS.style, group: 'Style',
        options: VENT_STYLES.map((v) => ({ value: v, label: cap(v) })) },
    { key: 'widthM', label: 'Width (m)', type: 'range', default: DEFAULT_VENT_PARAMS.widthM, min: 0.3, max: 2.0, step: 0.05, group: 'Dimensions' },
    { key: 'bars', label: 'Bars / louvers', type: 'range', default: DEFAULT_VENT_PARAMS.bars, min: 3, max: 16, step: 1, group: 'Style' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_VENT_PARAMS.seed, group: 'Seed' },
];

// ── A-board (sandwich board) ──────────────────────────────────────────────────────────────────────
export const ABOARD_SCHEMA: CreatorParamSchema[] = [
    { key: 'face', label: 'Face', type: 'select', default: DEFAULT_ABOARD_PARAMS.face, group: 'Style',
        options: ABOARD_FACE_NAMES.map((f) => ({ value: f, label: cap(f) })) },
    { key: 'widthM', label: 'Width (m)', type: 'range', default: DEFAULT_ABOARD_PARAMS.widthM, min: 0.3, max: 1.2, step: 0.05, group: 'Dimensions' },
    { key: 'heightM', label: 'Height (m)', type: 'range', default: DEFAULT_ABOARD_PARAMS.heightM, min: 0.4, max: 1.4, step: 0.05, group: 'Dimensions' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_ABOARD_PARAMS.seed, group: 'Seed' },
];

// ── Produce / market stall ───────────────────────────────────────────────────────────────────────
export const STALL_SCHEMA: CreatorParamSchema[] = [
    { key: 'widthM', label: 'Width (m)', type: 'range', default: DEFAULT_STALL_PARAMS.widthM, min: 0.8, max: 3.5, step: 0.1, group: 'Dimensions' },
    { key: 'awning', label: 'Awning', type: 'toggle', default: DEFAULT_STALL_PARAMS.awning, group: 'Awning' },
    { key: 'awningColor', label: 'Awning colour', type: 'select', default: DEFAULT_STALL_PARAMS.awningColor, group: 'Awning',
        options: AWNING_COLOR_NAMES.map((c) => ({ value: c, label: cap(c) })) },
    { key: 'produce', label: 'Produce display', type: 'toggle', default: DEFAULT_STALL_PARAMS.produce, group: 'Display' },
    { key: 'seed', label: 'Seed', type: 'seed', default: DEFAULT_STALL_PARAMS.seed, group: 'Seed' },
];

/** Every registered 3D creator. Add a generator here + its `*Manager` and it gets a schema-driven panel. */
export const CREATOR_3D_DEFS: Creator3DDef[] = [
    { typeId: 'vending', label: 'Vending Machine', schema: VENDING_SCHEMA },
    { typeId: 'foliage', label: 'Foliage', schema: FOLIAGE_SCHEMA },
    { typeId: 'bike-rack', label: 'Bike Rack', schema: BIKE_RACK_SCHEMA },
    { typeId: 'bollard', label: 'Bollard', schema: BOLLARD_SCHEMA },
    { typeId: 'lamp-post', label: 'Lamp Post', schema: LAMP_POST_SCHEMA },
    { typeId: 'trash-bin', label: 'Trash Bin', schema: TRASH_BIN_SCHEMA },
    { typeId: 'crate', label: 'Crate Stack', schema: CRATE_SCHEMA },
    { typeId: 'vent', label: 'Ground Vent', schema: VENT_SCHEMA },
    { typeId: 'a-board', label: 'A-Board', schema: ABOARD_SCHEMA },
    { typeId: 'stall', label: 'Produce Stall', schema: STALL_SCHEMA },
];

const _byType = new Map<string, Creator3DDef>(CREATOR_3D_DEFS.map((d) => [d.typeId, d]));

/** Look up a creator definition by its typeId (undefined if not registered). */
export function creator3DDef(typeId: string): Creator3DDef | undefined { return _byType.get(typeId); }

/** The schema for a creator's editable params, or [] if the typeId is unknown. */
export function creator3DSchema(typeId: string): CreatorParamSchema[] { return _byType.get(typeId)?.schema ?? []; }

/** The default params object for a creator, derived from its schema (key → field.default). */
export function creator3DDefaults(typeId: string): Record<string, unknown> {
    const def = _byType.get(typeId);
    if (!def) return {};
    const out: Record<string, unknown> = {};
    for (const f of def.schema) out[f.key] = f.default;
    return out;
}

/** All registered creator typeIds (for a host picker). */
export function creator3DTypes(): { typeId: string; label: string }[] {
    return CREATOR_3D_DEFS.map((d) => ({ typeId: d.typeId, label: d.label }));
}
