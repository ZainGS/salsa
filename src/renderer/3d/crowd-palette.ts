// CROWD PALETTE (performance-plan P12, the instanced static crowd). Pure data + the WGSL tint the mesh shaders apply to
// a mesh whose flags2 carries FLAGS2_CROWD_PALETTE (material-3d.ts; Material3D.crowdPalette).
//
// A crowd geometry carries, per vertex, a small integer CODE in uv.x (crowd meshes are untextured, so their uv is free):
//   code <  CROWD_SLOT_BASE  → a fixed palette colour: CROWD_PALETTE[code] (the near / mid per-person cell meshes, and
//                              the fixed parts of a shared variant: skin, a phone, a ribbon);
//   code >= CROWD_SLOT_BASE  → a per-instance SLOT (code - CROWD_SLOT_BASE): the palette index is read from the
//                              instance's patternColor.xyz, 4 slots of 5 bits in each float (the shared xfar variants:
//                              top, hair, legs, ... differ per person).
// The tint multiplies the instance's diffuse AND emissive colour. Crowd materials carry diffuse = PED_SHADE.diffuse
// grey (the dim the baked crowd bakes into each colour layer) and the GLOW walk's emissive = diffuse x factor, so
// diffuse x tint = the baked layer's colour and emissive x tint = its emissive: the same look, one material.
//
// The table MUST equal world/mannequin.ts PED_PALETTE (same names, same order, same values) — crowd-palette.test.ts
// pins it. It lives here because the renderer builds its shaders from it and does not import world code.

/** [name, r, g, b] in PED_PALETTE order. */
export const CROWD_PALETTE: readonly (readonly [string, number, number, number])[] = [
    ['navy', 0.12, 0.14, 0.24], ['charcoal', 0.19, 0.19, 0.21], ['black', 0.075, 0.075, 0.085], ['grey', 0.45, 0.46, 0.48],
    ['shirt', 0.88, 0.88, 0.89], ['beige', 0.74, 0.67, 0.56], ['khaki', 0.52, 0.48, 0.38], ['denim', 0.25, 0.32, 0.45],
    ['camel', 0.62, 0.49, 0.35], ['brown', 0.32, 0.23, 0.17], ['red', 0.60, 0.20, 0.20], ['mustard', 0.72, 0.58, 0.28],
    ['teal', 0.20, 0.38, 0.40], ['cream', 0.90, 0.87, 0.79], ['blush', 0.84, 0.66, 0.66], ['olive', 0.35, 0.37, 0.25],
    ['tights', 0.13, 0.12, 0.14], ['worker', 0.24, 0.33, 0.47],
    ['sky', 0.62, 0.70, 0.80], ['sage', 0.58, 0.64, 0.54], ['oat', 0.80, 0.76, 0.67],
    ['skin', 0.90, 0.77, 0.66], ['hairBlack', 0.06, 0.055, 0.055], ['hairBrown', 0.26, 0.17, 0.11], ['hairGrey', 0.62, 0.62, 0.63],
    ['hairTea', 0.46, 0.30, 0.17],
    ['vinyl', 0.84, 0.88, 0.90], ['umbNavy', 0.13, 0.16, 0.28], ['umbRed', 0.62, 0.15, 0.16],
];
/** Vertex codes at or above this are per-instance slots. */
export const CROWD_SLOT_BASE = 32;
/** Per-instance slots (3 floats x 4 slots). */
export const CROWD_SLOT_COUNT = 12;

const INDEX = new Map<string, number>(CROWD_PALETTE.map((e, i) => [e[0], i]));
/** Palette index of a colour name (PED_PALETTE key); -1 when unknown. */
export function crowdPaletteIndex(name: string): number { return INDEX.get(name) ?? -1; }

/** Pack per-slot palette indices (slot s = `idx[s]`, missing / negative = 0) into the three instance floats
 *  (patternColor.xyz). Each float holds 4 slots x 5 bits = 20 bits, exact in an f32. */
export function packCrowdSlots(idx: ArrayLike<number>): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    for (let s = 0; s < CROWD_SLOT_COUNT; s++) {
        const v = s < idx.length && idx[s] > 0 ? (idx[s] & 31) : 0;
        out[s >> 2] += v * (1 << ((s & 3) * 5));
    }
    return out;
}
/** The palette index stored for slot `s` (the CPU twin of the WGSL decode). */
export function unpackCrowdSlot(packed: ArrayLike<number>, s: number): number {
    return ((packed[s >> 2] >>> 0) >>> ((s & 3) * 5)) & 31;
}
/** The palette index a vertex code resolves to for an instance's packed slots (the CPU twin of crowdTint). */
export function crowdCodeIndex(code: number, packed: ArrayLike<number>): number {
    const c = Math.max(0, Math.round(code));
    const i = c >= CROWD_SLOT_BASE ? unpackCrowdSlot(packed, Math.min(c - CROWD_SLOT_BASE, CROWD_SLOT_COUNT - 1)) : c;
    return Math.min(i, CROWD_PALETTE.length - 1);
}

const f = (v: number): string => v.toFixed(4);
/** WGSL: the palette table + crowdTint(flags2, uv, slots). Included by the mesh vertex shader and both mesh fragment
 *  shaders. No backticks in here (it is spliced into template strings). */
export const CROWD_PALETTE_WGSL = /* wgsl */ `
// CROWD PALETTE (performance-plan P12; crowd-palette.ts). flags2 bit 4: uv.x carries a palette code per vertex.
const CROWD_PAL = array<vec3<f32>, ${CROWD_PALETTE.length}>(
${CROWD_PALETTE.map(([, r, g, b]) => `  vec3<f32>(${f(r)}, ${f(g)}, ${f(b)})`).join(',\n')}
);
fn crowdTint(flags2: u32, uv: vec2<f32>, slots: vec3<f32>) -> vec3<f32> {
  if ((flags2 & 16u) == 0u) { return vec3<f32>(1.0, 1.0, 1.0); }
  var code = u32(max(round(uv.x), 0.0));
  if (code >= ${CROWD_SLOT_BASE}u) {
    let s = min(code - ${CROWD_SLOT_BASE}u, ${CROWD_SLOT_COUNT - 1}u);
    var w = slots.x;
    if (s >= 4u) { w = slots.y; }
    if (s >= 8u) { w = slots.z; }
    code = (u32(max(w, 0.0)) >> ((s & 3u) * 5u)) & 31u;
  }
  return CROWD_PAL[min(code, ${CROWD_PALETTE.length - 1}u)];
}
`;
