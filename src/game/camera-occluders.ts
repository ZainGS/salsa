/**
 * Camera occluder classes (Play third-person camera, docs/ui/play-mode.md §Camera collision: hard vs soft occluders).
 *
 * The third-person camera pulls in when something lies between the player's shoulder pivot and the eye. Pulling in for
 * a lamp post, a tree or a sign that happens to be behind the player is the classic annoyance (the camera jumps in
 * front of the pole, then back out). Released games only pull in for HARD occluders, the ones the camera must never be
 * inside: building shells, walls, landmarks, ground, bridges, big solid volumes. Everything else is SOFT and the
 * camera ray ignores it (it may pass through it).
 *
 * Rules, in order (the first one that decides wins):
 *  1. The author override (Mesh3D.cameraBlock): 'block' = hard, 'ignore' = soft. 'auto' (default) = the rules below.
 *  2. Characters (skinned meshes, anything under a skinned mesh) and movers (cheapBounds: traffic, walkers) = soft.
 *  3. City families by name (the mesh's own name, then its ancestors'): the street furniture / props / trees / signs /
 *     wires / railings / crowd families (CITY_SOFT) = soft; the solid families that the fog classes call props but are
 *     really walls or ground (CITY_HARD: stairs, retaining walls, viaduct, bridges, shopfronts, kiosks) = hard.
 *  4. The fog class the city stamps (Mesh3D.fogClass): 1 attachment / 2 other (props, trees, cars, crowd) = soft.
 *  5. Size (everything else, including user-authored meshes): the world box's MIDDLE extent under `thin` (a pole, a
 *     wire, a post: thin in two directions) or its LARGEST extent under `small` (a crate, a bin) = soft; else hard.
 *     With a previous verdict the thresholds carry a +/-10 % hysteresis band so a mesh near a threshold that moves or
 *     scales a little does not flip class (and pop the camera).
 *
 * Pure (no engine imports), so the rules are unit-tested headless (camera-occluders.test.ts).
 */

export type CameraBlockMode = 'auto' | 'block' | 'ignore';

export function isCameraBlockMode(v: unknown): v is CameraBlockMode {
  return v === 'auto' || v === 'block' || v === 'ignore';
}

/** Why a mesh got its class (diagnostics / tests). */
export type CameraOccluderReason =
  | 'override-block' | 'override-ignore' | 'character' | 'mover' | 'city-soft' | 'city-hard' | 'fog-attachment'
  | 'fog-other' | 'thin' | 'small' | 'large' | 'no-bounds';

export interface CameraOccluderVerdict { hard: boolean; reason: CameraOccluderReason }

export interface CameraOccluderInfo {
  /** The author override (Mesh3D.cameraBlock); undefined = 'auto'. */
  cameraBlock?: CameraBlockMode;
  /** The mesh's name first, then its ancestors' names (nearest first). */
  names: readonly string[];
  /** Mesh3D.fogClass (0 building / untiered, 1 attachment, 2 other). */
  fogClass: number;
  /** A skinned character part (or under one). */
  character: boolean;
  /** A per-frame city mover (Mesh3D.cheapBounds). */
  mover: boolean;
  /** World AABB extents [x, y, z] (any order), or null when the mesh has no bounds yet. */
  extents: readonly [number, number, number] | null;
}

/** World-unit thresholds of the size rule. */
export interface CameraOccluderScale { thin: number; small: number }

/** Size thresholds in metres for a 1.7 m reference avatar: thinner than 0.5 m in two directions, or smaller than 1.2 m. */
export const CAMERA_OCCLUDER_THIN_M = 0.5;
export const CAMERA_OCCLUDER_SMALL_M = 1.2;

/** The size thresholds for an avatar of world height `H` (scaled like the camera rig: H / 1.7 m; H <= 0 = metres). */
export function cameraOccluderScale(H: number): CameraOccluderScale {
  const k = H > 0 && Number.isFinite(H) ? H / 1.7 : 1;
  return { thin: CAMERA_OCCLUDER_THIN_M * k, small: CAMERA_OCCLUDER_SMALL_M * k };
}

/** City layers the camera passes through: street furniture, props, trees, signs, wires, railings, crowd, traffic,
 *  facade attachments and the overlays that lie on a hard surface. (Names from world-manager's distance tiers and fog
 *  extras; the soft list is tested before the hard list, so e.g. world:stair-rail is soft while world:stairs is hard, and
 *  only the facade ATTACHMENTS of the building generator's world:detail-* layers are soft, never its walls / glass.) */
export const CITY_SOFT = new RegExp([
  'world:(?:tree-|apron-foliage|apron-trunks|apron-rocks|rocks|lightpoles|util-|lamp|sg-lantern|signal|car-|veh-|traffic-',
  '|ped-|vending-|bench|bicycle|bike-rack|bollard|cone|postbox|cabinet|planter|manhole|tactile|guardrail|bridge-rail',
  '|bridge-lamplights|water-rail|stair-rail|retaining-rail|retaining-fence|roadsign-|warning|sign-|screen-|poster',
  '|detail-(?:awning|bloom|doorhandle|duct|greenery|juliet|laundry|lightbox|pfoliage|railing|roof-equip|screen|sign|trim|windowtrim)|roof-detail|roof-equip|roof-mark|balcony|rail-fine-|local-fine-|rail-train|local-train|rail-arc-lamplights',
  '|rail-arc-lantern|rail-arc-sign|rail-arc-prop|rail-stn-prop|rail-stn-lamplights|rail-stn-sign|local-stn-sign',
  '|local-stn-lamplights|local-xing-|local-prop|local-board|metro-sign|frontage-|park-prop|stall|crate|trash|vent',
  '|aboard|duck-|contact-shadow|roadpaint|roads-wear|gutter|busstop|cafe-terrace)',
  '|awning-|textsign-|util-wire|laundry|alley-clutter|noren',
].join(''));

/** City layers that are walls or ground although a draw tier may class them 'attachment' / 'other': the building
 *  generator's remaining world:detail-* layers (wall, wallbase, partywall, parapet, roof, glass, shop glass / room,
 *  shutter, storefront, door, doorframe: the facade itself), metro kiosks, stairs, retaining walls, the viaduct,
 *  bridges, platforms. */
export const CITY_HARD = /world:(?:detail-|metro-|stairs|stair-|retaining|sg-struct|sg-paving|construction|shopfront|metro-kiosk|rail-|local-platform|local-ballast|bridge)/;

/**
 * Classify one mesh. `prev` (the mesh's last verdict) widens the size thresholds by 10 % toward keeping it, so a mesh
 * hovering at a threshold keeps its class.
 */
export function classifyCameraOccluder(info: CameraOccluderInfo, scale: CameraOccluderScale, prev?: boolean): CameraOccluderVerdict {
  if (info.cameraBlock === 'block') return { hard: true, reason: 'override-block' };
  if (info.cameraBlock === 'ignore') return { hard: false, reason: 'override-ignore' };
  if (info.character) return { hard: false, reason: 'character' };
  if (info.mover) return { hard: false, reason: 'mover' };
  for (const n of info.names) {
    if (!n) continue;
    if (CITY_SOFT.test(n)) return { hard: false, reason: 'city-soft' };
    if (CITY_HARD.test(n)) return { hard: true, reason: 'city-hard' };
  }
  if (info.fogClass === 1) return { hard: false, reason: 'fog-attachment' };
  if (info.fogClass === 2) return { hard: false, reason: 'fog-other' };
  const e = info.extents;
  if (!e || !e.every(Number.isFinite)) return { hard: true, reason: 'no-bounds' };
  const s = [Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2])].sort((a, b) => b - a);
  // hysteresis: a mesh that was hard needs to be clearly under a threshold to turn soft, and vice versa
  const f = prev === true ? 0.9 : prev === false ? 1.1 : 1;
  if (s[1] < scale.thin * f) return { hard: false, reason: 'thin' };
  if (s[0] < scale.small * f) return { hard: false, reason: 'small' };
  return { hard: true, reason: 'large' };
}
