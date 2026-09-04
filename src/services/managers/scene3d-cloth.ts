/**
 * Scene3DCloth — the cloth / banner subsystem, extracted from Scene3DManager (§5.1, the tier-2 move).
 *
 * This is the largest single extraction: it owns FIVE id-keyed maps (geometry cache, live-sim handles, modal
 * preview renderers, stitch-tool transient state, debounce timers) plus the per-frame live-cloth tick, and drives
 * the GPU cloth simulator / solidifier / preview renderer. It depends on `ManagerContext` (scene graph, device,
 * pre-render callbacks, renderer3D) plus a narrow host for the two cross-subsystem lookups it needs: the target
 * Mesh3D and the mesh's FrameLinkAnimation3D (which supplies the 'wind' force during the live tick).
 *
 * Scene3DManager keeps thin delegators for every public method, so callers — and the restore path, which builds a
 * ClothMesh3D itself and calls registerGeometry() + enableLiveCloth() — are unchanged.
 *
 * NOTE: the GPU simulation/preview has no automated test coverage (it needs a real device), so changes here must be
 * browser-verified: create a cloth, Hang/Drape, add/remove stitches, paint bend stiffness, add wind, live-edit.
 */

import type { ManagerContext } from './manager-context';
import type { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { Renderer3D } from '../../renderer/3d/renderer-3d';
import {
    ClothMesh3D, ClothGridConfig, ClothPhysicsConfig, ClothSimState, ClothLiveConfig,
    DEFAULT_CLOTH_PHYSICS, DEFAULT_CLOTH_LIVE, StitchConstraint, WindZone,
} from '../../scene-graph/shapes/cloth-mesh-3d';
import { buildClothGeometry, ClothGeometryResult, buildDefaultActiveCells } from '../../renderer/3d/cloth-geometry-builder';
import { ClothSimulator, DrapeProxy } from '../../renderer/3d/cloth-simulator';
import { createLiveClothSimulation, LiveClothHandle } from '../../renderer/3d/live-cloth-simulation';
import { ClothPreviewRenderer, ClothPreviewOptions } from '../../renderer/3d/cloth-preview-renderer';
import { drapeStartY, resolveClothGeometry } from '../../renderer/3d/cloth-mesh-helpers';
import { FrameLinkAnimation3D, evalFrameLink3D } from '../../types/keyframe-3d';

const _nanoid = () => Math.random().toString(36).slice(2, 10);

/** The cross-subsystem lookups the cloth subsystem needs from the parent manager. */
export interface Scene3DClothHost {
    getMesh(id: string): Mesh3D | null;
    /** The mesh's frame-link animation, if any — a type='wind' anim drives the live sim's wind force. */
    getFrameLinkAnim(id: string): FrameLinkAnimation3D | null;
}

export class Scene3DCloth {
    // Cloth geometry results (keyed by mesh ID) — preserved for re-edit
    private _clothData = new Map<string, ClothGeometryResult>();
    // Live cloth simulation handles (keyed by mesh ID)
    private _liveClothHandles = new Map<string, LiveClothHandle>();
    // Preview canvas renderers for the Cloth Builder modal (keyed by mesh ID)
    private _previewRenderers = new Map<string, ClothPreviewRenderer>();
    // Stitch tool transient state (keyed by mesh ID)
    private _stitchTool = new Map<string, {
        vertexA: number;
        restLength: number;
        previewB: number | null;
        /** Cloth positions captured at beginStitchTool() — the baseline every preview reset starts from. */
        savedPositions: Float32Array | null;
    }>();
    // Debounce timers for setConfigDebounced (keyed by mesh ID)
    private _clothConfigTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; grid: Partial<ClothGridConfig>; physics: Partial<ClothPhysicsConfig> }>();
    private _liveClothTickCb: (() => boolean) | null = null;

    constructor(
        private readonly ctx: ManagerContext,
        private readonly host: Scene3DClothHost,
    ) {}

    private get renderer3D(): Renderer3D { return this.ctx.webgpuRenderer.getRenderer3D(); }

    /** Restore path: register a rebuilt geometry result for a ClothMesh3D the manager reconstructed from JSON. */
    registerGeometry(meshId: string, result: ClothGeometryResult): void {
        this._clothData.set(meshId, result);
    }

    // ── Create / replace ───────────────────────────────────────────────────────

    createClothMesh(
        x: number,
        y: number,
        z: number,
        gridConfig: Partial<ClothGridConfig> = {},
        physicsConfig: Partial<ClothPhysicsConfig> = {},
        simulatedPositions?: Float32Array,
        name?: string,
    ): ClothMesh3D {
        const cols = gridConfig.cols ?? 8;
        const rows = gridConfig.rows ?? 10;
        const fullGrid: ClothGridConfig = {
            cols,
            rows,
            cellSize:       gridConfig.cellSize       ?? 0.1,
            cornerRadius:   gridConfig.cornerRadius   ?? 0,
            activeCells:    gridConfig.activeCells    ?? buildDefaultActiveCells(cols, rows),
            pinnedVertices: gridConfig.pinnedVertices ?? [],
        };
        const fullPhysics: ClothPhysicsConfig = { ...DEFAULT_CLOTH_PHYSICS, ...physicsConfig };

        const result = buildClothGeometry(fullGrid);
        const geometry = resolveClothGeometry(result, simulatedPositions, fullPhysics);

        const simState: ClothSimState = {
            positions:      simulatedPositions ? Array.from(simulatedPositions) : Array.from(result.flatPositions),
            isSimulated:    !!simulatedPositions,
            simulationMode: 'none',
        };

        const mesh = new ClothMesh3D(
            this.ctx.interactionService,
            x, y, z,
            geometry,
            fullGrid,
            fullPhysics,
            simState,
        );

        if (name) mesh.name = name;

        this._clothData.set(mesh.id, result);

        const parent = this.ctx.sceneGraph.root;
        parent.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        return mesh;
    }

    replaceClothMesh(
        meshId: string,
        gridConfig: ClothGridConfig,
        physicsConfig: ClothPhysicsConfig,
        simulatedPositions?: Float32Array,
        mode: 'hang' | 'drape' | 'none' = 'none',
    ): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const result = buildClothGeometry(gridConfig);
        node.setGeometry(resolveClothGeometry(result, simulatedPositions, physicsConfig));

        node.setClothConfig(gridConfig);
        node.setPhysicsConfig(physicsConfig);
        node.setSimState({
            positions:      simulatedPositions ? Array.from(simulatedPositions) : Array.from(result.flatPositions),
            isSimulated:    !!simulatedPositions,
            simulationMode: mode,
        });

        this._clothData.set(meshId, result);
        node.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    getClothConfig(meshId: string): { grid: ClothGridConfig; physics: ClothPhysicsConfig } | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        return { grid: node.clothConfig, physics: node.physicsConfig };
    }

    getClothGeometryResult(meshId: string): ClothGeometryResult | null {
        return this._clothData.get(meshId) ?? null;
    }

    // ── Vertex index helpers ─────────────────────────────────────────────────────

    getClothVertexSlot(meshId: string, col: number, row: number): number | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        const result = this._clothData.get(meshId);
        if (!result) return null;
        const slotCols = node.clothConfig.cols + 1;
        const slot = col + row * slotCols;
        if (slot < 0 || slot >= result.vertexFromSlot.length) return null;
        return result.vertexFromSlot[slot] >= 0 ? slot : -1;
    }

    getClothVertexDenseIndex(meshId: string, col: number, row: number): number | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        const result = this._clothData.get(meshId);
        if (!result) return null;
        const slotCols = node.clothConfig.cols + 1;
        const slot = col + row * slotCols;
        if (slot < 0 || slot >= result.vertexFromSlot.length) return null;
        const vi = result.vertexFromSlot[slot];
        return vi >= 0 ? vi : -1;
    }

    /** @deprecated Use getClothVertexSlot for pins, getClothVertexDenseIndex for stitches. */
    getClothVertexIndex(meshId: string, col: number, row: number): number | null {
        return this.getClothVertexDenseIndex(meshId, col, row);
    }

    // ── Live config updates ──────────────────────────────────────────────────────

    setClothConfig(
        meshId: string,
        gridConfig?: Partial<ClothGridConfig>,
        physicsConfig?: Partial<ClothPhysicsConfig>,
    ): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const newGrid  = { ...node.clothConfig,  ...gridConfig  };
        const newPhys  = { ...node.physicsConfig, ...physicsConfig };

        const result = buildClothGeometry(newGrid);
        node.setGeometry(resolveClothGeometry(result, undefined, newPhys));

        node.setClothConfig(newGrid);
        node.setPhysicsConfig(newPhys);
        node.setSimState({
            positions:      Array.from(result.flatPositions),
            isSimulated:    false,
            simulationMode: node.simState.simulationMode,
        });

        this._clothData.set(meshId, result);
        node.gpuDirty = true;

        const handle = this._liveClothHandles.get(meshId);
        if (handle) {
            const mode = node.simState.simulationMode !== 'none'
                ? node.simState.simulationMode as 'hang' | 'drape'
                : 'hang';
            handle.reset(newGrid, newPhys, mode);
            handle.setBendStiffness(result.bendStiffness);
            const zones = node.liveConfig.windZones ?? [];
            if (zones.length) handle.setWindZones(zones);
        } else {
            this.enableLiveCloth(meshId);
        }

        this.ctx.scheduleRender();
        return true;
    }

    setClothPhysics(meshId: string, params: Partial<ClothPhysicsConfig>): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const newPhys = { ...node.physicsConfig, ...params };
        node.setPhysicsConfig(newPhys);

        this._liveClothHandles.get(meshId)?.setPhysics(params);
        return true;
    }

    setClothPinnedVertices(meshId: string, pinnedVertices: number[]): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const newGrid = { ...node.clothConfig, pinnedVertices };
        node.setClothConfig(newGrid);

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);

        const handle = this._liveClothHandles.get(meshId);
        if (handle) {
            handle.setInverseMass(result.inverseMass);
            this.ctx.scheduleRender();
        }
        return true;
    }

    setClothConfigDebounced(
        meshId: string,
        gridConfig?: Partial<ClothGridConfig>,
        physicsConfig?: Partial<ClothPhysicsConfig>,
        delayMs = 150,
    ): void {
        const pending = this._clothConfigTimers.get(meshId);
        if (pending) {
            clearTimeout(pending.timer);
            const mergedGrid    = { ...pending.grid,    ...gridConfig    };
            const mergedPhysics = { ...pending.physics, ...physicsConfig };
            const timer = setTimeout(() => {
                this._clothConfigTimers.delete(meshId);
                this.setClothConfig(meshId, mergedGrid, mergedPhysics);
            }, delayMs);
            this._clothConfigTimers.set(meshId, { timer, grid: mergedGrid, physics: mergedPhysics });
        } else {
            const g = gridConfig    ?? {};
            const p = physicsConfig ?? {};
            const timer = setTimeout(() => {
                this._clothConfigTimers.delete(meshId);
                this.setClothConfig(meshId, g, p);
            }, delayMs);
            this._clothConfigTimers.set(meshId, { timer, grid: g, physics: p });
        }
    }

    // ── Stitch tool ──────────────────────────────────────────────────────────────

    beginClothStitchTool(meshId: string, vertexA: number, restLength = 0): boolean {
        const vc = this._clothData.get(meshId)?.vertexCount ?? 0;
        if (vertexA < 0 || vertexA >= vc) return false;
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        const savedPositions = (node instanceof ClothMesh3D && node.simState.isSimulated)
            ? new Float32Array(node.simState.positions)
            : null;
        this._stitchTool.set(meshId, { vertexA, restLength, previewB: null, savedPositions });
        return true;
    }

    previewClothStitch(meshId: string, vertexB: number): boolean {
        const state = this._stitchTool.get(meshId);
        if (!state) return false;
        if (vertexB === state.previewB) return true;
        state.previewB = vertexB;

        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const previewStitch = { a: state.vertexA, b: vertexB, restLength: state.restLength };
        const previewGrid   = {
            ...node.clothConfig,
            stitches: [...(node.clothConfig.stitches ?? []), previewStitch],
        };

        let handle = this._liveClothHandles.get(meshId);
        if (!handle) {
            this.enableLiveCloth(meshId);
            handle = this._liveClothHandles.get(meshId);
            if (!handle) return false;
        }

        const mode = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';
        const initPos = state.savedPositions ?? undefined;
        handle.reset(previewGrid, node.physicsConfig, mode, undefined, initPos);
        const previewResult = buildClothGeometry(previewGrid);
        handle.setBendStiffness(previewResult.bendStiffness);
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);

        return true;
    }

    commitClothStitch(meshId: string): number | null {
        const state = this._stitchTool.get(meshId);
        if (!state || state.previewB === null) return null;
        this._stitchTool.delete(meshId);
        return this.addClothStitch(meshId, state.vertexA, state.previewB, state.restLength);
    }

    cancelClothStitchTool(meshId: string): void {
        const state = this._stitchTool.get(meshId);
        if (!state) return;
        this._stitchTool.delete(meshId);

        const node   = this.ctx.sceneGraph.findNodeById(meshId);
        const handle = this._liveClothHandles.get(meshId);
        if (!handle || !(node instanceof ClothMesh3D)) return;

        const mode = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';
        handle.reset(node.clothConfig, node.physicsConfig, mode, undefined, state.savedPositions ?? undefined);
        const result = this._clothData.get(meshId);
        if (result) handle.setBendStiffness(result.bendStiffness);
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);
    }

    // ── Stitch constraints ─────────────────────────────────────────────────────

    addClothStitch(meshId: string, a: number, b: number, restLength: number): number | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        const vc = this._clothData.get(meshId)?.vertexCount ?? 0;
        if (a < 0 || b < 0 || a >= vc || b >= vc) return null;

        const stitches = [...(node.clothConfig.stitches ?? []), { a, b, restLength: Math.max(0, restLength) }];
        const newGrid  = { ...node.clothConfig, stitches };
        node.setClothConfig(newGrid);

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);
        this._refreshLiveSimAfterConstraintChange(meshId, node, result);
        node.stateDirty = true;
        this.ctx.scheduleRender();
        return stitches.length - 1;
    }

    removeClothStitch(meshId: string, index: number): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        const existing = node.clothConfig.stitches ?? [];
        if (index < 0 || index >= existing.length) return false;

        const stitches = existing.filter((_, i) => i !== index);
        const newGrid  = { ...node.clothConfig, stitches };
        node.setClothConfig(newGrid);

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);
        node.setGeometry(resolveClothGeometry(result, undefined, node.physicsConfig));
        node.gpuDirty = true;
        this._refreshLiveSimAfterConstraintChange(meshId, node, result);
        node.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    clearClothStitches(meshId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        if (!node.clothConfig.stitches?.length) return true;

        const newGrid = { ...node.clothConfig, stitches: [] };
        node.setClothConfig(newGrid);

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);
        node.setSimState({
            positions:      Array.from(result.flatPositions),
            isSimulated:    false,
            simulationMode: node.simState.simulationMode,
        });
        node.setGeometry(resolveClothGeometry(result, undefined, node.physicsConfig));
        node.gpuDirty = true;
        this._refreshLiveSimAfterConstraintChange(meshId, node, result);
        node.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    getClothStitches(meshId: string): StitchConstraint[] {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return [];
        return [...(node.clothConfig.stitches ?? [])];
    }

    // ── Bend-stiffness painting ────────────────────────────────────────────────

    setClothBendStiffness(meshId: string, map: Float32Array | number[]): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const arr = map instanceof Float32Array ? map : new Float32Array(map);
        const newGrid = { ...node.clothConfig, bendStiffnessMap: Array.from(arr) };
        node.setClothConfig(newGrid);

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);

        const handle = this._liveClothHandles.get(meshId);
        if (handle) handle.setBendStiffness(result.bendStiffness);

        node.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    getClothBendStiffnessMap(meshId: string): Float32Array | null {
        const result = this._clothData.get(meshId);
        if (!result) return null;
        return result.bendStiffness.slice();
    }

    // ── Wind zones ─────────────────────────────────────────────────────────────

    addWindZone(meshId: string, zone: Omit<WindZone, 'id'>): string | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;

        const id       = _nanoid();
        const newZone: WindZone = { ...zone, id };
        const zones    = [...(node.liveConfig.windZones ?? []), newZone];
        node.setLiveConfig({ ...node.liveConfig, windZones: zones });

        this._liveClothHandles.get(meshId)?.setWindZones(zones);
        node.stateDirty = true;
        return id;
    }

    removeWindZone(meshId: string, zoneId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        const zones = (node.liveConfig.windZones ?? []).filter(z => z.id !== zoneId);
        if (zones.length === (node.liveConfig.windZones?.length ?? 0)) return false;
        node.setLiveConfig({ ...node.liveConfig, windZones: zones });
        this._liveClothHandles.get(meshId)?.setWindZones(zones);
        node.stateDirty = true;
        return true;
    }

    updateWindZone(meshId: string, zoneId: string, patch: Partial<Omit<WindZone, 'id'>>): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        const zones = (node.liveConfig.windZones ?? []).map(z =>
            z.id === zoneId ? { ...z, ...patch, id: z.id } : z,
        );
        if (!zones.find(z => z.id === zoneId)) return false;
        node.setLiveConfig({ ...node.liveConfig, windZones: zones });
        this._liveClothHandles.get(meshId)?.setWindZones(zones);
        node.stateDirty = true;
        return true;
    }

    getWindZones(meshId: string): WindZone[] {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return [];
        return [...(node.liveConfig.windZones ?? [])];
    }

    clearWindZones(meshId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        node.setLiveConfig({ ...node.liveConfig, windZones: [] });
        this._liveClothHandles.get(meshId)?.setWindZones([]);
        node.stateDirty = true;
        return true;
    }

    private _refreshLiveSimAfterConstraintChange(
        meshId: string,
        node: ClothMesh3D,
        newResult: ClothGeometryResult,
    ): void {
        let handle = this._liveClothHandles.get(meshId);
        if (!handle) {
            this.enableLiveCloth(meshId);
            return;
        }
        const mode = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';
        const initPositions = node.simState.isSimulated
            ? new Float32Array(node.simState.positions)
            : undefined;
        handle.reset(node.clothConfig, node.physicsConfig, mode, undefined, initPositions);
        handle.setBendStiffness(newResult.bendStiffness);
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);
    }

    // ── Offline simulation + pose ────────────────────────────────────────────────

    async simulateCloth(
        gridConfig:    Partial<ClothGridConfig>,
        physicsConfig: Partial<ClothPhysicsConfig>,
        mode: 'hang' | 'drape',
        proxy: DrapeProxy = { type: 'none' },
        maxSteps = 3000,
    ): Promise<Float32Array> {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) throw new Error('simulateCloth: WebGPU device not available');

        const cols = gridConfig.cols ?? 8;
        const rows = gridConfig.rows ?? 10;
        const fullGrid: ClothGridConfig = {
            cols,
            rows,
            cellSize:       gridConfig.cellSize       ?? 0.1,
            cornerRadius:   gridConfig.cornerRadius   ?? 0,
            activeCells:    gridConfig.activeCells    ?? buildDefaultActiveCells(cols, rows),
            pinnedVertices: gridConfig.pinnedVertices ?? [],
        };
        const fullPhysics: ClothPhysicsConfig = { ...DEFAULT_CLOTH_PHYSICS, ...physicsConfig };

        const result = buildClothGeometry(fullGrid);

        let initPositions: Float32Array | undefined;
        if (mode === 'drape') {
            const liftY = drapeStartY(proxy, result.flatPositions, fullGrid, fullPhysics.gravity);
            if (liftY !== 0) {
                initPositions = new Float32Array(result.flatPositions);
                for (let vi = 0; vi < result.vertexCount; vi++) {
                    initPositions[vi * 3 + 1] += liftY;
                }
            }
        }

        const sim = new ClothSimulator(device);
        try {
            sim.init(result, fullPhysics, initPositions);
            if (mode === 'drape') sim.setCollision(proxy);
            return await sim.runToConvergence(maxSteps);
        } finally {
            sim.destroy();
        }
    }

    updateClothMeshPose(
        meshId: string,
        simulatedPositions: Float32Array,
        mode: 'hang' | 'drape' | 'none' = 'none',
    ): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const cached = this._clothData.get(meshId);
        if (!cached || simulatedPositions.length !== cached.vertexCount * 3) return false;

        node.setGeometry(resolveClothGeometry(cached, simulatedPositions, node.physicsConfig));

        (node.simState as ClothSimState).positions      = Array.from(simulatedPositions);
        (node.simState as ClothSimState).isSimulated    = true;
        (node.simState as ClothSimState).simulationMode = mode;

        this._renderClothPreview(meshId);
        this.ctx.scheduleRender();
        return true;
    }

    // ── Live cloth simulation ──────────────────────────────────────────────────

    createLiveClothSim(
        grid:    Partial<ClothGridConfig>,
        physics: Partial<ClothPhysicsConfig>,
        mode:    'hang' | 'drape',
        proxy?:  DrapeProxy,
    ): LiveClothHandle | null {
        const device = this.ctx.webgpuRenderer.getDevice();
        const cols   = grid.cols ?? 8;
        const rows   = grid.rows ?? 10;
        const fullGrid: ClothGridConfig = {
            cols, rows,
            cellSize:       grid.cellSize       ?? 0.1,
            cornerRadius:   grid.cornerRadius   ?? 0,
            activeCells:    grid.activeCells    ?? buildDefaultActiveCells(cols, rows),
            pinnedVertices: grid.pinnedVertices ?? [],
        };
        const fullPhysics: ClothPhysicsConfig = { ...DEFAULT_CLOTH_PHYSICS, ...physics };
        return createLiveClothSimulation(device, fullGrid, fullPhysics, mode, proxy);
    }

    enableLiveCloth(meshId: string, stepsPerFrame?: number): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        this._liveClothHandles.get(meshId)?.destroy();

        const device = this.ctx.webgpuRenderer.getDevice();
        const cfg    = node.clothConfig;
        const phys   = node.physicsConfig;

        const initPositions = node.simState.isSimulated
            ? new Float32Array(node.simState.positions)
            : undefined;

        const mode: 'hang' | 'drape' = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';

        const handle = createLiveClothSimulation(device, cfg, phys, mode, undefined, initPositions);
        if (!handle) return false;

        handle.onPoseBufferChange = (buf) => {
            this.renderer3D.setVertexBufferOverride(meshId, buf);
        };
        if (handle.poseBuffer) {
            this.renderer3D.setVertexBufferOverride(meshId, handle.poseBuffer);
        }

        handle.onPositionsUpdate = (positions) => {
            if (handle.poseBuffer) {
                const cached = this._clothData.get(meshId);
                if (cached && positions.length === cached.vertexCount * 3) {
                    (node.simState as ClothSimState).positions      = Array.from(positions);
                    (node.simState as ClothSimState).isSimulated    = true;
                    (node.simState as ClothSimState).simulationMode = mode;
                }
            } else {
                this.updateClothMeshPose(meshId, positions, mode);
            }
            this.ctx.scheduleRender();
        };

        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);
        const cachedResult = this._clothData.get(meshId);
        if (cachedResult) handle.setBendStiffness(cachedResult.bendStiffness);

        this._liveClothHandles.set(meshId, handle);

        node.setLiveConfig({
            enabled: true,
            stepsPerFrame: stepsPerFrame ?? DEFAULT_CLOTH_LIVE.stepsPerFrame,
        } satisfies ClothLiveConfig);

        this._ensureLiveClothTick();

        this.ctx.scheduleRender();
        return true;
    }

    async disableLiveCloth(meshId: string, bakeCurrentPose = false): Promise<boolean> {
        const handle = this._liveClothHandles.get(meshId);
        if (!handle) return false;

        if (bakeCurrentPose) {
            const positions = await handle.snapshot();
            const node = this.ctx.sceneGraph.findNodeById(meshId);
            if (node instanceof ClothMesh3D) {
                const mode = node.simState.simulationMode !== 'none'
                    ? node.simState.simulationMode as 'hang' | 'drape'
                    : 'hang';
                this.updateClothMeshPose(meshId, positions, mode);
            }
        }

        this.renderer3D.setVertexBufferOverride(meshId, null);
        handle.destroy();
        this._liveClothHandles.delete(meshId);

        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof ClothMesh3D) {
            node.setLiveConfig({ ...DEFAULT_CLOTH_LIVE, enabled: false } satisfies ClothLiveConfig);
        }

        if (this._liveClothHandles.size === 0) {
            this._removeLiveClothTick();
        }

        this.ctx.scheduleRender();
        return true;
    }

    getLiveClothHandle(meshId: string): LiveClothHandle | null {
        return this._liveClothHandles.get(meshId) ?? null;
    }

    tickLiveCloths(frame: number): boolean {
        if (this._liveClothHandles.size === 0) return false;

        for (const [meshId, handle] of this._liveClothHandles) {
            const node = this.ctx.sceneGraph.findNodeById(meshId);
            if (!(node instanceof ClothMesh3D)) {
                handle.destroy();
                this._liveClothHandles.delete(meshId);
                continue;
            }

            const anim = this.host.getFrameLinkAnim(meshId);
            if (anim?.enabled && anim.type === 'wind') {
                const { wind } = evalFrameLink3D(anim, frame);
                handle.setPhysics({ wind: { x: wind[0], y: wind[1], z: wind[2] } });
            }

            if (this._previewRenderers.has(meshId)) {
                this._renderClothPreview(meshId);
            }
        }

        return this._liveClothHandles.size > 0;
    }

    private _ensureLiveClothTick(): void {
        if (this._liveClothTickCb) return;
        let frame = 0;
        this._liveClothTickCb = () => {
            frame++;
            return this.tickLiveCloths(frame);
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._liveClothTickCb);
    }

    private _removeLiveClothTick(): void {
        if (!this._liveClothTickCb) return;
        this.ctx.webgpuRenderer.removePreRenderCallback(this._liveClothTickCb);
        this._liveClothTickCb = null;
    }

    // ── Cloth preview canvas ─────────────────────────────────────────────────────

    attachClothPreviewCanvas(
        meshId: string,
        canvas: HTMLCanvasElement,
        opts?: ClothPreviewOptions,
    ): () => void {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return () => {};

        this._previewRenderers.get(meshId)?.destroy();

        let preview: ClothPreviewRenderer;
        try {
            preview = new ClothPreviewRenderer(device, canvas, opts);
        } catch {
            return () => {};
        }
        this._previewRenderers.set(meshId, preview);

        const mesh = this.host.getMesh(meshId);
        if (mesh) {
            mesh.gpuDirty = true;
            preview.render(mesh);
            mesh.gpuDirty = true;
        }

        return () => {
            preview.destroy();
            if (this._previewRenderers.get(meshId) === preview) {
                this._previewRenderers.delete(meshId);
            }
        };
    }

    private _renderClothPreview(meshId: string): void {
        const preview = this._previewRenderers.get(meshId);
        if (!preview) return;
        const mesh = this.host.getMesh(meshId);
        if (!mesh) return;

        const poseBuffer = this._liveClothHandles.get(meshId)?.poseBuffer ?? null;
        if (poseBuffer) {
            preview.setVertexBufferOverride(mesh.id, poseBuffer);
            const wasDirty = mesh.gpuDirty;
            preview.render(mesh);
            if (wasDirty) mesh.gpuDirty = true;
        } else {
            preview.setVertexBufferOverride(mesh.id, null);
            mesh.gpuDirty = true;
            preview.render(mesh);
            mesh.gpuDirty = true;
        }
    }

    /** Tear down all live sims, previews, and the tick (used on manager teardown). Safe to call more than once. */
    dispose(): void {
        for (const t of this._clothConfigTimers.values()) clearTimeout(t.timer);
        this._clothConfigTimers.clear();
        for (const h of this._liveClothHandles.values()) h.destroy();
        this._liveClothHandles.clear();
        for (const p of this._previewRenderers.values()) p.destroy();
        this._previewRenderers.clear();
        this._stitchTool.clear();
        this._clothData.clear();
        this._removeLiveClothTick();
    }
}
