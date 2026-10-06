// visual-polish #16: MOVING CONTACT BLOBS — the services half of world/mover-shadows.ts.
//
// The routed walkers, the traffic cars and buses, the train consists and the Play player get the same soft radial blob
// the static crowd and the parked cars stand on (contact-shadows.ts). ONE transparent mesh holds every blob quad (one
// draw call for all movers); each rendered frame (the world LOD pre-render callback) the quads follow their movers'
// CURRENT poses — the movers are posed at the sim-LOD rate (world/sim-lod.ts), so a far / off-screen mover's blob
// moves at its rate too, and a blob whose mover did not move is not rewritten. Only the changed vertex range is
// re-sent (Renderer3D.patchMeshVertices; no pool rebuild). A blob is hidden (collapsed) with its mover (LOD, door
// visit, a dead-end fade at 0), past `maxDistM`, and past the fog horizon (the mover is frozen + fogged there).
//
// The mesh lives under the City container but NOT in WorldManager._groups (the glow / style / contact-strength walks
// never touch it; its opacity is its own). Rebuilt when the traffic respawns (a new mover array); forgotten on a world
// clear (the container goes, and the mesh with it).
import type { WorldManager } from './world-manager';
import type { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { MoverRec } from './world-traffic';
import { cityMetresPerUnit } from '../../world/types';
import { MoverBlobBuffer, moverFootprint, blobHalfExtents, MOVER_BLOB_SKIP, type MoverFootprint, type MoverBlobSize } from '../../world/mover-shadows';
import type { SimLod } from '../../world/sim-lod';
import type { MeshGeometry } from '../../renderer/3d/mesh-generators';

interface BlobSlot {
    /** The mesh whose pose the blob follows (a rigid body mesh of the mover / train car). */
    src: Mesh3D;
    fp: MoverFootprint;
    /** Half-extents at scale 1 (world units). */
    a: number; b: number;
    mover: MoverRec;
}

/** Height above the ground (m) at which the Play player's contact blob has shrunk away (hidden). */
const PLAYER_BLOB_FADE_M = 2.5;
/** Defaults: the static blobs' opacity (contact-shadows.ts, 0.55), so a parked car and a moving one match. */
export const MOVER_SHADOW_DEFAULTS = { on: true, strength: 0.55 } as const;

export class WorldMoverShadows {
    constructor(private readonly w: WorldManager) {}

    on: boolean = MOVER_SHADOW_DEFAULTS.on;
    strength: number = MOVER_SHADOW_DEFAULTS.strength;
    /** Blobs past this camera distance (metres) are hidden (sub-pixel anyway; they would only darken the fog). */
    maxDistM = 180;

    private _group: MeshGroup3D | null = null;
    private _mesh: Mesh3D | null = null;
    private _buf: MoverBlobBuffer | null = null;
    private _slots: BlobSlot[] = [];
    private _builtFor: readonly MoverRec[] | null = null;
    private _builtRadius = -1;
    private _playerSlot = -1;
    private readonly _v = new Float64Array(3);
    readonly stats = { blobs: 0, shown: 0, written: 0, updateMs: 0, updateAvgMs: 0, updateMaxMs: 0, uploads: 0, uploadBytes: 0 };
    resetStats(): void { this.stats.updateMaxMs = 0; this.stats.uploads = 0; this.stats.uploadBytes = 0; }

    /** On / off + blob opacity (0..1). Live. */
    set(on: boolean, strength?: number): void {
        this.on = !!on;
        if (typeof strength === 'number' && Number.isFinite(strength)) this.strength = Math.max(0, Math.min(1, strength));
        if (!this.on || this.strength <= 0.001) { this._remove(); return; }
        if (this._mesh) {
            const op = Math.max(0.001, Math.min(0.999, this.strength));
            if (this._mesh.material.opacity !== op) { this._mesh.material.opacity = op; this._mesh.materialDirty = true; }
        }
        this.w.scene3d.requestRender3D?.();
    }

    /** World cleared: the container (and the blob mesh in it) is gone — forget it. */
    resetOnClear(): void { this._group = null; this._mesh = null; this._buf = null; this._slots = []; this._builtFor = null; this._playerSlot = -1; }

    private _remove(): void {
        if (this._group) { this.w.scene3d.removeFlatColorMeshGroup(this._group, true); this.w.scene3d.notifySceneStructureChanged3D?.(); }
        this.resetOnClear();
        this.stats.blobs = 0; this.stats.shown = 0;
    }

    /** The blob size rules for this city (contact-shadows.ts cityContactShadowOptions, so parked and moving cars match). */
    private _size(radius: number): MoverBlobSize {
        const mpu = cityMetresPerUnit(radius);
        return { spread: 1.45, minBlob: 0.38 / mpu, maxHalf: 3.5 / mpu, lift: 0.035 / mpu };
    }

    /** Which movers ground a blob: routed cars + buses, walkers + cyclists (routed and the shotengai strollers), the rail
     *  consists (one blob per car). Clouds, birds, flyers, fish, weather and boats float. */
    private static _grounded(mv: MoverRec): boolean {
        const k = mv.spec.kind;
        return (k === 'car' && !!mv.spec.route) || k === 'walker' || (k === 'train' && !!mv.spec.run);
    }

    private static _footprintOf(meshes: readonly Mesh3D[]): MoverFootprint | null {
        const parts: { vertices: ArrayLike<number>; stride: number }[] = [];
        for (const m of meshes) {
            if (MOVER_BLOB_SKIP.test(m.name ?? '')) continue;
            const g = m.geometry as MeshGeometry | undefined;
            if (!g || !g.vertices || g.vertices.length === 0) continue;
            const st = g.format === '8float' ? 8 : g.format === '12float' ? 12 : (g.vertices.length % 12 === 0 ? 12 : 8);
            parts.push({ vertices: g.vertices, stride: st });
        }
        return parts.length ? moverFootprint(parts) : null;
    }

    private _build(movers: readonly MoverRec[]): void {
        this._remove();
        this._builtFor = movers;
        const p = this.w.params, root = this.w.cityRoot;
        if (!p || !root) return;
        this._builtRadius = p.radius;
        const size = this._size(p.radius);
        const slots: BlobSlot[] = [];
        for (const mv of movers) {
            if (!WorldMoverShadows._grounded(mv)) continue;
            if (mv.segments?.length) {
                for (const seg of mv.segments) {
                    const body = seg.body?.length ? seg.body : seg.meshes;
                    const fp = WorldMoverShadows._footprintOf(body);
                    if (!fp || !body[0]) continue;
                    const [a, b] = blobHalfExtents(fp, size);
                    slots.push({ src: body[0], fp, a, b, mover: mv });
                }
                continue;
            }
            const body = mv.body.length ? mv.body : mv.meshes;
            const fp = WorldMoverShadows._footprintOf(body);
            const src = body.find(m => !MOVER_BLOB_SKIP.test(m.name ?? ''));
            if (!fp || !src) continue;
            const [a, b] = blobHalfExtents(fp, size);
            slots.push({ src, fp, a, b, mover: mv });
        }
        // + one slot for the Play player
        const cap = slots.length + 1;
        // Bounds: the city's extent (generously) — the anchors pin the mesh AABB so culling never needs a refresh.
        const R = p.radius * 2.2, gy = p.groundY ?? 0;
        const buf = new MoverBlobBuffer(cap, [-R, gy - p.radius, -R, R, gy + p.radius, R]);
        const layer = {
            name: 'world:mover-shadow', color: [0, 0, 0] as [number, number, number],
            geometry: { vertices: buf.vertices, indices: buf.indices, format: '12float' } as MeshGeometry,
            opacity: Math.max(0.001, Math.min(0.999, this.strength)), radialFade: true, emissive: 0, excludeFromFrame: true,
        };
        const g = this.w.scene3d.addFlatColorMeshGroup('World Mover Shadows', [layer], true, root);
        const m = g.children[0] as Mesh3D | undefined;
        if (!m) { this.w.scene3d.removeFlatColorMeshGroup(g, true); return; }
        m.cheapBounds = true;   // (transparent → never a shadow caster)
        // Never Play collision: the player's own blob follows its feet, so standing on it lifted the player forever
        // (rise bug 2026-10-04; also implied by radialFade — collision-filter.ts — set explicitly so it survives a
        // material change).
        m.noCollide = true;
        this._group = g; this._mesh = m; this._buf = buf; this._slots = slots; this._playerSlot = slots.length;
        this.stats.blobs = slots.length;
        this.w.scene3d.notifySceneStructureChanged3D?.();
    }

    private _simLod(): SimLod | null {
        const l = (this.w.scene3d as unknown as { simLod?: SimLod }).simLod;
        return l && l.enabled ? l : null;
    }

    /** Follow the movers (call once per rendered frame — the world LOD callback). */
    update(): void {
        if (!this.on || this.strength <= 0.001) return;
        const p = this.w.params, root = this.w.cityRoot;
        if (!p || !root) { if (this._group) this.resetOnClear(); return; }
        const movers = this.w._trafficMovers;
        if (movers !== this._builtFor || this._builtRadius !== p.radius || (this._group && this._group.parent !== root)) this._build(movers);
        const buf = this._buf, mesh = this._mesh;
        if (!buf || !mesh) return;
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        const cam = this.w.scene3d.getCamera?.();
        const cm = root.localMatrix as unknown as Float32Array;
        const mpu = cityMetresPerUnit(p.radius), size = this._size(p.radius);
        // camera in city-local space (the container may be placed in an illustration: rigid transform)
        let cx = 0, cy = 0, cz = 0, haveCam = false;
        if (cam) { const cp = cam.position as unknown as ArrayLike<number>; toLocal(cm, cp[0], cp[1], cp[2], this._v); cx = this._v[0]; cy = this._v[1]; cz = this._v[2]; haveCam = cam.mode !== 'orthographic'; }
        const maxD = this.maxDistM / mpu, maxD2 = maxD * maxD;
        const lod = this._simLod();
        let shown = 0, written = 0;
        const S = this._slots;
        for (let i = 0; i < S.length; i++) {
            const sl = S[i], m = sl.src;
            const vis = m.visible && (m.parent as unknown as { visible?: boolean } | null)?.visible !== false && sl.mover.scale > 0.02 && !sl.mover.visiting;
            let show = vis;
            const x = m.x, y = m.y, z = m.z;
            if (show && haveCam) { const dx = x - cx, dy = y - cy, dz = z - cz; if (dx * dx + dy * dy + dz * dz > maxD2) show = false; }
            if (show && lod && lod.view.fogEdge < Infinity) { toWorld(cm, x, y, z, this._v); if (lod.inFog(this._v[0], this._v[1], this._v[2])) show = false; }
            if (!show) { if (buf.hide(i)) written++; continue; }
            const s = m.scaleX;
            if (buf.set(i, x, y + (sl.fp.y0 * s) + size.lift, z, m.rotationY, sl.a * s, sl.b * s, sl.fp.cx * s, sl.fp.cz * s)) written++;
            shown++;
        }
        // the Play player (world feet → city-local)
        const pf = (this.w.scene3d as unknown as { playerFeet3D?: { x: number; y: number; z: number; height: number; groundY?: number } | null }).playerFeet3D;
        if (pf && this._playerSlot >= 0) {
            // The blob stays on the GROUND under the player (it used to ride the feet up every jump) and shrinks with
            // the height above it — a blob shadow reads as "how far up" — hidden past PLAYER_BLOB_FADE_M.
            const gy = pf.groundY !== undefined && Number.isFinite(pf.groundY) ? Math.min(pf.groundY, pf.y) : pf.y;
            toLocal(cm, pf.x, pf.y, pf.z, this._v);
            const feetLocalY = this._v[1];
            toLocal(cm, pf.x, gy, pf.z, this._v);
            const upM = Math.max(0, (feetLocalY - this._v[1]) * mpu);
            const k = 1 - Math.min(1, upM / PLAYER_BLOB_FADE_M);
            if (k <= 0.05) { if (buf.hide(this._playerSlot)) written++; }
            else {
                const r = Math.max(size.minBlob, 0.3 / mpu * 1.45) * (0.45 + 0.55 * k);
                if (buf.set(this._playerSlot, this._v[0], this._v[1] + size.lift, this._v[2], 0, r, r)) written++;
                shown++;
            }
        } else if (this._playerSlot >= 0 && buf.hide(this._playerSlot)) written++;
        const d = buf.takeDirty();
        if (d) {
            if (this.w.scene3d.patchMeshVertices3D?.(mesh, d[0], d[1])) { this.stats.uploads++; this.stats.uploadBytes += d[1] * 48; }
            this.w.scene3d.requestRender3D?.();
        }
        this.stats.shown = shown; this.stats.written = written;
        const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
        this.stats.updateMs = ms; this.stats.updateAvgMs = this.stats.updateAvgMs * 0.95 + ms * 0.05;
        if (ms > this.stats.updateMaxMs) this.stats.updateMaxMs = ms;
    }
}

function toLocal(m: Float32Array, x: number, y: number, z: number, out: Float64Array): void {
    const tx = x - m[12], ty = y - m[13], tz = z - m[14];
    out[0] = m[0] * tx + m[1] * ty + m[2] * tz;
    out[1] = m[4] * tx + m[5] * ty + m[6] * tz;
    out[2] = m[8] * tx + m[9] * ty + m[10] * tz;
}
function toWorld(m: Float32Array, x: number, y: number, z: number, out: Float64Array): void {
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}
