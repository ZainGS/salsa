/**
 * Scene3DKitbash — GLB kitbash library + character ASSEMBLY (audit C5; the 13th scene3d-manager
 * extraction, same ManagerContext + narrow-host pattern as its siblings).
 *
 * OWNS: the kitbash part library, the assembled-character registry (create/swap/recolor/remove +
 * save/restore states), the baked-part store (garments/hair baked to GLB parts), and the spawn-spin
 * animation. Method bodies are moved VERBATIM from scene3d-manager (which keeps its public names as
 * one-line delegators).
 *
 * STAYS ON THE MANAGER (reached via the host): the GLB/skeleton assembly helpers shared with the
 * procedural-body path (createSkeletonFromResult / createSkinnedMeshForSlot), the shared _modelStore,
 * the undo manager, the picker + renderer (cache eviction on character delete). playSpawnReveal also
 * stays — it belongs to the ghost-preview machinery and calls playSpawnSpin through the delegator.
 */

import type { ManagerContext } from './manager-context';
import { KitbashLibrary } from './kitbash-library';
import type { CharacterSlot, CharacterDefinition, CharacterData, KitbashPartMeta } from '../../types/kitbash-3d';
import { parseSkinnedGLB } from '../../renderer/3d/gltf-importer';
import type { GltfSkinnedResult } from '../../renderer/3d/gltf-importer';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import type { Command3D } from './undo-manager-3d';
import type { MeshPicker } from '../../renderer/3d/mesh-picker';
import type { Renderer3D } from '../../renderer/3d/renderer-3d';

export interface Scene3DKitbashHost {
    getMesh(id: string): Mesh3D | null;
    getSkeleton(id: string): Skeleton3D | null;
    /** Shared with the procedural-body path — the implementations stay on the manager. */
    createSkeletonFromResult(result: GltfSkinnedResult): Promise<Skeleton3D>;
    createSkinnedMeshForSlot(
        result: GltfSkinnedResult, skeleton: Skeleton3D,
        ox: number, oy: number, oz: number,
        def: CharacterDefinition, slot: CharacterSlot,
    ): Promise<SkinnedMesh3D>;
    /** The manager-owned GLB byte store (character restore + export read it too). */
    getModelStore(): Map<string, ArrayBuffer>;
    pushUndo(cmd: Command3D): void;
    getPicker(): MeshPicker;
    getRenderer3D(): Renderer3D;
}

export class Scene3DKitbash {
    private readonly _kitbashLibrary = new KitbashLibrary();
    private _characterMap = new Map<string, CharacterData>();

    constructor(private readonly ctx: ManagerContext, private readonly host: Scene3DKitbashHost) {}

    private getMesh(id: string): Mesh3D | null { return this.host.getMesh(id); }
    private getSkeleton(id: string): Skeleton3D | null { return this.host.getSkeleton(id); }

    // ── Kitbash part library ─────────────────────────────────────────

    /**
     * Fetch and parse a kitbash part manifest from the given URL.
     * After loading, parts are available via getKitbashParts().
     */
    async loadKitbashManifest(url: string): Promise<void> {
        await this._kitbashLibrary.loadManifest(url);
    }

    /** Register parts from a pre-parsed array (e.g. from a bundled import). */
    addKitbashParts(parts: KitbashPartMeta[]): void {
        this._kitbashLibrary.addParts(parts);
    }

    /** Return all parts for a given slot, or [] if none are loaded. */
    getKitbashParts(slot: CharacterSlot): KitbashPartMeta[] {
        return this._kitbashLibrary.getPartsBySlot(slot);
    }

    /** Return all slot types that have at least one part loaded. */
    getKitbashSlots(): CharacterSlot[] {
        return this._kitbashLibrary.getAllSlots();
    }

    // ── Character assembly ───────────────────────────────────────────

    /**
     * Assemble a character from a CharacterDefinition. Fetches GLBs for each
     * occupied slot, remaps joint indices to the canonical skeleton from base_body,
     * and places Skeleton3D + SkinnedMesh3D nodes in the scene graph.
     *
     * @returns The stable character ID (same as def.id).
     */
    async createCharacter(
        def: CharacterDefinition,
        ox = 0, oy = 0, oz = 0,
    ): Promise<string> {
        const basePartId = def.slots['base_body'];
        if (!basePartId) throw new Error('CharacterDefinition must have a base_body slot');

        const basePart = this._kitbashLibrary.getPart(basePartId);
        if (!basePart) throw new Error(`Unknown kitbash part: ${basePartId}`);

        // 1. Load + parse base_body GLB to establish the canonical skeleton.
        const baseBuf     = await this._fetchGlbBuffer(basePart.glbUrl);
        const baseResults = await parseSkinnedGLB(baseBuf);
        const baseResult  = baseResults[0];
        if (!baseResult) throw new Error('base_body GLB contained no skinned mesh');

        const skeleton = await this.host.createSkeletonFromResult(baseResult);
        const partMeshIds = new Map<CharacterSlot, string>();

        // 2. Create SkinnedMesh3D for base_body (already uses canonical joints).
        const baseMesh = await this.host.createSkinnedMeshForSlot(
            baseResult, skeleton, ox, oy, oz, def, 'base_body',
        );
        this.ctx.sceneGraph.root.addChild(baseMesh);
        this.host.getModelStore().set(baseMesh.id, baseBuf);
        partMeshIds.set('base_body', baseMesh.id);

        // 3. For each additional slot, fetch GLB, remap joints, create mesh.
        for (const [slot, partId] of Object.entries(def.slots) as [CharacterSlot, string][]) {
            if (slot === 'base_body') continue;
            const partMeta = this._kitbashLibrary.getPart(partId);
            if (!partMeta) { console.warn(`KitbashAssembler: unknown part ${partId} for slot ${slot}`); continue; }

            const partBuf     = await this._fetchGlbBuffer(partMeta.glbUrl);
            const partResults = await parseSkinnedGLB(partBuf);
            const partResult  = partResults[0];
            if (!partResult) { console.warn(`KitbashAssembler: GLB for ${partId} has no skinned mesh`); continue; }

            // Remap JOINTS_0 from part-local indices to canonical skeleton indices.
            this._remapJointIndices(partResult, skeleton);

            const mesh = await this.host.createSkinnedMeshForSlot(
                partResult, skeleton, ox, oy, oz, def, slot,
            );
            this.ctx.sceneGraph.root.addChild(mesh);
            this.host.getModelStore().set(mesh.id, partBuf);
            partMeshIds.set(slot, mesh.id);
        }

        // 4. Apply color tints.
        if (def.skinTone) {
            const baseId = partMeshIds.get('base_body');
            const bm = baseId ? this.getMesh(baseId) : null;
            if (bm) bm.setDiffuseColor(def.skinTone.r / 255, def.skinTone.g / 255, def.skinTone.b / 255, 1);
        }
        if (def.hairColor) {
            const hairId = partMeshIds.get('hair');
            const hm = hairId ? this.getMesh(hairId) : null;
            if (hm) hm.setDiffuseColor(def.hairColor.r / 255, def.hairColor.g / 255, def.hairColor.b / 255, 1);
        }

        // 5. Register the character.
        const charData: CharacterData = {
            id: def.id,
            definition: { ...def, slots: { ...def.slots } },
            skeletonId: skeleton.id,
            partMeshIds,
        };
        this._characterMap.set(charData.id, charData);

        this.host.pushUndo({
            description: 'Create character',
            undo: () => { this._destroyCharacterNodes(charData); this._characterMap.delete(charData.id); this.ctx.emitSceneGraphChanged(); },
            redo: () => { /* re-adding is async — not supported inline; re-create via createCharacter */ },
        });

        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return charData.id;
    }

    /**
     * Swap one slot on a live character. Removes the old mesh, loads the new
     * part GLB, remaps joints, and attaches the new mesh.
     */
    async swapCharacterSlot(charId: string, slot: CharacterSlot, partId: string): Promise<void> {
        const charData = this._characterMap.get(charId);
        if (!charData) return;

        const partMeta = this._kitbashLibrary.getPart(partId);
        if (!partMeta) throw new Error(`Unknown kitbash part: ${partId}`);

        const skeleton = this.getSkeleton(charData.skeletonId);
        if (!skeleton) throw new Error(`Skeleton ${charData.skeletonId} not found`);

        // Remove the old mesh for this slot.
        const oldMeshId = charData.partMeshIds.get(slot);
        if (oldMeshId) {
            const oldMesh = this.getMesh(oldMeshId);
            if (oldMesh) {
                oldMesh.parent?.removeChild(oldMesh);
                this.host.getModelStore().delete(oldMeshId);
            }
            charData.partMeshIds.delete(slot);
        }

        // Load and attach the new part.
        const partBuf     = await this._fetchGlbBuffer(partMeta.glbUrl);
        const partResults = await parseSkinnedGLB(partBuf);
        const partResult  = partResults[0];
        if (!partResult) { console.warn(`KitbashAssembler: GLB for ${partId} has no skinned mesh`); return; }

        this._remapJointIndices(partResult, skeleton);
        const mesh = await this.host.createSkinnedMeshForSlot(
            partResult, skeleton,
            charData.definition.slots[slot] !== undefined ? 0 : 0, 0, 0,
            charData.definition, slot,
        );
        this.ctx.sceneGraph.root.addChild(mesh);
        this.host.getModelStore().set(mesh.id, partBuf);

        charData.partMeshIds.set(slot, mesh.id);
        charData.definition.slots[slot] = partId;

        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Apply a diffuse color tint to one slot's mesh. */
    setCharacterSlotColor(charId: string, slot: CharacterSlot, r: number, g: number, b: number): void {
        const charData = this._characterMap.get(charId);
        if (!charData) return;
        const meshId = charData.partMeshIds.get(slot);
        if (!meshId) return;
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        mesh.setDiffuseColor(r / 255, g / 255, b / 255, 1);
        this.ctx.scheduleRender();
    }

    /** Remove a character and all its skeleton + part meshes from the scene. */
    removeCharacter(charId: string): void {
        const charData = this._characterMap.get(charId);
        if (!charData) return;
        this._destroyCharacterNodes(charData);
        this._characterMap.delete(charId);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Get the CharacterData for a given character ID, or null. */
    getCharacter(charId: string): CharacterData | null {
        return this._characterMap.get(charId) ?? null;
    }

    /** Get all assembled characters in the scene. */
    getAllCharacters(): CharacterData[] {
        return [...this._characterMap.values()];
    }

    // ── Character serialization ───────────────────────────────────────

    /** Drop the assembled-character catalog + the baked-part byte store before a document restore (audit P6) — neither
     *  was ever cleared, so an older doc without them kept the previous doc's entries (and saved them back). */
    clearForDocumentLoad(): void {
        this._characterMap.clear();
        for (const { meta } of this._bakedParts.values()) {
            if (meta.glbUrl?.startsWith('blob:')) { try { URL.revokeObjectURL(meta.glbUrl); } catch { /* already revoked */ } }
        }
        this._bakedParts.clear();
    }

    /** Serialize all assembled characters for project save. */
    getScene3DCharacterStates(): any[] {
        return [...this._characterMap.values()].map(c => ({
            id:         c.id,
            definition: c.definition,
            skeletonId: c.skeletonId,
            partMeshIds: Object.fromEntries(c.partMeshIds),
        }));
    }

    /**
     * Restore character catalog entries from serialized states.
     * Call AFTER restoring meshes and skeletons so the referenced node IDs exist.
     */
    restoreCharacterStates(states: any[]): void {
        this._characterMap.clear();
        for (const s of states) {
            const partMeshIds = new Map<CharacterSlot, string>(
                Object.entries(s.partMeshIds ?? {}) as [CharacterSlot, string][],
            );
            this._characterMap.set(s.id, {
                id:         s.id,
                definition: s.definition,
                skeletonId: s.skeletonId,
                partMeshIds,
            });
        }
    }

    // ── Baked parts (garments/hair baked to GLB kitbash parts) ────────

    /** In-memory store of baked parts (meta + GLB blob) so they can be persisted with the document. */
    private _bakedParts = new Map<string, { meta: KitbashPartMeta; blob: Blob }>();

    /** Register a baked GLB blob as a kitbash part AND remember its bytes so it survives reload.
     *  (Public: the manager's bakeClothingToPart / bakeHairToPart call this.) */
    registerBakedPart(id: string, slot: CharacterSlot, name: string, blob: Blob): string {
        const meta: KitbashPartMeta = {
            id, slot, name, thumbnail: '', glbUrl: URL.createObjectURL(blob), tags: ['generated'], styleSet: 'generated',
        };
        this.addKitbashParts([meta]);
        this._bakedParts.set(id, { meta, blob });
        return id;
    }

    /** Baked-part metadata for the document (the GLB bytes ride separately via getBakedPartBuffers). */
    serializeBakedParts(): KitbashPartMeta[] {
        return [...this._bakedParts.values()].map(b => ({ ...b.meta }));
    }

    /** Baked-part GLB bytes keyed by part id (written into the document package like models3d). */
    async getBakedPartBuffers(): Promise<Record<string, ArrayBuffer>> {
        const out: Record<string, ArrayBuffer> = {};
        for (const [id, b] of this._bakedParts) out[id] = await b.blob.arrayBuffer();
        return out;
    }

    /** Re-register baked parts on load from the persisted metadata + bytes (fresh object URL each). */
    restoreBakedParts(metas: KitbashPartMeta[] | undefined, buffers: Record<string, ArrayBuffer> | undefined): void {
        if (!metas?.length) return;
        for (const meta of metas) {
            const buf = buffers?.[meta.id];
            if (!buf) continue;
            const blob = new Blob([buf], { type: 'model/gltf-binary' });
            const m: KitbashPartMeta = { ...meta, glbUrl: URL.createObjectURL(blob) };
            this.addKitbashParts([m]);
            this._bakedParts.set(meta.id, { meta: m, blob });
        }
    }

    // ── Spawn spin (the character spins in + decelerates to face front on Generate) ──

    private _spawnSpins = new Map<string, { t0: number; dur: number; startAngle: number; baseRx: number; baseRy: number; baseRz: number }>();
    /** Exposed for the manager's full-character-deletion sweep, which drops/restores per-body animation
     *  state across every subsystem map (deleteFullCharacter3D's capture closures). */
    get spawnSpins(): Map<string, { t0: number; dur: number; startAngle: number; baseRx: number; baseRy: number; baseRz: number }> { return this._spawnSpins; }
    private _spawnSpinCallback: (() => boolean) | null = null;
    private _spawnHeldLive = false;

    /**
     * Play a SPAWN SPIN on a just-created character: it spins around `turns` times and eases (cubic ease-out)
     * to a stop facing front. The whole character rides the body's transform (synced to the skeleton object
     * transform), so one Y-rotation spins everything. Call right after the user clicks Generate. Runtime-only.
     */
    playSpawnSpin(bodyMeshId: string, opts?: { turns?: number; durationSec?: number }): void {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D)) return;
        this._spawnSpins.set(bodyMeshId, {
            t0: performance.now(), dur: (opts?.durationSec ?? 1.2) * 1000,
            startAngle: (opts?.turns ?? 1.25) * Math.PI * 2,   // lands facing front regardless (the added angle decays to 0)
            baseRx: body.rotationX, baseRy: body.rotationY, baseRz: body.rotation,
        });
        this._ensureSpawnSpinCallback();
        if (!this._spawnHeldLive && !this.ctx.webgpuRenderer.isLive) { this.ctx.webgpuRenderer.play(); this._spawnHeldLive = true; }
        this.ctx.scheduleRender();
    }

    private _ensureSpawnSpinCallback(): void {
        if (!this._spawnSpinCallback) {
            this._spawnSpinCallback = () => {
                if (this._spawnSpins.size === 0) return false;
                const now = performance.now();
                let active = false;
                for (const [meshId, s] of this._spawnSpins) {
                    const body = this.getMesh(meshId);
                    if (!(body instanceof SkinnedMesh3D)) { this._spawnSpins.delete(meshId); continue; }
                    const p = Math.min(1, (now - s.t0) / s.dur);
                    const angle = s.startAngle * (1 - (1 - Math.pow(1 - p, 3)));   // cubic ease-out, decays startAngle → 0
                    body.setRotation3D(s.baseRx, s.baseRy + angle, s.baseRz);
                    if (p >= 1) this._spawnSpins.delete(meshId); else active = true;
                }
                if (this._spawnSpins.size === 0 && this._spawnHeldLive) { this.ctx.webgpuRenderer.pause(); this._spawnHeldLive = false; }
                return active;
            };
        }
        this.ctx.webgpuRenderer.addPreRenderCallback(this._spawnSpinCallback);
    }

    // ── Private assembly helpers (kitbash-only; the shared ones live on the manager) ──

    private async _fetchGlbBuffer(url: string): Promise<ArrayBuffer> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`KitbashAssembler: failed to fetch ${url} (${res.status})`);
        return res.arrayBuffer();
    }

    /**
     * Remap a part mesh's JOINTS_0 indices from its local joint array to the
     * canonical skeleton's joint array, matching by joint name.
     */
    private _remapJointIndices(
        partResult: GltfSkinnedResult,
        canonicalSkeleton: Skeleton3D,
    ): void {
        const partNames = partResult.skinning.jointNames;
        const remap     = new Uint8Array(partNames.length);
        for (let i = 0; i < partNames.length; i++) {
            const canonIdx = canonicalSkeleton.data.joints.findIndex(j => j.name === partNames[i]);
            remap[i] = canonIdx >= 0 ? canonIdx : 0;
        }
        const indices = partResult.skinning.jointIndices;
        for (let v = 0; v < indices.length; v++) {
            indices[v] = remap[indices[v]];
        }
    }

    private _destroyCharacterNodes(charData: CharacterData): void {
        for (const meshId of charData.partMeshIds.values()) {
            const m = this.getMesh(meshId);
            if (m) {
                m.parent?.removeChild(m); this.host.getModelStore().delete(meshId);
                // Free picker BVH + renderer per-mesh caches (incl. skinned GPU buffers) — was leaking on every
                // kitbash character delete.
                this.host.getPicker().evictMesh(meshId); this.host.getRenderer3D().evictMeshCaches([meshId]);
            }
        }
        const skel = this.getSkeleton(charData.skeletonId);
        if (skel) skel.parent?.removeChild(skel);
    }
}
