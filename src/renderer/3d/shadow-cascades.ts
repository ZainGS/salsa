/**
 * CASCADED SHADOW MAPS — settings + the pure cascade layout (persona-polish-plan A2).
 *
 * The renderer's original shadow map (one ortho box, zoom-adaptive and texel-snapped, see Renderer3D
 * _updateShadowCenter) stays the FAR cascade, unchanged. Cascades add up to two NEAR boxes around the camera, each a
 * layer of one depth-array texture, rendered with only the casters that touch that box (per-cascade light-box cull).
 * The mesh shader picks the nearest cascade that contains a pixel and blends into the next one inside a band at the
 * box edge (mesh3d-shaders sampleShadowCascaded). `cascades: 1` = the original single map, bit-identical.
 */

export interface ShadowCascadeSettings {
  /** Total cascades including the original far map: 1 = off (original), 2 = one near cascade, 3 = near + mid. */
  cascades: 1 | 2 | 3;
  /** Half-width of the NEAREST cascade box, in world units (0 = auto: 1/8 of the far box). The city sets it from
   *  metres (world.setShadowCascades nearMetres). An orbit camera grows it with the orbit distance. */
  nearExtent: number;
  /** Cascade map resolution per layer (512..4096, default 2048). */
  mapSize: number;
  /** Blend band at a cascade's edge, as a fraction of its box (0..0.5, default 0.15). */
  blend: number;
  /** Refresh the near cascades every N rendered frames (default 1: people, cars and the player stay current). The far
   *  map keeps its own throttle (setShadowUpdateInterval). */
  updateInterval: number;
}

export const DEFAULT_SHADOW_CASCADES: ShadowCascadeSettings = { cascades: 1, nearExtent: 0, mapSize: 2048, blend: 0.15, updateInterval: 1 };

export function sanitizeShadowCascades(s: Partial<ShadowCascadeSettings> | null | undefined, base: ShadowCascadeSettings = DEFAULT_SHADOW_CASCADES): ShadowCascadeSettings {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const c = Math.round(num(s?.cascades, base.cascades));
  const size = Math.round(num(s?.mapSize, base.mapSize));
  return {
    cascades: (c <= 1 ? 1 : c >= 3 ? 3 : 2) as 1 | 2 | 3,
    nearExtent: Math.max(0, num(s?.nearExtent, base.nearExtent)),
    mapSize: Math.min(4096, Math.max(512, size)),
    blend: Math.min(0.5, Math.max(0, num(s?.blend, base.blend))),
    updateInterval: Math.max(1, Math.round(num(s?.updateInterval, base.updateInterval))),
  };
}

/** The half-widths of the NEAR cascades (nearest first; the far map is `farHe`). The nearest is `nearExtent` (auto =
 *  farHe / 8), grown a little for a low orbit camera (~0.45 × orbit distance) and never wider than half the far box.
 *  Returns NONE when the camera is pulled far out (the box would have to grow past 3 × nearExtent) or the far map is
 *  already nearly as sharp: the zoom-adaptive far map covers an overview well, and a cascade there would only redraw
 *  most of the city a second time (measured ~8 ms at the hero view). A 3-cascade layout puts the mid box at the
 *  geometric mean. Pure. */
export function cascadeHalfExtents(count: number, farHe: number, nearExtent: number, orbitDist: number): number[] {
  if (count <= 0 || !(farHe > 0)) return [];
  let he0 = nearExtent > 0 ? nearExtent : farHe / 8;
  const grow = orbitDist * 0.45;
  if (grow > he0 * 3) return [];
  he0 = Math.max(he0, grow);
  if (he0 > farHe * 0.5) return [];   // the far map is already within 2x as sharp
  if (count === 1) return [he0];
  return [he0, Math.sqrt(he0 * farHe)];
}

/** NDC depth bias for a cascade: `k` texels of world-space slack (grows with the PCF footprint `softness`) divided by
 *  the box's depth range. Pure. */
export function cascadeBias(he: number, mapSize: number, depthRange: number, softness: number): number {
  const texel = (2 * he) / Math.max(1, mapSize);
  return ((2 + Math.max(1, softness)) * texel) / Math.max(1e-6, depthRange);
}
