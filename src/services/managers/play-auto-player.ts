/**
 * Play-mode AUTO DEFAULT PLAYER (polish-round-3 T5.2 + Round 4): in THIRD-person Play with no Player set, the engine
 * spawns a default animated character so there is something to follow. Round 4: it is a DRESSED seeded random
 * character (character-randomizer.ts: body + face/eyes + hair + top/bottom/shoes/socks), not a bare body, and in a
 * city it is scaled to real human size (acquire's `height`). It is a RUNTIME object:
 *
 *  - never saved: EVERY part (body, skeleton, face decal, hair, garments) is flagged `excludeFromDocument` (both node
 *    save paths + the skeleton save skip them; the scene-graph document JSON drops them by id), and the body is marked
 *    RUNTIME in the character subsystem (host.markRuntimeBody), so its face/hair/clothing/body-param rigs stay live for
 *    rendering but every serialize* skips them (and a document load keeps them for the cache);
 *  - not in undo (the generator path pushes no undo) and hidden from the outliner hierarchy (`isRuntimeNode`);
 *  - removed on Stop, but CACHED (detached, not destroyed) so the next Play re-attaches it instantly instead of
 *    regenerating. The cache is document-independent (it is never in a document).
 *
 * This class owns the spawn / cache / release lifecycle; Scene3DManager's Play loop binds the returned mesh as the
 * driven avatar (without touching the user's persisted player binding).
 */

import type { Node } from '../../scene-graph/shapes/base/node';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import type { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { LocomotionClips } from '../../game/locomotion';
import { buildLocomotionClips, JUMP_VARIANT_CLIPS } from './default-locomotion';
import { STREAM_HITCH } from '../../renderer/3d/stream-hitch';

/** A spawned default character: the driven body mesh, its skeleton, and every overlay part riding that skeleton. */
export interface AutoPlayerBody { mesh: Mesh3D; skeleton: Skeleton3D; parts: Mesh3D[] }

export interface AutoPlayerHost {
    /** Generate the default character at (x, y, z), added to the scene: body mesh + skeleton + overlay parts (face
     *  decal, hair, garments: flat siblings under root, skinned to the same skeleton). */
    createBody(x: number, y: number, z: number): Promise<{ mesh: Mesh3D; skeleton: Skeleton3D; parts?: Mesh3D[] } | null>;
    /** Mark the body RUNTIME-ONLY in the character registries (its rigs stay live but are never serialized). */
    markRuntimeBody(meshId: string): void;
    /** Re-add a cached node to the scene root. */
    attach(node: Node): void;
    /** Remove a node from the scene graph (kept alive by the cache). */
    detach(node: Node): void;
}

/** The auto player's locomotion slots (Round 8: + sneak / crouch idle / jump by air phase / long fall / additive land;
 *  item 13: the idle is the runtime "Stand" — breathing, weight shift, a glance — instead of the torso-only Breathe). */
export const AUTO_PLAYER_CLIPS: LocomotionClips = {
    idle: 'Stand', walk: 'Walk', run: 'Run', sneak: 'Sneak', crouch: 'Crouch', jump: 'Jump', fall: 'Fall', land: 'Land',
    // 2026-10-03: jump variety (one variant picked per jump) + the stroll below the walk speed.
    jumps: [...JUMP_VARIANT_CLIPS], stroll: 'Stroll',
    // 2026-10-04: the jog between the walk and the run (walk → jog → run by speed).
    jog: 'Jog',
};
/** Seed of the default character's look (character-randomizer), fixed so every Play shows the same person. */
export const AUTO_PLAYER_SEED = 20260930;
/** Real-world standing height (metres) the default character is scaled to when the scene has a metre scale (a city). */
export const AUTO_PLAYER_HEIGHT_M = 1.7;

export class PlayAutoPlayer {
    private _cached: AutoPlayerBody | null = null;
    /** The body's natural (generated) standing height + authored scale: the reference for acquire's `height`. */
    private _natural: { height: number; sx: number; sy: number; sz: number } | null = null;
    private _live = false;
    private _token = 0;
    private _creating: Promise<AutoPlayerBody | null> | null = null;

    constructor(private readonly host: AutoPlayerHost) {}

    /** Whether Play should spawn the auto player: third-person, no user Player, and the setting on. */
    static shouldSpawn(o: { enabled: boolean; cameraMode: 'first' | 'third'; hasPlayer: boolean }): boolean {
        return o.enabled && o.cameraMode === 'third' && !o.hasPlayer;
    }

    /** The live (in-scene) auto player's mesh id, or null. */
    get meshId(): string | null { return this._live && this._cached ? this._cached.mesh.id : null; }
    get skeletonId(): string | null { return this._live && this._cached ? this._cached.skeleton.id : null; }
    /** True while the auto player is in the scene graph. */
    get isLive(): boolean { return this._live; }
    /** Whether a body is cached (for tests / diagnostics). */
    get isCached(): boolean { return this._cached !== null; }

    /** A node that belongs to the auto player (hide it from the outliner, skip it in saves). */
    isRuntimeNode(id: string): boolean {
        const c = this._cached;
        if (!c) return false;
        if (c.mesh.id === id || c.skeleton.id === id) return true;
        // P16 (STREAM_HITCH.snapshotMeshVersion): the Play collision snapshot asks this for every scene mesh on every
        // sync; a linear scan of the parts per call was ~half of the sync. Same answer from a Set, rebuilt when the
        // cached body or its parts array changes.
        if (!STREAM_HITCH.snapshotMeshVersion) return c.parts.some((p) => p.id === id);
        if (this._partIdsFor !== c.parts || this._partIdsLen !== c.parts.length) {
            this._partIds = new Set(c.parts.map((p) => p.id)); this._partIdsFor = c.parts; this._partIdsLen = c.parts.length;
        }
        return this._partIds.has(id);
    }
    private _partIds = new Set<string>();
    private _partIdsFor: unknown = null;
    private _partIdsLen = -1;
    /** Every node id of the (cached) default character: body, skeleton, parts. Empty when nothing is cached. */
    runtimeNodeIds(): string[] {
        const c = this._cached;
        return c ? [c.mesh.id, c.skeleton.id, ...c.parts.map((p) => p.id)] : [];
    }

    /** Put the auto player in the scene at (x, y, z), re-attaching the cached body or generating one the first time.
     *  `opts.height` (world units) scales the whole character (the skeleton follows the body's transform and every
     *  part rides the skeleton) so its standing height is that; a city passes 1.7 m / metresPerUnit. Omitted = the
     *  generated size. Resolves null if released (Stop) before it was ready; the body is then kept cached but out of
     *  the scene. */
    async acquire(x: number, y: number, z: number, opts?: { height?: number }): Promise<AutoPlayerBody | null> {
        const token = ++this._token;
        let body = this._cached;
        if (!body) {
            this._creating ??= this._create(x, y, z).finally(() => { this._creating = null; });
            body = await this._creating;
            if (!body) return null;
        } else {
            await Promise.resolve();   // keep acquire uniformly async (callers bind after it resolves)
        }
        if (token !== this._token) { this._detach(body); return null; }   // Stop / re-acquire happened meanwhile
        if (!this._live) {
            if (!body.mesh.parent) this.host.attach(body.mesh);
            if (!body.skeleton.parent) this.host.attach(body.skeleton);
            for (const p of body.parts) if (!p.parent) this.host.attach(p);
            this._live = true;
        }
        body.mesh.visible = true;
        this._applyHeight(body.mesh, opts?.height);
        body.mesh.setPosition3D(x, y, z);
        return body;
    }

    /** Take the auto player out of the scene (Stop). Keeps it cached for the next Play. Safe to call anytime. */
    release(): void {
        this._token++;
        if (this._cached) this._detach(this._cached);
    }

    /** Drop the cache entirely (e.g. GPU device reset). Detaches first. */
    dispose(): void {
        this.release();
        this._cached = null;
    }

    /** Uniform scale factor acquire applies for a target height (1 = generated size / nothing measured). */
    scaleForHeight(height: number | undefined): number {
        const n = this._natural;
        if (!n || !(height !== undefined && Number.isFinite(height) && height > 0)) return 1;
        return height / n.height;
    }

    private _applyHeight(mesh: Mesh3D, height: number | undefined): void {
        const n = this._natural;
        if (!n) return;
        const k = this.scaleForHeight(height);
        if (mesh.scaleX !== n.sx * k || mesh.scaleY !== n.sy * k || mesh.scaleZ !== n.sz * k) mesh.setScale3D(n.sx * k, n.sy * k, n.sz * k);
    }

    private _detach(body: AutoPlayerBody): void {
        for (const p of body.parts) if (p.parent) this.host.detach(p);
        if (body.mesh.parent) this.host.detach(body.mesh);
        if (body.skeleton.parent) this.host.detach(body.skeleton);
        this._live = false;
    }

    private async _create(x: number, y: number, z: number): Promise<AutoPlayerBody | null> {
        let made: { mesh: Mesh3D; skeleton: Skeleton3D; parts?: Mesh3D[] } | null = null;
        try { made = await this.host.createBody(x, y, z); }
        catch (e) { console.warn('[Play] auto default player: body generation failed', e); return null; }
        if (!made) return null;
        const { mesh, skeleton } = made;
        const parts = (made.parts ?? []).filter((p) => !!p && p !== mesh);
        mesh.name = 'Default Player';
        // Runtime-only: never serialized, never frames the scene, never selectable. EVERY part, not just the body:
        // the node save paths also skip the overlay flags (isHair/isClothing/isFaceDecal), but excludeFromDocument is
        // the one flag every save path agrees on.
        for (const m of [mesh, ...parts]) { m.excludeFromDocument = true; m.frameExclude = true; m.pickable = false; }
        skeleton.excludeFromDocument = true;
        this.host.markRuntimeBody(mesh.id);
        // Gait clips (the default set only has idles). Replace any same-named clip so a re-install stays single.
        const clips = (skeleton.data.clips ??= []);
        for (const c of buildLocomotionClips(skeleton.data.joints)) {
            const i = clips.findIndex((k) => k.name === c.name);
            if (i >= 0) clips[i] = c; else clips.push(c);
        }
        // Natural standing height (bind-pose world bbox) at the generated scale; acquire's `height` scales from it.
        const corners = mesh.obbCorners;
        if (corners && corners.length) {
            let lo = Infinity, hi = -Infinity;
            for (const c of corners) { if (c[1] < lo) lo = c[1]; if (c[1] > hi) hi = c[1]; }
            if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) this._natural = { height: hi - lo, sx: mesh.scaleX, sy: mesh.scaleY, sz: mesh.scaleZ };
        }
        const body: AutoPlayerBody = { mesh, skeleton, parts };
        this._cached = body;
        this._live = !!mesh.parent;
        return body;
    }
}

/** Remove runtime-only nodes (by id) from a serialized scene-graph tree, at any depth, in place. Used by the
 *  document scene-graph JSON (ShapeManager.getSceneGraphJSONForDocument) so a save that lands mid-Play never
 *  carries the auto default player. Returns the number of nodes dropped. */
export function dropRuntimeNodesFromSceneJSON(node: { children?: unknown[] } | null | undefined, ids: ReadonlySet<string>): number {
    if (!node || ids.size === 0 || !Array.isArray(node.children)) return 0;
    let dropped = 0;
    node.children = node.children.filter((c) => {
        const keep = !ids.has((c as { id?: string } | null)?.id ?? '');
        if (!keep) dropped++;
        return keep;
    });
    for (const c of node.children) dropped += dropRuntimeNodesFromSceneJSON(c as { children?: unknown[] }, ids);
    return dropped;
}
