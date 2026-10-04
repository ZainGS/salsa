/**
 * view-cull.ts — CAMERA-AWARE culling / LOD metrics for the city (T7.5).
 *
 * The streamed-tile cull and the city detail LOD were designed for a top-down look at tiles: a tile was "in view"
 * when its flat GROUND footprint projected on screen, ranked by its NDC-centre distance, and the detail tiers keyed
 * off the orbit radius. At street level (low pitch, perspective, camera among the buildings) that breaks:
 *  · looking UP at the buildings puts the ground footprint below the screen → the tile you stand in (and the centre
 *    city) was culled — "my surroundings disappear";
 *  · a camera near the city edge, orbiting a far pivot, had a big orbit radius → every detail tier hidden although
 *    the props right in front of the lens are big on screen.
 * These helpers test a real 3D BOX (footprint × building height) against the view FRUSTUM (conservative plane test —
 * never culls a box that straddles the camera), rank by distance from the CAMERA, and derive the LOD metric from the
 * camera's distance to the nearest city content.
 */
import { STREAM_HITCH, streamHitchStats } from '../../renderer/3d/stream-hitch';

/** Frustum (left/right/bottom/top/near) of a column-major WebGPU view-projection matrix (clip z ∈ [0, w]), with the
 *  four side planes widened by `margin` in NDC units. Planes are (a, b, c, d): a·x + b·y + c·z + d ≥ 0 inside. The
 *  FAR plane is deliberately omitted — distance is bounded by the caller's own reach / fog logic. */
export function frustumPlanes(m: ArrayLike<number>, margin = 0, out: Float64Array = new Float64Array(20)): Float64Array {
    const k = 1 + margin;
    const r = (i: number, j: number): number => m[j * 4 + i];   // row i, column j
    for (let j = 0; j < 4; j++) {
        const w = r(3, j) * k;
        out[0 + j]  = w + r(0, j);   // left   x ≥ −k·w
        out[4 + j]  = w - r(0, j);   // right  x ≤  k·w
        out[8 + j]  = w + r(1, j);   // bottom y ≥ −k·w
        out[12 + j] = w - r(1, j);   // top    y ≤  k·w
        out[16 + j] = r(2, j);       // near   z ≥ 0 (ZO depth)
    }
    return out;
}

/** Conservative AABB-vs-frustum: false only when the box is entirely OUTSIDE one plane (the positive-vertex test). */
export function boxInFrustum(planes: ArrayLike<number>, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    for (let p = 0; p < 20; p += 4) {
        const a = planes[p], b = planes[p + 1], c = planes[p + 2], d = planes[p + 3];
        const x = a >= 0 ? maxX : minX, y = b >= 0 ? maxY : minY, z = c >= 0 ? maxZ : minZ;
        if (a * x + b * y + c * z + d < 0) return false;
    }
    return true;
}

/** Distance from point (px,py,pz) to an AABB (0 when inside). */
export function distToBox(px: number, py: number, pz: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
    const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
    const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
    const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
    return Math.hypot(dx, dy, dz);
}

/**
 * A city TILE's view rank, camera-aware: the tile is the box [wx±r] × [wy, wy+height] × [wz±r]. Returns −1 when it's
 * outside the (margin-widened) frustum, else a rank where SMALLER = more prominent: the squared camera→box distance
 * in tile spans (the tile you stand in ranks 0 at street level), plus a small screen-centre term that breaks ties in
 * a top-down view (where many tiles sit at a similar distance).
 */
export function tileViewRank(vp: ArrayLike<number>, cam: ArrayLike<number>, wx: number, wy: number, wz: number, r: number,
    height: number, margin: number, span: number, planes?: Float64Array): number {
    const pl = frustumPlanes(vp, margin, planes);
    const minX = wx - r, maxX = wx + r, minZ = wz - r, maxZ = wz + r, minY = wy, maxY = wy + height;
    if (!boxInFrustum(pl, minX, minY, minZ, maxX, maxY, maxZ)) return -1;
    const d = distToBox(cam[0], cam[1], cam[2], minX, minY, minZ, maxX, maxY, maxZ) / Math.max(1e-6, span);
    // Screen-centre tie-break (the box centre's NDC distance, clamped; behind-camera centres get the max).
    const cx = wx, cy = wy + height * 0.5, cz = wz;
    const w = vp[3] * cx + vp[7] * cy + vp[11] * cz + vp[15];
    let c2 = 4;
    if (w > 1e-4) {
        const nx = (vp[0] * cx + vp[4] * cy + vp[8] * cz + vp[12]) / w, ny = (vp[1] * cx + vp[5] * cy + vp[9] * cz + vp[13]) / w;
        c2 = Math.min(4, nx * nx + ny * ny);
    }
    return d * d + 0.05 * c2;
}

/**
 * The city detail-LOD METRIC, camera-aware. The tier thresholds were tuned against the orbit radius at an overview
 * pitch; this returns `min(orbitRadius, 2 × nearest-content distance)` where the nearest-content distance is the
 * camera's distance to the city volume (a disc of `footprintR` around (cx, cz), from `groundY` up to `groundY +
 * height`; `footprintR = Infinity` for a tiled world whose tiles surround you). At an overview (camera above the
 * city at ≥ 30° pitch) 2 × height-above-roofs ≥ radius, so the old behaviour is unchanged; at street level / near
 * the edge the metric collapses → the fine detail around the lens stays drawn. Never culls MORE than the old metric.
 */
export function cityLodMetric(cam: ArrayLike<number>, orbitRadius: number, cx: number, cz: number, footprintR: number,
    groundY: number, height: number): number {
    const h = Math.hypot(cam[0] - cx, cam[2] - cz);
    const dH = Number.isFinite(footprintR) ? Math.max(0, h - footprintR) : 0;
    const top = groundY + height;
    const dV = cam[1] > top ? cam[1] - top : cam[1] < groundY ? groundY - cam[1] : 0;
    return Math.min(orbitRadius, 2 * Math.hypot(dH, dV));
}

/** A DISTANCE-LOD tier (R6.1): node names matching `re` stop drawing past `far` world units from the camera. The
 *  optional third element (P7) is the fraction of the aerial bias the tier takes (Mesh3D.drawDistanceBias; default 1).
 *  The optional fourth (P8) is the tier's SHADOW FEATURE SIZE in world units (Mesh3D.shadowFeatureSize; 0 / absent =
 *  always cast): a shadow map too coarse to resolve a feature that size leaves the tier's meshes out of its casters. */
export type DistanceTier = readonly [RegExp, number] | readonly [RegExp, number, number] | readonly [RegExp, number, number, number]
    | readonly [RegExp, number, number, number, DistanceTierKind] | readonly [RegExp, number, number, number, DistanceTierKind, FogTierClass];
/** FOG HORIZON (docs/specs/fog-horizon.md): the optional SIXTH element of a draw tier, its family's class for "Buildings
 *  only in fog". 'building' = part of the silhouette (always drawn past the fog's Far; ground surfaces count here,
 *  so the fogged ground stays continuous) · 'attachment' = on a building (signs, awnings, facade trim, rooftop
 *  equipment; drawn in the fog only with "Include signs, awnings & rooftop equipment") · 'other' = everything else
 *  (culled at Far). Absent = 'building' (a tier added without a class is never culled; a test keeps the city's tiers
 *  explicit). Mesh3D.fogClass carries it as 0 / 1 / 2. */
export type FogTierClass = 'building' | 'attachment' | 'other' | 'overlay';
/** Untiered layers the fog-horizon classifies by name (layers no draw tier claims, e.g. the lit shop signs). */
export type FogExtraClass = readonly [RegExp, FogTierClass];
/** A draw tier's fog class ('building' when it has none). */
export function distanceTierFogClass(t: DistanceTier): FogTierClass {
    return t.length > 5 ? (t as readonly [RegExp, number, number, number, DistanceTierKind, FogTierClass])[5] : 'building';
}
const FOG_CLASS_CODE: Record<FogTierClass, 0 | 1 | 2> = { building: 0, attachment: 1, other: 2, overlay: 2 };
/** Step 3: 'overlay' = class 2 without the fade (Mesh3D.fogNoFade): culled past Far, but fogged like the surface under
 *  it inside the band (road paint / wear / gutters / storefronts). */
const FOG_NO_FADE: Record<FogTierClass, boolean> = { building: false, attachment: false, other: false, overlay: true };
/** P9: the optional FIFTH element of a tier, its KIND. 'draw' (or absent) = a draw distance as above. 'twin' = the
 *  NEAR/FAR TWIN swap distance of the twin meshes whose names match (Mesh3D.lodTwinDist, world units, no aerial bias;
 *  the bias / shadow elements are unused) and 'twin2' = the second swap of a three-tier family (lodTwinDist2: the
 *  static crowd's mid → xfar). Twin tiers are matched separately from the draw tiers (first match per kind), so a name
 *  carries both a draw distance and its swap distances; every draw-tier helper below skips them. */
export type DistanceTierKind = 'draw' | 'twin' | 'twin2';
/** A tier's kind ('draw' when it has none). */
export function distanceTierKind(t: DistanceTier): DistanceTierKind {
    return t.length > 4 ? (t as readonly [RegExp, number, number, number, DistanceTierKind])[4] : 'draw';
}

/** The P8 shadow feature size for a node name (the first matching tier's fourth element, default 0). */
export function cityShadowFeatureSize(name: string, tiers: readonly DistanceTier[]): number {
    const t = cityDistanceTier(name, tiers);
    return t && t.length > 3 ? (t as readonly [RegExp, number, number, number])[3] : 0;
}

/** The draw distance for a node name: the FIRST matching tier's distance, or 0 (no limit). */
export function cityDrawDistance(name: string, tiers: readonly DistanceTier[]): number {
    const t = cityDistanceTier(name, tiers);
    return t ? t[1] : 0;
}

/** The FIRST matching tier of `kind` (default: the draw tiers) for a node name (or undefined). */
function cityDistanceTier(name: string, tiers: readonly DistanceTier[], kind: DistanceTierKind = 'draw'): DistanceTier | undefined {
    if (STREAM_HITCH.lodStampMemo) return memoTier(name, tiers, kind);
    return scanTier(name, tiers, kind);
}
function scanTier(name: string, tiers: readonly DistanceTier[], kind: DistanceTierKind): DistanceTier | undefined {
    for (const t of tiers) if (distanceTierKind(t) === kind && t[0].test(name)) return t;
    return undefined;
}
// P16 lodStampMemo (stream-hitch.ts): the tier a name maps to depends only on the name and the tier list (the regexes
// are stateless: a list with a global / sticky regex is never memoised), so it is looked up once per (list, kind,
// name). Streamed tiles repeat a few thousand names; the per-node regex scans were most of a tile's LOD stamp. A list
// is a fresh array whenever the thresholds change, so a stale entry can never be read. Bounded per list.
const TIER_MEMO_MAX = 50_000;
const tierMemo = new WeakMap<readonly DistanceTier[], Map<string, DistanceTier | null> | null>();
const tierMemoKind = new WeakMap<readonly DistanceTier[], Record<string, Map<string, DistanceTier | null>>>();
function memoTier(name: string, tiers: readonly DistanceTier[], kind: DistanceTierKind): DistanceTier | undefined {
    let ok = tierMemo.get(tiers);
    if (ok === undefined) { ok = tiers.every((t) => !t[0].global && !t[0].sticky) ? new Map() : null; tierMemo.set(tiers, ok); }
    if (ok === null) return scanTier(name, tiers, kind);
    let byKind = tierMemoKind.get(tiers);
    if (!byKind) { byKind = {}; tierMemoKind.set(tiers, byKind); }
    let m = byKind[kind];
    if (!m) m = byKind[kind] = new Map();
    const hit = m.get(name);
    if (hit !== undefined) { streamHitchStats.memoHits++; return hit ?? undefined; }
    streamHitchStats.memoMisses++;
    const t = scanTier(name, tiers, kind);
    if (m.size >= TIER_MEMO_MAX) m.clear();
    m.set(name, t ?? null);
    return t;
}
/** P16: the fog-extra class index for a name (-1 = none), memoised per extras list like the tiers. */
const extraMemo = new WeakMap<readonly FogExtraClass[], Map<string, number>>();
function fogExtraIndex(name: string, extras: readonly FogExtraClass[]): number {
    if (!STREAM_HITCH.lodStampMemo || extras.some(([re]) => re.global || re.sticky)) { for (let i = 0; i < extras.length; i++) if (extras[i][0].test(name)) return i; return -1; }
    let m = extraMemo.get(extras);
    if (!m) { m = new Map(); extraMemo.set(extras, m); }
    let i = m.get(name);
    if (i === undefined) {
        i = -1;
        for (let k = 0; k < extras.length; k++) if (extras[k][0].test(name)) { i = k; break; }
        if (m.size >= TIER_MEMO_MAX) m.clear();
        m.set(name, i);
    }
    return i;
}

/** P9: the twin swap distance of `kind` for a mesh name, or 0 (no matching tier: keep the builder's own). */
export function cityTwinDistance(name: string, tiers: readonly DistanceTier[], kind: 'twin' | 'twin2'): number {
    const t = cityDistanceTier(name, tiers, kind);
    return t ? t[1] : 0;
}

/** The aerial-bias fraction for a node name (the first matching tier's third element, default 1). */
export function cityDrawDistanceBias(name: string, tiers: readonly DistanceTier[]): number {
    const t = cityDistanceTier(name, tiers);
    return t && t.length > 2 ? (t as readonly [RegExp, number, number])[2] : 1;
}

type DrawDistanceNode = { name: string; children?: unknown[]; drawDistance?: number; drawDistanceBias?: number; shadowFeatureSize?: number; lodTwinRole?: number; lodTwinDist?: number; lodTwinDist2?: number; fogClass?: number; fogNoFade?: boolean; materialDirty?: boolean };
/** The fog-horizon classification input of assignDrawDistances: the class tiers (any list with the city's regexes in
 *  order; their distances are ignored) and the untiered extras. */
export interface FogClassify { tiers: readonly DistanceTier[]; extras: readonly FogExtraClass[] }
/**
 * Stamp `drawDistance` on every mesh under `root` (the renderer's per-mesh distance LOD — Mesh3D.drawDistance).
 * Mirrors the zoom-tier walk: the FIRST node whose name matches a tier claims its whole subtree (the tier regexes
 * match layer groups as well as meshes); everything outside a tier gets 0. Runs only when the scene or the thresholds
 * change (never per frame). Returns the number of meshes given a non-zero distance.
 */
export function assignDrawDistances(roots: readonly unknown[], tiers: readonly DistanceTier[], fog?: FogClassify): number {
    let n = 0;
    // fc / fcFrom: the fog class inherited down the tree and where it came from (0 none, 1 an untiered extra, 2 a
    // draw tier). A draw-tier match claims the subtree like the distance does; an extra holds until a tier claims.
    const stack: Array<{ node: DrawDistanceNode; far: number; bias: number; shadow: number; fc: 0 | 1 | 2; fcFrom: 0 | 1 | 2; nf: boolean }> = [];
    for (const r of roots) stack.push({ node: r as DrawDistanceNode, far: -1, bias: 1, shadow: 0, fc: 0, fcFrom: 0, nf: false });
    while (stack.length) {
        const { node, far: inherited, bias: inheritedBias, shadow: inheritedShadow, fc: inheritedFc, fcFrom: inheritedFrom, nf: inheritedNf } = stack.pop()!;
        let far = inherited, bias = inheritedBias, shadow = inheritedShadow, fc = inheritedFc, fcFrom = inheritedFrom, nf = inheritedNf;
        if (fog && fcFrom !== 2) {
            const nm = node.name ?? '';
            const ft = cityDistanceTier(nm, fog.tiers);
            if (ft) { const c = distanceTierFogClass(ft); fc = FOG_CLASS_CODE[c]; nf = FOG_NO_FADE[c]; fcFrom = 2; }
            else if (fcFrom === 0) { const xi = fogExtraIndex(nm, fog.extras); if (xi >= 0) { const c = fog.extras[xi][1]; fc = FOG_CLASS_CODE[c]; nf = FOG_NO_FADE[c]; fcFrom = 1; } }
        }
        if (fog && typeof node.fogClass === 'number' && node.fogClass !== fc) {
            node.fogClass = fc;
            // the GPU slot's flags2 (the fade-band bits) derive from the class: a material-only slot rewrite
            if (typeof node.materialDirty === 'boolean') node.materialDirty = true;
        }
        if (fog && typeof node.fogNoFade === 'boolean' && node.fogNoFade !== nf) {
            node.fogNoFade = nf;
            if (typeof node.materialDirty === 'boolean') node.materialDirty = true;
        }
        if (inherited < 0) {
            const t = cityDistanceTier(node.name ?? '', tiers);
            far = t && t[1] > 0 ? t[1] : -1;
            bias = t && t.length > 2 ? (t as readonly [RegExp, number, number])[2] : 1;
            shadow = t && t.length > 3 ? (t as readonly [RegExp, number, number, number])[3] : 0;
        }
        if (typeof node.drawDistance === 'number') {
            const d = far > 0 ? far : 0;
            node.drawDistance = d;
            if (typeof node.drawDistanceBias === 'number') node.drawDistanceBias = d > 0 ? bias : 1;
            if (typeof node.shadowFeatureSize === 'number') node.shadowFeatureSize = d > 0 ? shadow : 0;
            if (d > 0) n++;
        }
        // P9: twin meshes take their swap distances from the 'twin' / 'twin2' tiers (by the mesh's own name; no
        // matching tier = keep the distance the builder baked in).
        if (node.lodTwinRole) {
            const t1 = cityTwinDistance(node.name ?? '', tiers, 'twin'), t2 = cityTwinDistance(node.name ?? '', tiers, 'twin2');
            if (t1 > 0) node.lodTwinDist = t1;
            if (t2 > 0 && (node.lodTwinRole === 3 || node.lodTwinRole === 4)) node.lodTwinDist2 = t2;
        }
        if (node.children) for (const k of node.children) stack.push({ node: k as DrawDistanceNode, far, bias, shadow, fc, fcFrom, nf });
    }
    return n;
}
