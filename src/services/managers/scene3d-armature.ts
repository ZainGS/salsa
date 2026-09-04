/**
 * Scene3DArmature — the interactive-editing "tangle" extracted from Scene3DManager as the LAST scene3d-manager
 * decomposition milestone (docs/specs/armature-tangle-extraction-map.md). This is the one indivisible ~2,300-line
 * sub-cluster that the map proves cannot be peeled apart further: camera / orbit / view-gizmo, illustration-camera
 * sync, the transform gizmo, the bone overlay + joint editing, IK/FK + joint-drag, bone placement, mesh isolation,
 * selection / hover / thin-wrapper, and the two canvas-listener mega-closures (enableTransformControls +
 * _setupBoneOverlayListeners). `_illustrationSync` and `_orbitController` are the connective tissue that make the
 * remainder indivisible, so it all moves as ONE unit.
 *
 * GPU / canvas / picker-coupled, so browser-verified rather than unit-tested. Method bodies are moved VERBATIM;
 * only the scaffolding below (fields, constructor, bridge getters/methods, host interface, imports) is new authored
 * code. The bridge getters/methods exist so the moved bodies keep resolving `this.X` for the NON-tangle manager
 * members they reach (renderer3D, the shared picker, sibling subsystems, framing/pick helpers, etc.) without a
 * single body edit. The shared MeshPicker (`_picker`) STAYS on the manager (used by ~15 non-tangle sites) and is
 * reached here via `host.picker`. Scene3DManager keeps thin delegating methods so the public API is unchanged.
 */

import { mat4, vec3 } from 'gl-matrix';
import type { ManagerContext } from './manager-context';
import { OrbitController, OrbitControllerConfig } from '../../renderer/3d/orbit-controller';
import { ViewGizmo } from '../../renderer/3d/view-gizmo';
import { GizmoRenderer, GizmoMode, GizmoAxis, ArrayGizmoData, ArrayHandleHit, IKHandleHit } from '../../renderer/3d/gizmo-renderer';
import { MeshEditOverlayRenderer, type MeshEditDrawData } from '../../renderer/3d/mesh-edit-overlay-renderer';
import { TransformController3D, type SnapMode, type SnapVizData } from './transform-controller-3d';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { WeightPaintVertexOverlayRenderer } from '../../renderer/3d/weight-paint-overlay-renderer';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { ArrayGroup3D, ArrayParams, computeArrayOffsets, LocalBasis3 } from '../../scene-graph/shapes/array-group-3d';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { IKChain } from '../../types/armature-3d';
import { solveAllIKChains, clearAllIKRotations } from '../../renderer/3d/ik-solver';
import { solveAllConstraints } from '../../renderer/3d/constraint-solver';
import { solveSpringBones } from '../../renderer/3d/spring-bone-solver';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import type { UndoManager3D } from './undo-manager-3d';
import type { Scene3DCharacter } from './scene3d-character';
import type { Scene3DWeightPaint } from './scene3d-weight-paint';

/** Short random id (module-local, mirrors the Scene3DManager helper). Used by addIKChain. */
const _nanoid = () => Math.random().toString(36).slice(2, 10);

/** Ray → axis-aligned-bounding-box intersection; returns the near hit distance (≥0) or null on a miss.
 *  Module-local, mirrors the Scene3DManager helper — used by the array-instance pick inside the gizmo closure. */
function _rayAABBIntersect(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
): number | null {
    const invDx = dx !== 0 ? 1 / dx : Infinity;
    const invDy = dy !== 0 ? 1 / dy : Infinity;
    const invDz = dz !== 0 ? 1 / dz : Infinity;
    const tx1 = (minX - ox) * invDx, tx2 = (maxX - ox) * invDx;
    const ty1 = (minY - oy) * invDy, ty2 = (maxY - oy) * invDy;
    const tz1 = (minZ - oz) * invDz, tz2 = (maxZ - oz) * invDz;
    const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
    const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
    return tmax >= 0 && tmin <= tmax ? Math.max(0, tmin) : null;
}

/** A raycast hit from the manager's shared picker. */
export interface ArmaturePick3DHit {
    meshId: string;
    hitPoint: [number, number, number];
    faceNormal: [number, number, number];
    triangleIndex: number;
    distance: number;
}

/** Narrow host surface — everything Scene3DArmature needs from the parent Scene3DManager beyond the shared ctx.
 *  These resolve the NON-tangle manager members the moved bodies still reach: the shared picker + undo manager,
 *  sibling subsystems, a few shared fields (city-mode gate, FLA rest-pose map, auto-key flag), and a set of
 *  framing / pick / mesh-lookup / array helpers that stay on the manager. */
export interface Scene3DArmatureHost {
    // Shared infrastructure that stays on the manager.
    readonly undoManager: UndoManager3D;
    readonly picker: MeshPicker;
    readonly character: Scene3DCharacter;
    readonly weightPaint: Scene3DWeightPaint;

    // Shared manager fields the tangle READS.
    readonly cityModeActive: boolean;
    readonly autoKey3D: boolean;
    readonly flaRestTransforms: Map<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>;

    // Mesh / skeleton lookup + framing (stay on manager).
    getMesh(id: string): Mesh3D | null;
    getAllMeshes(): Mesh3D[];
    getMeshGroup(groupId: string): MeshGroup3D | null;
    getMeshCenter(meshId: string | null): [number, number, number] | null;
    getSkeleton(id: string): Skeleton3D | null;
    getAllSkeletons(): Skeleton3D[];
    frameMesh(nodeId: string, padding?: number): boolean;

    // Picking + keyframing (stay on manager).
    pick3D(mouseX: number, mouseY: number, canvasWidth: number, canvasHeight: number, includeNonPickable?: boolean): ArmaturePick3DHit | null;
    resolveOverlayToBody(meshId: string): string;
    recordKeyframeForMesh(meshId: string, frame?: number): boolean;

    // Array tool + grid config (stay on manager).
    getArrayGroup(groupId: string): ArrayGroup3D | null;
    getGroupSiblingArrays(groupId: string): ArrayGroup3D[];
    updateArrayParams3D(groupId: string, params: Partial<ArrayParams>): void;
    pushGridConfig(): void;

    // Idle / spring / focus-bg live loop (stay on manager).
    ensureIdleCallback(): void;
    springsActiveFor(skelId: string, now: number): boolean;
    syncFocusBgLiveLoop(): void;
}

export class Scene3DArmature {
    // ── (h) orbit / view-gizmo ───────────────────────────────────────────────────────────────────────
    private _orbitController?: OrbitController;
    private _viewGizmo?: ViewGizmo;
    private _viewGizmoFrameCb?: () => boolean;
    private _orbitUpdateCallback?: () => boolean;
    private _orbitDriftCleanup: (() => void) | null = null;
    private _orbitDriftRaf = 0;
    private _viewGizmoPos?: import('../../renderer/3d/view-gizmo').ViewGizmoPosition;

    // ── (a) gizmo ────────────────────────────────────────────────────────────────────────────────────
    private _gizmoRenderer?: GizmoRenderer;
    private _meshEditOverlay?: MeshEditOverlayRenderer;
    private _transformController?: TransformController3D;
    private _transformSyncCallback?: () => boolean;
    private _isMeshEditModeFn?: () => boolean;
    private _meshEditDataFn?: () => MeshEditDrawData | null;

    // ── (b) bone overlay + joint ─────────────────────────────────────────────────────────────────────
    private _boneOverlaySkeletonId: string | null = null;
    private _selectedJointIndex: number | null = null;
    private _hoveredJointIndex: number | null = null;
    private _jointMouseDownCleanup?: () => void;
    private _boneOverlayExplicit = false;
    private _boneOverlayListenerCleanup?: () => void;

    // ── (c) camera-lock (armature + mesh-edit orbit-center anchors) ───────────────────────────────────
    private _armatureOrbitCenter: [number, number, number] | null = null;
    private _armatureOrthoX = 0;
    private _armatureOrthoY = 0;
    private _armatureIllustrationCx = 0;
    private _armatureIllustrationCy = 0;
    private _meshEditOrbitCenter: [number, number, number] | null = null;
    private _meshEditOrthoX = 0;
    private _meshEditOrthoY = 0;
    private _meshEditIllustrationCx = 0;
    private _meshEditIllustrationCy = 0;

    // ── (e) IK/FK + joint drag ───────────────────────────────────────────────────────────────────────
    private _isDraggingJoint = false;
    private _dragJointIdx: number | null = null;
    private _dragPlanePoint = vec3.create();
    private _dragPlaneNormal = vec3.create();
    private _isDraggingTail = false;
    private _dragTailJointIdx: number | null = null;
    private _hoveredTailJointIndex: number | null = null;
    private _jointGizmoHoveredAxis: GizmoAxis = null;
    private _isDraggingJointAxis = false;
    private _dragJointAxisAxis: GizmoAxis = null;
    private _dragJointAxisStartPt: vec3 = vec3.create();
    private _dragJointAxisJointStart: vec3 = vec3.create();
    private _isRotatingJoint = false;
    private _rotatingJointIdx: number | null = null;
    private _rotatingJointAxis: 'x' | 'y' | 'z' | null = null;
    private _rotatingJointInitialQuat: [number, number, number, number] = [0, 0, 0, 1];
    private _rotatingJointAccAngle = 0;
    private _rotatingLastClientX = 0;
    private _rotatingLastClientY = 0;
    private _hoveredIKHandle: IKHandleHit | null = null;
    private _draggingIKHandle: IKHandleHit | null = null;
    private _ikDragPlaneNormal: vec3 = vec3.create();
    private _ikDragPlanePoint: vec3 = vec3.create();
    private _ikSolveCallback: (() => boolean) | null = null;
    // The per-frame spring solve registered by enableOrbitControls / torn down by disableOrbitControls.
    private _springSolveCallback: (() => boolean) | null = null;
    private _springLastTime = 0;

    // ── (f) bone placement ───────────────────────────────────────────────────────────────────────────
    private _bonePlacementMode = false;
    private _bonePlacementSkeletonId: string | null = null;
    private _bonePlacementPendingIdx: number | null = null;
    private _selectedJointIsTail = false;

    // ── isolation + armature tool ────────────────────────────────────────────────────────────────────
    private _armatureSavedMeshRotation: { meshId: string; rx: number; ry: number; rz: number } | null = null;
    private _isolatedMeshId: string | null = null;
    private _savedMeshVisibility = new Map<string, boolean>();
    private _armatureToolMode: 'move' | 'rotate' = 'move';

    // ── (i) illustration sync ────────────────────────────────────────────────────────────────────────
    private _illustrationSync: { panX: number; panY: number; zoom: number; canvasW: number; canvasH: number } | null = null;
    private _illustrationProjection: 'perspective' | 'orthographic' = 'orthographic';
    private _autoSyncCallback?: () => boolean;

    // ── (j) selection / hover / thin-wrapper ─────────────────────────────────────────────────────────
    private _selectedGroupId: string | null = null;
    private _selectedThinWrapper: MeshGroup3D | null = null;
    private _thinWrapperXformSig = '';
    private _wrapperMeshCache: Mesh3D[] | null = null;
    private _wrapperMeshCacheBase: Mesh3D[] | null = null;
    private _thinWrapperTransformSyncs: ((container: MeshGroup3D) => void)[] = [];
    private _hoverAnimHeld = false;

    constructor(
        private readonly ctx: ManagerContext,
        private readonly host: Scene3DArmatureHost,
    ) {}

    // ── Bridge getters: keep verbatim `this.X` resolving to manager-owned members ─────────────────────
    private get renderer3D() { return this.ctx.webgpuRenderer.getRenderer3D(); }
    private get _undoManager(): UndoManager3D { return this.host.undoManager; }
    private get _picker(): MeshPicker { return this.host.picker; }
    private get _character(): Scene3DCharacter { return this.host.character; }
    private get _weightPaint(): Scene3DWeightPaint { return this.host.weightPaint; }
    private get _cityModeActive(): boolean { return this.host.cityModeActive; }
    private get autoKey3D(): boolean { return this.host.autoKey3D; }
    private get _flaRestTransforms() { return this.host.flaRestTransforms; }

    // ── Bridge methods: 1-line delegators to the NON-tangle manager methods the tangle bodies call ────
    private getMesh(id: string): Mesh3D | null { return this.host.getMesh(id); }
    private getAllMeshes(): Mesh3D[] { return this.host.getAllMeshes(); }
    private getMeshGroup(groupId: string): MeshGroup3D | null { return this.host.getMeshGroup(groupId); }
    private getMeshCenter(meshId: string | null): [number, number, number] | null { return this.host.getMeshCenter(meshId); }
    private getSkeleton(id: string): Skeleton3D | null { return this.host.getSkeleton(id); }
    private getAllSkeletons(): Skeleton3D[] { return this.host.getAllSkeletons(); }
    private frameMesh(nodeId: string, padding?: number): boolean { return this.host.frameMesh(nodeId, padding); }
    private pick3D(mouseX: number, mouseY: number, canvasWidth: number, canvasHeight: number, includeNonPickable = false): ArmaturePick3DHit | null { return this.host.pick3D(mouseX, mouseY, canvasWidth, canvasHeight, includeNonPickable); }
    private _resolveOverlayToBody(meshId: string): string { return this.host.resolveOverlayToBody(meshId); }
    private recordKeyframeForMesh(meshId: string, frame?: number): boolean { return this.host.recordKeyframeForMesh(meshId, frame); }
    private _getArrayGroup(groupId: string): ArrayGroup3D | null { return this.host.getArrayGroup(groupId); }
    private _getGroupSiblingArrays(groupId: string): ArrayGroup3D[] { return this.host.getGroupSiblingArrays(groupId); }
    private updateArrayParams3D(groupId: string, params: Partial<ArrayParams>): void { this.host.updateArrayParams3D(groupId, params); }
    private _pushGridConfig(): void { this.host.pushGridConfig(); }
    private _ensureIdleCallback(): void { this.host.ensureIdleCallback(); }
    private _springsActiveFor(skelId: string, now: number): boolean { return this.host.springsActiveFor(skelId, now); }
    private _syncFocusBgLiveLoop(): void { this.host.syncFocusBgLiveLoop(); }

    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // Below: the tangle method bodies, moved VERBATIM from Scene3DManager. Do not hand-edit.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════

    pickGroundXZ(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, groundY = 0): [number, number] | null {
        const camera = this.renderer3D.getCamera();
        const { origin, dir } = this._picker.castRay(clientX - rect.left, clientY - rect.top, rect.width, rect.height, camera);
        if (Math.abs(dir[1]) < 1e-6) return null;                   // ray parallel to the ground
        const t = (groundY - origin[1]) / dir[1];
        if (t < 0) return null;                                     // plane is behind the camera
        return [origin[0] + dir[0] * t, origin[2] + dir[2] * t];
    }

    orbitTurntable(deltaRad: number): void {
        if (!this._orbitController) return;
        this._orbitController.azimuth += deltaRad;
        this._orbitController.applySpherical();
        this.ctx.scheduleRender();
    }

    syncIllustrationCamera(panX: number, panY: number, zoom: number, canvasW: number, canvasH: number): void {
        if (this._boneOverlayExplicit || this._meshEditOrbitCenter) {
            // Orbit controller owns the camera. Keep sync fresh for delta tracking
            // and pan-speed calibration, but don't touch the camera directly.
            this._illustrationSync = { panX, panY, zoom, canvasW, canvasH };
            this.ctx.scheduleRender();
            return;
        }
        this._illustrationSync = { panX, panY, zoom, canvasW, canvasH };
        this.renderer3D.getCamera().mode = this._illustrationProjection;
        this._applyIllustrationCamera();
    }

    setIllustrationProjection(mode: 'perspective' | 'orthographic'): void {
        this._illustrationProjection = mode;
        this.renderer3D.getCamera().mode = mode;
        if (this._illustrationSync) {
            this._applyIllustrationCamera();
        } else {
            this.ctx.scheduleRender();
        }
    }

    private _applyIllustrationCamera(): void {
        if (!this._illustrationSync) return;
        if (this._boneOverlayExplicit || this._meshEditOrbitCenter) return; // orbit owns the camera
        const { panX, panY, zoom, canvasW, canvasH } = this._illustrationSync;
        const cam = this.renderer3D.getCamera();

        cam.aspect = canvasW / canvasH;

        // The 2D world matrix is:  NDC_x = zoom * x / aspect + panX / canvasW
        //                          NDC_y = zoom * y          - panY / canvasH
        // Pan is accumulated at 2× mouse pixels (see renderer panning handler).
        // Inverting NDC = 0 gives the 2D world-space center — which the 3D camera
        // must look at so that 3D meshes pan at the same rate as 2D content.
        //
        // cx = −panX / (canvasH × zoom)   [derived from aspect/canvasW simplification]
        // cy =  panY / (canvasH × zoom)
        // orthoSize = 1 / zoom  (half the visible height in normalized world units)
        const cx = -panX / (canvasH * zoom);
        const cy =  panY / (canvasH * zoom);
        const orthoSize = 1 / zoom;

        if (cam.mode === 'orthographic') {
            cam.orthoSize = orthoSize;
            cam.near = 0.001;
            cam.far = Math.max(100, cam.sceneRadius * 4);   // enclose a large placed city (ortho has no autoFar)
            cam.lookAt(cx, cy, 10, cx, cy, 0);
        } else {
            const d = orthoSize / Math.tan(cam.fov / 2);
            cam.near = Math.max(0.0001, d * 0.0001);
            cam.far = Math.max(d * 2, 100);   // perspective: autoFar (if on) overrides this via effectiveFar
            cam.lookAt(cx, cy, d, cx, cy, 0);
        }

        this.ctx.scheduleRender();
    }

    enableAutoSyncIllustrationCamera(): void {
        if (this._autoSyncCallback) return;
        const iService = this.ctx.interactionService;
        const renderer = this.ctx.webgpuRenderer;
        this._autoSyncCallback = () => {
            const canvas = renderer.getCanvas();
            const pan = iService.getPanOffset();
            const zoom = iService.getZoomFactor();
            // CHANGE-GATED: the unconditional re-sync called scheduleRender() every frame, so the on-demand
            // render loop FREE-RAN at 60fps forever — even fully idle — multiplying every per-frame cost into
            // an always-on tax (and burning GPU at rest). Skip entirely when pan/zoom/canvas are unchanged.
            const s = this._illustrationSync;
            if (s && s.panX === pan.x && s.panY === pan.y && s.zoom === zoom && s.canvasW === canvas.width && s.canvasH === canvas.height) return false;
            this.syncIllustrationCamera(pan.x, pan.y, zoom, canvas.width, canvas.height);
            return false; // keep running every frame
        };
        renderer.addPreRenderCallback(this._autoSyncCallback);
        // Fire once immediately so any render already queued before this call
        // (e.g. from document load) gets the correct camera on its first frame.
        this._autoSyncCallback();
    }

    disableAutoSyncIllustrationCamera(): void {
        if (!this._autoSyncCallback) return;
        this.ctx.webgpuRenderer.removePreRenderCallback(this._autoSyncCallback);
        this._autoSyncCallback = undefined;
    }

    private _forceIllustrationResync(): void {
        this._illustrationSync = null;
        this.ctx.scheduleRender();
    }

    getIllustrationCenter3D(): [number, number, number] | null {
        if (!this._illustrationSync) return null;
        const { panX, panY, zoom, canvasH } = this._illustrationSync;
        // Same formula as _applyIllustrationCamera — the 2D world-space center.
        const cx = -panX / (canvasH * zoom);
        const cy =  panY / (canvasH * zoom);
        return [cx, cy, 0];
    }

    getIllustrationMeshDefaultScale3D(): number {
        return this.illustrationMeshDefaultScale();
    }

    private illustrationMeshDefaultScale(): number {
        if (!this._illustrationSync) return 1;
        const { zoom } = this._illustrationSync;
        // The 3D world uses the same normalized units as the 2D world:
        // visible height = 2/zoom world units (Y spans −1/zoom to +1/zoom).
        // Target: mesh ≈ 10% of visible height = 0.2/zoom world units.
        return 0.2 / zoom;
    }

    enableOrbitControls(config?: OrbitControllerConfig): OrbitController {
        this.disableOrbitControls();
        const cam = this.renderer3D.getCamera();
        // OrbitController constructor calls syncFromCamera() when no explicit angles are
        // given, so the camera position is preserved on creation.
        this._orbitController = new OrbitController(cam, config);
        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (canvas) this._orbitController.attach(canvas);

        // Register per-frame update for damping/momentum.
        // When bone overlay is active, applySpherical() is called unconditionally every
        // frame so the orbit camera always wins over any illustration-camera auto-sync
        // callback that may be registered ahead of this one in the pre-render list.
        this._orbitUpdateCallback = () => {
            if (!this._orbitController) return false;
            const hadMomentum = this._orbitController.update();
            if (this._boneOverlayExplicit) {
                // Orbit controller owns the camera in armature mode.
                if (this._armatureOrbitCenter) {
                    const oc = this._armatureOrbitCenter;
                    const cam = this.renderer3D.getCamera();
                    const ctrl = this._orbitController;

                    // Keep target fixed at mesh center so orbit always pivots at oc.
                    cam.setTarget(oc[0], oc[1], oc[2]);
                    ctrl.applySpherical(); // position = oc + spherical(radius, az, el)

                    // Derive ortho offset and zoom directly from illustration state each frame.
                    // orthoOffset = illustration_center - orbit_center is always the exact
                    // formula (no accumulation), so zoom-toward-cursor and orbit-then-zoom
                    // never drift.
                    if (this._illustrationSync) {
                        const { panX, panY, zoom, canvasH } = this._illustrationSync;
                        const cx = -panX / (canvasH * zoom);
                        const cy =  panY / (canvasH * zoom);
                        this._armatureOrthoX = cx - oc[0];
                        this._armatureOrthoY = cy - oc[1];
                        cam.orthoSize = 1 / zoom;
                    }
                    cam.orthoOffsetX = this._armatureOrthoX;
                    cam.orthoOffsetY = this._armatureOrthoY;
                } else {
                    this._orbitController.applySpherical();
                }
                // Pan speed: panScale = panSpeed × radius = cam.orthoSize / canvasH.
                // Using cam.orthoSize (not the fixed _illustrationSync.zoom) ensures that
                // after scroll-zoom the pan speed matches the new visual scale exactly.
                if (this._illustrationSync) {
                    const { canvasH } = this._illustrationSync;
                    const r = Math.max(0.001, this._orbitController.radius);
                    this._orbitController.panSpeed =
                        this.renderer3D.getCamera().orthoSize / (canvasH * r);
                }
                if (hadMomentum) this.ctx.scheduleRender();
                return false;
            } else if (this._meshEditOrbitCenter) {
                const oc = this._meshEditOrbitCenter;
                const cam = this.renderer3D.getCamera();
                const ctrl = this._orbitController;

                cam.setTarget(oc[0], oc[1], oc[2]);
                ctrl.applySpherical();

                // NOTE (city + mesh-edit): this 2D-sync mapping is the CORRECT single source for zoom/pan — the
                // projection derives from the same illustration zoom the whole pipeline uses, so the frustum,
                // culling and fog always match the view. (The old "raw scroll desyncs culling/fog" bug was the
                // orbit controller's ungated WHEEL DOLLY — now Alt-gated in altOrbitOnly mode — not this mapping.)
                if (this._illustrationSync) {
                    const { panX, panY, zoom, canvasH } = this._illustrationSync;
                    const cx = -panX / (canvasH * zoom);
                    const cy =  panY / (canvasH * zoom);
                    this._meshEditOrthoX = cx - oc[0];
                    this._meshEditOrthoY = cy - oc[1];
                    cam.orthoSize = 1 / zoom;
                }
                cam.orthoOffsetX = this._meshEditOrthoX;
                cam.orthoOffsetY = this._meshEditOrthoY;

                if (this._illustrationSync) {
                    const { canvasH } = this._illustrationSync;
                    const r = Math.max(0.001, ctrl.radius);
                    ctrl.panSpeed = cam.orthoSize / (canvasH * r);
                }
                if (hadMomentum) this.ctx.scheduleRender();
                return false;
            }
            if (hadMomentum) this.ctx.scheduleRender();
            return hadMomentum;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._orbitUpdateCallback);

        // Per-frame IK solve: FK pass → FABRIK → final worldMatrices.
        // Only active when bone overlay is explicit and skeleton has enabled IK chains.
        this._ikSolveCallback = () => {
            if (!this._boneOverlayExplicit || !this._boneOverlaySkeletonId) return false;
            const skel = this.getSkeleton(this._boneOverlaySkeletonId);
            if (!skel) return false;
            const hasIK          = skel.data.ikChains?.some(c => c.enabled) ?? false;
            const hasConstraints = skel.data.joints.some(j => j.constraints?.length);
            if (!hasIK && !hasConstraints) return false;
            // Step 1: FK world matrices
            skel.computeWorldMatrices();
            // Step 2: IK solve
            if (hasIK) solveAllIKChains(skel);
            // Step 3: constraints need post-IK world matrices
            if (hasConstraints) {
                skel.computeWorldMatrices();
                solveAllConstraints(skel);
            }
            // Step 4: final world matrices with constraint overrides
            skel.computeWorldMatrices();
            skel.matricesDirty = true;
            return false;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._ikSolveCallback);

        // Per-frame PROCEDURAL IDLE: breathing / weight-shift / sway on a standing character. Registered BEFORE the
        // spring solve so hair + chains react to the idle motion (secondary motion). NOTE the callback is created +
        // registered by _ensureIdleCallback (also called from setIdleAnimation) so it survives leaving an edit mode.
        this._ensureIdleCallback();

        // Per-frame SPRING-BONE solve: dynamic hair tails / cloth swing + body collision. Registered AFTER the
        // IK callback so it perturbs the FINAL posed skeleton. Runs for any skeleton with enabled spring chains
        // (not gated on armature editing — hair should jiggle during normal viewing/posing). Returns true while
        // anything is still moving → the renderer keeps ticking until it settles, then idles (no busy loop).
        this._springSolveCallback = () => {
            const now = performance.now();
            const dt = this._springLastTime > 0 ? (now - this._springLastTime) / 1000 : 1 / 60;
            this._springLastTime = now;
            let moving = false;
            for (const skel of this.getAllSkeletons()) {
                if (!skel.data.springChains?.some(c => c.enabled)) continue;
                if (!this._springsActiveFor(skel.id, now)) continue;   // idle characters don't simulate (crowd perf)
                if (solveSpringBones(skel, dt)) moving = true;
            }
            if (!moving) this._springLastTime = 0;   // settled → reset the clock so the next nudge starts fresh
            return moving;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._springSolveCallback);

        // If bone overlay was already shown before orbit was set up, create the gizmo now.
        if (this._boneOverlayExplicit) {
            this._ensureViewGizmo();
        }

        return this._orbitController;
    }

    private _ensureViewGizmo(): void {
        this.enableViewGizmo();
    }

    enableViewGizmo(position?: import('../../renderer/3d/view-gizmo').ViewGizmoPosition): void {
        if (this._viewGizmo || !this._orbitController) return;
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;
        this._viewGizmo = new ViewGizmo(
            canvas,
            this.renderer3D.getCamera(),
            this._orbitController,
            () => this.ctx.scheduleRender(),
            position ?? this._viewGizmoPos,
        );
        this._viewGizmo.draw();
        this._viewGizmoFrameCb = () => { this._viewGizmo?.draw(); return false; };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._viewGizmoFrameCb);
    }

    setViewGizmoPosition(position: import('../../renderer/3d/view-gizmo').ViewGizmoPosition): void {
        this._viewGizmoPos = position;
        this._viewGizmo?.setPosition(position);
    }

    disableViewGizmo(): void {
        this._viewGizmo?.destroy();
        this._viewGizmo = undefined;
        if (this._viewGizmoFrameCb) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._viewGizmoFrameCb);
            this._viewGizmoFrameCb = undefined;
        }
    }

    disableOrbitControls(): void {
        this.cancelOrbitDrift3D();   // never leave a drift ticking against a detached controller
        this.disableViewGizmo();
        if (this._orbitUpdateCallback) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._orbitUpdateCallback);
            this._orbitUpdateCallback = undefined;
        }
        if (this._ikSolveCallback) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._ikSolveCallback);
            this._ikSolveCallback = null;
        }
        // NOTE: deliberately do NOT remove _idleSolveCallback here. The idle must keep running in the host's normal
        // view AFTER leaving an edit mode; stripping it on disableOrbitControls was the root cause of "idle only
        // works in Edit Mesh mode". It's a cheap no-op (early-returns) whenever no body has idle enabled.
        if (this._springSolveCallback) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._springSolveCallback);
            this._springSolveCallback = null;
        }
        this._orbitController?.detach();
        this._orbitController = undefined;
    }

    enableMeshEditOrbit(meshId: string): void {
        // Reset camera to current illustration state so orbit derives correct
        // spherical coords regardless of prior camera movements on re-entry.
        const cam = this.renderer3D.getCamera();
        if (this._illustrationSync) {
            const { panX, panY, zoom, canvasH } = this._illustrationSync;
            const cx = -panX / (canvasH * zoom);
            const cy =  panY / (canvasH * zoom);
            cam.lookAt(cx, cy, 10, cx, cy, 0);
            cam.orthoSize = 1 / zoom;
        }
        this.enableOrbitControls({ altOrbitOnly: true });

        const meshCenter = this.getMeshCenter(meshId);

        if (meshCenter) {
            // Point orbit pivot at mesh center and recompute spherical coords
            // from the camera's current position — no camera movement.
            cam.setTarget(meshCenter[0], meshCenter[1], meshCenter[2]);
            this._orbitController?.syncFromCamera();
            this._meshEditOrbitCenter = [meshCenter[0], meshCenter[1], meshCenter[2]];
        } else {
            // No geometry yet; use wherever the illustration camera is looking.
            const t = cam.target;
            this._meshEditOrbitCenter = [t[0], t[1], t[2]];
        }

        // Initialise ortho offset so the mesh appears at the same screen position
        // it occupied before orbit mode activated.
        //   cx_world = illustration camera center in ortho world units
        //   The mesh center projects to NDC = −orthoOffsetX / hw by the invariant,
        //   so we need orthoOffsetX = cx_world − mesh_center_x.
        if (this._illustrationSync) {
            const { panX, panY, zoom, canvasH } = this._illustrationSync;
            const cx = -panX / (canvasH * zoom);
            const cy =  panY / (canvasH * zoom);
            const oc = this._meshEditOrbitCenter;
            this._meshEditOrthoX = cx - oc[0];
            this._meshEditOrthoY = cy - oc[1];
            this._meshEditIllustrationCx = cx;
            this._meshEditIllustrationCy = cy;
        } else {
            this._meshEditOrthoX = 0;
            this._meshEditOrthoY = 0;
            this._meshEditIllustrationCx = 0;
            this._meshEditIllustrationCy = 0;
        }
        cam.orthoOffsetX = this._meshEditOrthoX;
        cam.orthoOffsetY = this._meshEditOrthoY;

        this.ctx.interactionService.suppressBoxSelect = true;
        this.enableViewGizmo();
        // Show the focus background (hides the 2D illustration content behind the mesh
        // for a clean editing/painting workspace — same system as armature mode).
        this.renderer3D.setMeshEditModeActive(true);
        this._syncFocusBgLiveLoop();   // hold the live loop if the focus bg is animated ('wavy')
        this.ctx.scheduleRender();
    }

    disableMeshEditOrbit(): void {
        this.ctx.interactionService.suppressBoxSelect = false;
        this._meshEditOrbitCenter = null;
        this._meshEditOrthoX = 0;
        this._meshEditOrthoY = 0;
        const cam = this.renderer3D.getCamera();
        cam.orthoOffsetX = 0;
        cam.orthoOffsetY = 0;
        this.renderer3D.setMeshEditModeActive(false);
        this._syncFocusBgLiveLoop();   // release any animated-bg live-loop hold
        this.disableOrbitControls();
        this._forceIllustrationResync();   // snap the camera back to the 2D view NOW (not on the next pan)
    }

    enterMeshOrbit3D(meshId: string, opts: { azimuth?: number; elevation?: number; padding?: number } = {}): void {
        this.enableOrbitControls({ altOrbitOnly: true });
        this.frameMesh(meshId, opts.padding ?? 1.7);                 // camera → framed (sets target = centre + fit radius)
        const center = this.getMeshCenter(meshId);
        if (center) {
            const cam = this.renderer3D.getCamera();
            cam.setTarget(center[0], center[1], center[2]);
            this._orbitController?.syncFromCamera();                 // adopt the framed radius/angle
            this._orbitController?.setSpherical(opts.azimuth ?? Math.PI * 0.18, opts.elevation ?? 1.0);   // 3/4 top-down
            this._meshEditOrbitCenter = [center[0], center[1], center[2]];   // ← orbit now owns the camera
        }
        // Clean 3D stage (like Edit-Mesh / Edit-Armature): a focus background instead of the 2D dot-grid artboard,
        // so a single product mesh reads clearly. Pair with the caller disabling the artboard clip.
        this.renderer3D.setMeshEditModeActive(true);
        this._syncFocusBgLiveLoop();   // hold the live loop if the focus bg is animated ('wavy')
        this.ctx.scheduleRender();
    }

    claimCameraForOrbit3D(center: [number, number, number]): void {
        this._meshEditOrbitCenter = [center[0], center[1], center[2]];
        this._orbitController?.syncFromCamera();
        this.ctx.scheduleRender();
    }

    exitMeshOrbit3D(): void {
        this._meshEditOrbitCenter = null;
        this.renderer3D.setMeshEditModeActive(false);
        this._syncFocusBgLiveLoop();   // release any animated-bg live-loop hold
        this.disableOrbitControls();
        this._forceIllustrationResync();   // snap the camera back to the 2D view NOW (not on the next pan)
    }

    enterGroupOrbit3D(groupId: string, opts: { azimuth?: number; elevation?: number; padding?: number } = {}): void {
        const group = this.getMeshGroup(groupId);
        if (!group) return;
        const meshes: Mesh3D[] = [];
        group.forEachDeep(n => { if (n instanceof Mesh3D && !n.frameExclude) meshes.push(n); });
        if (!meshes.length) return;
        this.enableOrbitControls({ altOrbitOnly: true });
        // MEASURED framing: union world AABB straight from the panel GEOMETRY through the real render matrices.
        // Two prior approaches both failed silently here — frameGroup (MeshGroup3D bounds are a no-op) and
        // frameMeshes (its ortho sizing uses dx/dy only, degenerate for a FLAT XZ sheet whose big extent is Z).
        // Measuring is cheap (≤6 panels × 4 verts) and cannot disagree with what the GPU draws.
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (const m of meshes) {
            const g = m.geometry;
            if (!g || g.vertices.length === 0) continue;
            const w = m.localMatrix as Float32Array;
            for (let k = 0; k < g.vertices.length / 12; k++) {
                const x = g.vertices[k * 12], y = g.vertices[k * 12 + 1], z = g.vertices[k * 12 + 2];
                const wx = w[0] * x + w[4] * y + w[8] * z + w[12];
                const wy = w[1] * x + w[5] * y + w[9] * z + w[13];
                const wz = w[2] * x + w[6] * y + w[10] * z + w[14];
                x0 = Math.min(x0, wx); x1 = Math.max(x1, wx);
                y0 = Math.min(y0, wy); y1 = Math.max(y1, wy);
                z0 = Math.min(z0, wz); z1 = Math.max(z1, wz);
            }
        }
        if (x0 > x1) return;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
        const ext = Math.max(x1 - x0, y1 - y0, z1 - z0, 0.1);
        const pad = opts.padding ?? 1.7;
        const cam = this.renderer3D.getCamera();
        cam.setTarget(cx, cy, cz);
        cam.orthoSize = ext * 0.5 * pad;             // ortho: the visible half-height — sized to the REAL extent
        cam.near = 0.001;
        cam.autoFar = true; cam.sceneRadius = ext;   // far plane always encloses the box however it's orbited
        if (this._orbitController) {
            this._orbitController.radius = Math.max(ext * 2.5, 1);   // sane dolly distance (matters in perspective)
            this._orbitController.setSpherical(opts.azimuth ?? Math.PI * 0.18, opts.elevation ?? 1.0);
        }
        this._meshEditOrbitCenter = [cx, cy, cz];
        this.renderer3D.setMeshEditModeActive(true);
        this._syncFocusBgLiveLoop();   // hold the live loop if the focus bg is animated ('wavy')
        this.ctx.scheduleRender();
    }

    driftOrbitIn3D(durationMs = 450): void {
        const oc = this._orbitController;
        if (!oc || typeof requestAnimationFrame === 'undefined' || typeof performance === 'undefined') return;
        this.cancelOrbitDrift3D();
        const tr = oc.radius, ta = oc.azimuth, te = oc.elevation;                  // target = current framing
        const fr = tr * 1.22, fa = ta - 0.32, fe = Math.max(oc.minElevation, te - 0.10);
        const canvas = this.ctx.webgpuRenderer.getCanvas();
        const cancel = (): void => this.cancelOrbitDrift3D();
        canvas?.addEventListener('pointerdown', cancel, { capture: true });
        canvas?.addEventListener('wheel', cancel, { capture: true });
        this._orbitDriftCleanup = () => {
            canvas?.removeEventListener('pointerdown', cancel, { capture: true });
            canvas?.removeEventListener('wheel', cancel, { capture: true });
        };
        oc.stopDamping();
        const start = performance.now();
        const tick = (): void => {
            const t = Math.min(1, (performance.now() - start) / Math.max(1, durationMs));
            const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // easeInOutCubic
            oc.radius    = fr + (tr - fr) * e;
            oc.azimuth   = fa + (ta - fa) * e;
            oc.elevation = fe + (te - fe) * e;
            oc.applySpherical();
            this.ctx.scheduleRender();
            if (t < 1) this._orbitDriftRaf = requestAnimationFrame(tick);
            else this.cancelOrbitDrift3D();                                        // finished exactly on target
        };
        this._orbitDriftRaf = requestAnimationFrame(tick);
    }

    cancelOrbitDrift3D(): void {
        if (this._orbitDriftRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._orbitDriftRaf);
        this._orbitDriftRaf = 0;
        const clean = this._orbitDriftCleanup;
        this._orbitDriftCleanup = null;
        clean?.();
    }

    setMeshEditBgMode3D(opts: import('../../types/armature-3d').ArmatureBgOptions): void {
        this.renderer3D.setMeshEditBgMode(opts);
        // Toggling the theme to/from 'wavy' while a mode is active must start/stop the live loop live.
        // (Also covers the packaging Creator's setStageBackground passthrough, which routes through here.)
        this._syncFocusBgLiveLoop();
        this.ctx.scheduleRender();
    }

    getMeshEditBgMode3D(): import('../../types/armature-3d').ArmatureBgOptions {
        return this.renderer3D.getMeshEditBgMode();
    }

    meshEditFocusHidesContent(): boolean {
        return this.renderer3D.meshEditHidesContent();
    }

    toggleOrbitControls(enabled?: boolean): void {
        if (this._orbitController) {
            this._orbitController.enabled = enabled ?? !this._orbitController.enabled;
        }
    }

    getOrbitController(): OrbitController | undefined { return this._orbitController; }

    private _setThinWrapper(node: MeshGroup3D | null): void {
        if (this._selectedThinWrapper === node) return;
        this._selectedThinWrapper = node;
        this._wrapperMeshCache = null;   // invalidate the getMeshes concat cache
        this.renderer3D.setSelectedGroupTarget(node as unknown as Mesh3D | null);
    }

    setThinWrapperTransformSync(fn: (container: MeshGroup3D) => void): void {
        this._thinWrapperTransformSyncs = [fn];
    }

    addThinWrapperTransformSync(fn: (container: MeshGroup3D) => void): void {
        this._thinWrapperTransformSyncs.push(fn);
    }

    private _notifyThinWrapperSync(container: MeshGroup3D): void {
        for (const fn of this._thinWrapperTransformSyncs) fn(container);
    }

    showBoneOverlay3D(skeletonId: string | null, meshId?: string): void {
        if (!skeletonId) {
            // Panel explicitly closed — release ownership and tear down dedicated listeners
            this.ctx.interactionService.suppressBoxSelect = false;
            this._boneOverlayExplicit = false;
            this._boneOverlaySkeletonId = null;
            this._selectedJointIndex = null;
            this._hoveredJointIndex = null;
            this._armatureOrbitCenter = null;
            this._armatureOrthoX = 0;
            this._armatureOrthoY = 0;
            this._armatureIllustrationCx = 0;
            this._armatureIllustrationCy = 0;
            this.renderer3D.getCamera().orthoOffsetX = 0;
            this.renderer3D.getCamera().orthoOffsetY = 0;
            this.renderer3D.setBoneOverlaySkeleton(null);
            this.renderer3D.setSelectedJoint(null);
            this.renderer3D.setHoveredJoint(null);
            this.renderer3D.setArmatureModeActive(false);
            this._boneOverlayListenerCleanup?.();
            this._boneOverlayListenerCleanup = undefined;
            // Restore isolated mesh visibility.
            this.clearMeshIsolation3D();
            // Restore mesh rotation saved when entering armature mode.
            if (this._armatureSavedMeshRotation) {
                const mesh = this.getMesh(this._armatureSavedMeshRotation.meshId);
                if (mesh) {
                    const s = this._armatureSavedMeshRotation;
                    mesh.setRotation3D(s.rx, s.ry, s.rz);
                    mesh.updateLocalMatrix();
                }
                this._armatureSavedMeshRotation = null;
            }
            // Restore T/R/S gizmo — joint selection sets mode to null to hide
            // the mesh gizmo while bone gizmos are showing; reset on exit.
            this.setGizmoMode('move');
            // Disable orbit controls now that armature editing is done.
            this.disableOrbitControls();
            this.ctx.emitSceneGraphChanged();
            this.ctx.scheduleRender();
            return;
        }
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return;
        // Mark as explicit so _syncBoneOverlay won't clobber it when the mesh
        // selection changes (e.g. after emitSceneGraphChanged fires).
        this.ctx.interactionService.suppressBoxSelect = true;
        this._boneOverlayExplicit = true;
        this._boneOverlaySkeletonId = skeletonId;
        this.renderer3D.setBoneOverlaySkeleton(skel);
        this.renderer3D.setArmatureModeActive(true);
        this._setupBoneOverlayListeners();
        // Notify Frogmarks first — their sceneGraphChanged handler may call
        // enableOrbitControls or otherwise reset camera state.  We set up the
        // orbit pivot AFTER so cam.target = meshCenter is the final word.
        this.ctx.emitSceneGraphChanged();
        // Zero mesh rotation if not already done by enterArmatureMode3D.
        if (meshId) this._zeroMeshRotationForArmature(meshId);

        if (this._armatureOrbitCenter === null) {
            // First activation or re-entry. Reset camera to current illustration state
            // so syncFromCamera() always derives correct spherical coords — avoids a
            // visible jump on re-entry if prior exit left the camera in a stale position.
            const cam = this.renderer3D.getCamera();
            if (this._illustrationSync) {
                const { panX, panY, zoom, canvasH } = this._illustrationSync;
                const cx = -panX / (canvasH * zoom);
                const cy =  panY / (canvasH * zoom);
                cam.lookAt(cx, cy, 10, cx, cy, 0);
                cam.orthoSize = 1 / zoom;
            }

            // Activate orbit (or flip existing controller to altOrbitOnly).
            if (!this._orbitController) {
                this.enableOrbitControls({ altOrbitOnly: true });
            } else {
                this._orbitController.altOrbitOnly = true;
            }

            // Point the orbit pivot at the mesh center and re-derive spherical coords.
            const meshCenter = this.getMeshCenter(meshId ?? null);
            if (meshCenter) {
                cam.setTarget(meshCenter[0], meshCenter[1], meshCenter[2]);
                this._orbitController?.syncFromCamera();
                this._armatureOrbitCenter = [meshCenter[0], meshCenter[1], meshCenter[2]];
            } else {
                const t = cam.target;
                this._armatureOrbitCenter = [t[0], t[1], t[2]];
            }

            // Initialise the ortho-offset accumulator so the mesh stays at its current
            // screen position after orbit takes over the camera.
            if (this._illustrationSync) {
                const { panX, panY, zoom, canvasH } = this._illustrationSync;
                const cx = -panX / (canvasH * zoom);
                const cy =  panY / (canvasH * zoom);
                const oc = this._armatureOrbitCenter;
                this._armatureOrthoX = cx - oc[0];
                this._armatureOrthoY = cy - oc[1];
                this._armatureIllustrationCx = cx;
                this._armatureIllustrationCy = cy;
            } else {
                this._armatureOrthoX = 0;
                this._armatureOrthoY = 0;
                this._armatureIllustrationCx = 0;
                this._armatureIllustrationCy = 0;
            }
            cam.orthoOffsetX = this._armatureOrthoX;
            cam.orthoOffsetY = this._armatureOrthoY;
        }

        this._ensureViewGizmo();
        this.ctx.scheduleRender();
    }

    setArmatureBgMode3D(opts: import('../../types/armature-3d').ArmatureBgOptions): void {
        this.renderer3D.setArmatureBgMode(opts);
        this.ctx.scheduleRender();
    }

    enterArmatureMode3D(meshId?: string): void {
        this.renderer3D.setArmatureModeActive(true);
        this._setupBoneOverlayListeners();
        if (meshId) {
            // Zero mesh rotation before framing so the camera sees the canonical front-facing pose.
            this._zeroMeshRotationForArmature(meshId);
            this.isolateMesh3D(meshId);
            this.frameMesh(meshId, 1.33);
        }
        this.ctx.scheduleRender();
    }

    private _zeroMeshRotationForArmature(meshId: string): void {
        if (this._armatureSavedMeshRotation) return;
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        this._armatureSavedMeshRotation = {
            meshId,
            rx: mesh.rotationX,
            ry: mesh.rotationY,
            rz: mesh.rotation,
        };
        mesh.setRotation3D(0, 0, 0);
        mesh.updateLocalMatrix();
    }

    isolateMesh3D(meshId: string): void {
        this.clearMeshIsolation3D();
        this._isolatedMeshId = meshId;
        const keep = this._expandCharacterSelection(new Set([meshId]));
        for (const m of this.getAllMeshes()) {
            if (!keep.has(m.id)) {
                this._savedMeshVisibility.set(m.id, m.visible);
                m.visible = false;
            }
        }
        this.ctx.scheduleRender();
    }

    clearMeshIsolation3D(): void {
        if (!this._isolatedMeshId) return;
        for (const [id, vis] of this._savedMeshVisibility) {
            const m = this.getMesh(id);
            if (m) m.visible = vis;
        }
        this._savedMeshVisibility.clear();
        this._isolatedMeshId = null;
        this.ctx.scheduleRender();
    }

    get isolatedMeshId3D(): string | null { return this._isolatedMeshId; }

    getSelectedJointIndex(): number | null { return this._selectedJointIndex; }

    getSelectedJointIsTail(): boolean { return this._selectedJointIsTail; }

    getBoneOverlaySkeletonId(): string | null { return this._boneOverlaySkeletonId; }

    setArmatureToolMode(mode: 'move' | 'rotate'): void {
        this._armatureToolMode = mode;
        this.renderer3D.setArmatureToolMode(mode);
        // Clear any in-progress gizmo hover so the new tool type renders immediately.
        this._jointGizmoHoveredAxis = null;
        this.renderer3D.setJointGizmoHoveredAxis(null);
        this.ctx.scheduleRender();
    }

    getArmatureToolMode(): 'move' | 'rotate' { return this._armatureToolMode; }

    getJointRotation(skeletonId: string, jointIndex: number): [number,number,number,number] | null {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return null;
        const j = skel.data.joints[jointIndex];
        if (!j) return null;
        return [...j.localRotation] as [number,number,number,number];
    }

    resetJointRotation(skeletonId: string, jointIndex: number): void {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return;
        skel.setJointRotation(jointIndex, [0, 0, 0, 1]);
        this.ctx.scheduleRender();
    }

    resetAllJointRotations(skeletonId: string): void {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return;
        for (const j of skel.data.joints) {
            j.localRotation = [0, 0, 0, 1];
        }
        skel.computeWorldMatrices();
        this.ctx.scheduleRender();
    }

    selectJoint(jointIndex: number | null): void {
        this._selectedJointIndex = jointIndex;
        this._selectedJointIsTail = false; // programmatic selection defaults to head semantics
        this.renderer3D.setSelectedJoint(jointIndex);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    clearJointSelection(): void { this.selectJoint(null); }

    extrudeJoint3D(skeletonId: string): void {
        this.enterBonePlacementMode3D(skeletonId);
    }

    enterBonePlacementMode3D(skeletonId: string): void {
        this._bonePlacementMode = true;
        this._bonePlacementSkeletonId = skeletonId;
        // Hide the joint translation gizmo while drawing so the user can focus on
        // placing the bone (notably the head, between the two root-bone clicks).
        this.renderer3D.setBonePlacementActive(true);
        this.ctx.scheduleRender();
    }

    exitBonePlacementMode3D(): void {
        // If we're in tail-phase, remove the partially-placed root joint.
        if (this._bonePlacementPendingIdx !== null && this._bonePlacementSkeletonId) {
            const skel = this.getSkeleton(this._bonePlacementSkeletonId);
            if (skel) {
                skel.removeJoint(this._bonePlacementPendingIdx);
                this._selectedJointIndex = null;
                this.renderer3D.setSelectedJoint(null);
                this.ctx.scheduleRender();
            }
        }
        this._bonePlacementMode = false;
        this._bonePlacementSkeletonId = null;
        this._bonePlacementPendingIdx = null;
        this.renderer3D.setBonePlacementActive(false);
    }

    isBonePlacementModeActive3D(): boolean {
        return this._bonePlacementMode;
    }

    getJointScreenPositions3D(
        skeletonId: string,
        canvasWidth: number,
        canvasHeight: number,
    ): { index: number; name: string; x: number; y: number }[] {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return [];
        const vp = this.renderer3D.getCamera().getViewProjectionMatrix() as Float32Array;
        const hw = canvasWidth  * 0.5;
        const hh = canvasHeight * 0.5;
        return skel.data.joints.map(j => {
            const wx = j.worldMatrix[12], wy = j.worldMatrix[13], wz = j.worldMatrix[14];
            // Homogeneous clip-space transform
            const cx = vp[0]*wx + vp[4]*wy + vp[8]*wz  + vp[12];
            const cy = vp[1]*wx + vp[5]*wy + vp[9]*wz  + vp[13];
            const cw = vp[3]*wx + vp[7]*wy + vp[11]*wz + vp[15];
            const inv = cw !== 0 ? 1 / cw : 0;
            return {
                index: j.index,
                name:  j.name,
                x: ( cx * inv + 1) * hw,  // NDC [-1,1] → pixel
                y: (-cy * inv + 1) * hh,  // flip Y: WebGPU NDC Y+ up, screen Y+ down
            };
        });
    }

    private _expandGroupSelection(ids: Set<string>): { meshIds: Set<string>; groupId: string | null } {
        this._setThinWrapper(null);   // default: not a thin-wrapper selection (set below if it is)
        if (ids.size === 0) {
            this._selectedGroupId = null;
            return { meshIds: ids, groupId: null };
        }

        // THIN WRAPPER (the placed City): a pick ANYWHERE inside it — a building, a road, whatever the ray hit —
        // selects the WHOLE wrapper as a unit, never its (thousands of) children. Walk each picked node up to a
        // thinWrapper ancestor; first hit wins. O(depth), runs before the per-mesh group logic below.
        for (const id of ids) {
            let a: { parent?: unknown } | null = this.ctx.sceneGraph.findNodeById(id) as { parent?: unknown } | null;
            while (a) {
                if (a instanceof MeshGroup3D && a.thinWrapper) {
                    this._selectedGroupId = a.id;
                    this._setThinWrapper(a);
                    return { meshIds: new Set(), groupId: a.id };
                }
                a = (a.parent ?? null) as { parent?: unknown } | null;
            }
        }

        // Direct ArrayGroup3D selection — from GPU instance picking via pickAdditional.
        if (ids.size === 1) {
            const [id] = ids;
            const node = this.ctx.sceneGraph.findNodeById(id);
            // THIN WRAPPER (the placed City): select the container itself, NEVER expand its (thousands of)
            // children into the selection set. O(1). The gizmo uses the container's cachedBounds; transforms
            // write the container's own matrix (composes to children). Empty meshIds → no 700-mesh highlight.
            if (node instanceof MeshGroup3D && node.thinWrapper) {
                this._selectedGroupId = id;
                this._setThinWrapper(node);
                return { meshIds: new Set(), groupId: id };
            }
            if (node instanceof ArrayGroup3D) {
                this._selectedGroupId = id;
                // If the source mesh belongs to a MeshGroup3D, include all siblings so the
                // whole group highlights and moves together with the gizmo.
                const source = this.getMesh(node.sourceId);
                const meshIds = new Set([node.sourceId]);
                if (source?.parent instanceof MeshGroup3D && !(source.parent instanceof ArrayGroup3D)) {
                    for (const child of source.parent.children) {
                        if (child instanceof Mesh3D) meshIds.add(child.id);
                    }
                }
                return { meshIds, groupId: id };
            }
        }

        this._selectedGroupId = null;

        let commonGroup: MeshGroup3D | null = null;
        for (const id of ids) {
            const mesh = this.getMesh(id);
            if (!mesh) return { meshIds: ids, groupId: null };
            const parent = mesh.parent;
            if (!(parent instanceof MeshGroup3D)) return { meshIds: ids, groupId: null };
            if (commonGroup === null) commonGroup = parent;
            else if (commonGroup !== parent) return { meshIds: ids, groupId: null };
        }

        if (!commonGroup) return { meshIds: ids, groupId: null };

        const expanded = new Set<string>();
        for (const child of commonGroup.children) {
            if (child instanceof Mesh3D) expanded.add(child.id);
        }
        return { meshIds: expanded, groupId: commonGroup.id };
    }

    getSelected3DIds(): Set<string> {
        return this.renderer3D.getSelectedMeshIds();
    }

    setSelected3DIds(ids: Set<string>): void {
        if (this._cityModeActive && ids.size > 0) return;   // City mode: viewport clicks must not select the diorama (empty set = clear, allowed)
        const { meshIds, groupId } = this._expandGroupSelection(this._expandCharacterSelection(ids));
        this.renderer3D.setSelectedMeshIds(meshIds);
        if (groupId) {
            this.ctx.setSelectedNode(groupId);
        } else if (ids.size === 1) {
            // Outliner highlights the clicked node; the gizmo covers the whole (expanded) character.
            this.ctx.setSelectedNode([...ids][0]);
        } else if (meshIds.size === 1) {
            this.ctx.setSelectedNode([...meshIds][0]);
        }
        this._syncBoneOverlay(meshIds);
        this.ctx.scheduleRender();
    }

    clearSelection(): void {
        this.renderer3D.setSelectedMeshIds(new Set());
        this._syncBoneOverlay(new Set());
        this.ctx.scheduleRender();
    }

    syncSelectionFromOutliner(nodeId: string): void {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        let meshIds = new Set<string>();
        this._setThinWrapper(null);   // default; set below only for a thin-wrapper node
        if (node instanceof MeshGroup3D && node.thinWrapper) {
            // Thin wrapper (City): select the container, no child walk. Gizmo uses cachedBounds + its transform.
            this._selectedGroupId = nodeId;
            this._setThinWrapper(node);
            this.renderer3D.setSelectedMeshIds(meshIds);   // empty — no 700-mesh highlight
            this.ctx.scheduleRender();
            return;
        }
        if (node instanceof ArrayGroup3D) {
            // Pass the group ID — _expandGroupSelection sets _selectedGroupId (needed for array gizmo).
            const { meshIds: expanded } = this._expandGroupSelection(new Set([nodeId]));
            meshIds = expanded;
        } else if (node instanceof MeshGroup3D) {
            for (const child of node.children) {
                if (child instanceof Mesh3D) meshIds.add(child.id);
            }
        } else if (node instanceof Mesh3D) {
            // Selecting a character part in the outliner selects the WHOLE character (move as one unit).
            const { meshIds: expanded } = this._expandGroupSelection(this._expandCharacterSelection(new Set([nodeId])));
            meshIds = expanded;
        }
        this.renderer3D.setSelectedMeshIds(meshIds);
        this._syncBoneOverlay(meshIds);
        this.ctx.scheduleRender();
    }

    private _syncBoneOverlay(selectedIds: Set<string>): void {
        // Bone overlay lifetime is owned entirely by the Armature panel via showBoneOverlay3D.
        // Do not auto-show or auto-hide when the panel is closed.
        if (!this._boneOverlayExplicit) return;
    }

    setHoveredMesh(id: string | null): void {
        if (this._cityModeActive) id = null;   // City mode: no blue hover outlines on the diorama (it's a workspace, not a selection)
        // Keep frames flowing while an ANIMATED hover outline is shown (a static mouse must still scroll the pattern).
        // Balanced begin/end via `_hoverAnimHeld`, mirroring the focus-bg live lease.
        const needAnim = id != null && this.renderer3D.hoverOutlineAnimated;
        if (needAnim !== this._hoverAnimHeld) {
            this._hoverAnimHeld = needAnim;
            if (needAnim) this.ctx.interactionService.beginInteractive();
            else this.ctx.interactionService.endInteractive();
        }
        if (!id) {
            this.renderer3D.setHoveredMeshIds(new Set());
            this.renderer3D.setHoveredArrayGroupId(null);
        } else {
            const node = this.ctx.sceneGraph.findNodeById(id);
            if (node instanceof ArrayGroup3D) {
                // Restrict highlight to this group's own instance slots, not all slots sharing sourceId.
                this.renderer3D.setHoveredArrayGroupId(node.id);
                this.renderer3D.setHoveredMeshIds(new Set([node.sourceId]));
            } else {
                this.renderer3D.setHoveredArrayGroupId(null);
                // If the hovered mesh is part of a group (from canvas) or IS a group (from
                // outliner mouseenter), expand the hover to all group children.
                const group = this.getMeshGroup(id);
                const mesh  = group ? null : this.getMesh(id);
                const parent = mesh?.parent instanceof MeshGroup3D ? mesh.parent : group;
                if (parent) {
                    const ids = new Set<string>();
                    for (const child of parent.children) {
                        if (child instanceof Mesh3D) ids.add(child.id);
                    }
                    this.renderer3D.setHoveredMeshIds(ids);
                } else {
                    this.renderer3D.setHoveredMeshIds(new Set([id]));
                }
            }
        }
        this.ctx.scheduleRender();
    }

    getHoveredMeshId(): string | null {
        const ids = this.renderer3D.getHoveredMeshIds();
        return ids.size > 0 ? [...ids][0] : null;
    }

    private _characterBodyOf(meshId: string): string | null {
        if (this.getMesh(meshId)?.isProceduralBody) return meshId;
        if (this._character.hasOverlayBody(meshId)) return meshId;
        const owner = this._resolveOverlayToBody(meshId);
        return owner !== meshId ? owner : null;
    }

    private _characterMeshIds(bodyId: string): Set<string> {
        return new Set<string>([bodyId, ...this._character.overlayMeshIds(bodyId)]);
    }

    private _expandCharacterSelection(ids: Set<string>): Set<string> {
        const out = new Set<string>();
        for (const id of ids) {
            const body = this._characterBodyOf(id);
            if (body) for (const m of this._characterMeshIds(body)) out.add(m);
            else out.add(id);
        }
        return out;
    }

    setMeshEditModeChecker(fn: () => boolean): void {
        this._isMeshEditModeFn = fn;
    }

    setMeshEditDataProvider(fn: () => MeshEditDrawData | null): void {
        this._meshEditDataFn = fn;
        // If transform controls are already active, wire the provider now.
        if (this._meshEditOverlay) {
            this.renderer3D.setMeshEditDataProvider(fn);
        }
    }

    enableTransformControls(): void {
        this.disableTransformControls();

        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) { console.warn('Scene3DManager: WebGPU device not available'); return; }

        const swapChainFormat = (this.ctx.webgpuRenderer as any).swapChainFormat ?? 'bgra8unorm';
        this._gizmoRenderer = new GizmoRenderer(device, swapChainFormat);
        this.renderer3D.setGizmoRenderer(this._gizmoRenderer);

        const callbacks = {
            getMeshes:       () => {
                // When a thin-wrapper container (City) is selected, append it so the controller's
                // getMeshes().filter(selectedIds) finds it and drives the gizmo on the container itself.
                // Cached on the base array identity so hover frames don't rebuild a ~700-element array.
                const base = this.getAllMeshes();
                const c = this._selectedThinWrapper;
                if (!c) return base;
                if (this._wrapperMeshCache === null || this._wrapperMeshCacheBase !== base) {
                    this._wrapperMeshCache = [...base, c as unknown as Mesh3D];
                    this._wrapperMeshCacheBase = base;
                }
                return this._wrapperMeshCache;
            },
            getCamera:       () => this.renderer3D.getCamera(),
            getCanvasSize:   () => {
                const canvas = this.ctx.webgpuRenderer.getCanvas();
                return canvas ? { width: canvas.width, height: canvas.height } : { width: 1, height: 1 };
            },
            getSelectedIds:  () => {
                // Thin-wrapper (City) is selected as a unit but held OUT of the renderer's mesh-selection set
                // (no 700-mesh highlight). Inject its id here so the gizmo hit-tests + drags the container.
                const ids = this.renderer3D.getSelectedMeshIds();
                const c = this._selectedThinWrapper;
                if (!c) return ids;
                const s = new Set(ids); s.add(c.id); return s;
            },
            setSelectedIds:  (ids: Set<string>) => {
                if (this._cityModeActive) return;   // City mode: clicking the diorama must not select it (workspace, not objects)
                const { meshIds, groupId } = this._expandGroupSelection(ids);
                this.renderer3D.setSelectedMeshIds(meshIds);
                if (groupId) {
                    this.ctx.setSelectedNode(groupId);
                } else if (meshIds.size === 1) {
                    this.ctx.setSelectedNode([...meshIds][0]);
                }
                this.ctx.scheduleRender();
            },
            scheduleRender:  () => {
                // Thin-wrapper DRAG: the controller writes the container's own transform; re-dirty its parent chain
                // so descendants recompose (their matrix versions don't bump when only the parent moves) + re-upload
                // instances. But scheduleRender ALSO fires on a mere selection/click re-render — and forcing a full
                // 192K-instance repack there is a hard hitch (the tiled-world "lags when I click"). So only do it when
                // the container transform ACTUALLY changed; a same-transform re-render just renders.
                const c = this._selectedThinWrapper;
                if (c) {
                    const sig = `${c.id}|${c.x},${c.y},${c.z},${c.rotationX},${c.rotationY},${c.rotation},${c.scaleX},${c.scaleY},${c.scaleZ}`;
                    if (sig !== this._thinWrapperXformSig) {
                        const sameWrapper = this._thinWrapperXformSig.startsWith(c.id + '|');   // false on first select → record only, no repack
                        this._thinWrapperXformSig = sig;
                        if (sameWrapper) { c.updateParentChainMatrix(); this.renderer3D.markInstancesDirty(); }
                    }
                } else if (this._transformController?.isDragging) {
                    // REGULAR-mesh DRAG: the controller writes the mesh's own transform (its
                    // localMatrixVersion bumps), but nothing armed the renderer, so the instanced mesh
                    // only jumped to its final spot on mouse-up (onTransformComplete) — the gizmo/box
                    // moved live but the mesh didn't. Arm the CHEAP incremental transforms path (same one
                    // world-traffic movers use): it version-diffs residents and re-uploads ONLY the moved
                    // slot, so a mere click (not dragging) is a no-op and never forces a full repack.
                    this.renderer3D.markTransformsDirty();
                }
                this.ctx.scheduleRender();
            },
            getOrbitController: () => this._orbitController,
            onTransformComplete: (before: Map<string, any>, after: Map<string, any>) => {
                // Resolve a transformed id to its node — a regular mesh OR the thin-wrapper container (which
                // isn't in getAllMeshes). Applying to the container writes ITS transform (composes to children).
                const container = this._selectedThinWrapper;
                const resolve = (id: string): Mesh3D | MeshGroup3D | null =>
                    this.getMesh(id)
                    ?? (container && container.id === id ? container : null);
                const apply = (state: Map<string, any>) => {
                    for (const [id, s] of state) {
                        const t = resolve(id);
                        if (!t) continue;
                        t.x = s.x; t.y = s.y; t.z = s.z;
                        t.rotationX = s.rx; t.rotationY = s.ry; t.rotation = s.rz;
                        t.scaleX = s.sx; t.scaleY = s.sy; t.scaleZ = s.sz;
                        if (t instanceof MeshGroup3D) t.updateParentChainMatrix();
                    }
                    this.renderer3D.markInstancesDirty();
                    if (container) this._notifyThinWrapperSync(container);
                    this.ctx.scheduleRender();
                };
                this._undoManager.push({
                    description: 'Transform mesh',
                    undo: () => apply(before),
                    redo: () => apply(after),
                });
                // Mark all transformed meshes as save-dirty; persist the container's transform via its owner.
                for (const id of after.keys()) {
                    const m = this.getMesh(id);
                    if (m) m.stateDirty = true;
                }
                if (container) this._notifyThinWrapperSync(container);
                // Instance data (model matrices) changed — tell renderer to re-upload.
                this.renderer3D.markInstancesDirty();
                // Auto-key: snapshot every moved mesh's transform at the current frame.
                if (this.autoKey3D) {
                    for (const id of after.keys()) this.recordKeyframeForMesh(id);
                }
            },
            onGizmoDragStart: (axis: GizmoAxis) => {
                this.renderer3D.setDraggingAxis(axis);
            },
            onGizmoDragEnd: () => {
                this.renderer3D.setDraggingAxis(null);
            },
            onTransformDone: (meshIds: string[]) => {
                for (const id of meshIds) this._flaRestTransforms.delete(id);
            },
            isInMeshEditMode: () => this._isMeshEditModeFn?.() ?? false,
            isBoneOverlayActive: () => this._boneOverlayExplicit,
            // Per-mesh click-select suppression (Package-Creator paint target — see InteractionService).
            isPickSuppressed: (meshId: string) => this.ctx.interactionService.pickSuppressed3D?.(meshId) ?? false,
            getArrayGizmoData: () => this.renderer3D.getArrayGizmoData(),
            onArrayHandleHoverChange: (hovered: ArrayHandleHit) => {
                this.renderer3D.setArrayHandleHovered(hovered);
            },
            onArraySpacingDrag: (groupId: string, newSpacing: [number, number, number]) => {
                const g = this._getArrayGroup(groupId);
                if (!g) return;
                // Grid uses 'spacingX' for the X arm; linear uses 'spacing'.
                const key = g.arrayParams.mode === 'grid' ? 'spacingX' : 'spacing';
                for (const sg of this._getGroupSiblingArrays(groupId)) {
                    this.updateArrayParams3D(sg.id, { [key]: newSpacing } as any);
                }
            },
            onArraySpacingCommit: (groupId: string, oldSpacing: [number, number, number], newSpacing: [number, number, number]) => {
                const g0 = this._getArrayGroup(groupId);
                if (!g0) return;
                const key = g0.arrayParams.mode === 'grid' ? 'spacingX' : 'spacing';
                const siblingIds = this._getGroupSiblingArrays(groupId).map(sg => sg.id);
                this._undoManager.push({
                    description: 'Adjust array spacing',
                    undo: () => {
                        for (const sid of siblingIds) {
                            const g = this._getArrayGroup(sid);
                            if (g) Object.assign(g.arrayParams, { [key]: oldSpacing });
                        }
                        this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
                    },
                    redo: () => {
                        for (const sid of siblingIds) {
                            const g = this._getArrayGroup(sid);
                            if (g) Object.assign(g.arrayParams, { [key]: newSpacing });
                        }
                        this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
                    },
                });
            },
            onArraySpacingYDrag: (groupId: string, newSpacingY: [number, number, number]) => {
                for (const sg of this._getGroupSiblingArrays(groupId)) {
                    this.updateArrayParams3D(sg.id, { spacingY: newSpacingY } as any);
                }
            },
            onArraySpacingYCommit: (groupId: string, oldSpacingY: [number, number, number], newSpacingY: [number, number, number]) => {
                if (!this._getArrayGroup(groupId)) return;
                const siblingIds = this._getGroupSiblingArrays(groupId).map(sg => sg.id);
                this._undoManager.push({
                    description: 'Adjust grid Y spacing',
                    undo: () => {
                        for (const sid of siblingIds) {
                            const g = this._getArrayGroup(sid);
                            if (g) Object.assign(g.arrayParams, { spacingY: oldSpacingY });
                        }
                        this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
                    },
                    redo: () => {
                        for (const sid of siblingIds) {
                            const g = this._getArrayGroup(sid);
                            if (g) Object.assign(g.arrayParams, { spacingY: newSpacingY });
                        }
                        this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
                    },
                });
            },
            onArrayRadiusDrag: (groupId: string, newRadius: number) => {
                for (const sg of this._getGroupSiblingArrays(groupId)) {
                    this.updateArrayParams3D(sg.id, { radius: newRadius } as any);
                }
            },
            onArrayRadiusCommit: (groupId: string, oldRadius: number, newRadius: number) => {
                if (!this._getArrayGroup(groupId)) return;
                const siblingIds = this._getGroupSiblingArrays(groupId).map(sg => sg.id);
                this._undoManager.push({
                    description: 'Adjust radial array radius',
                    undo: () => {
                        for (const sid of siblingIds) {
                            const g = this._getArrayGroup(sid);
                            if (g) Object.assign(g.arrayParams, { radius: oldRadius });
                        }
                        this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
                    },
                    redo: () => {
                        for (const sid of siblingIds) {
                            const g = this._getArrayGroup(sid);
                            if (g) Object.assign(g.arrayParams, { radius: newRadius });
                        }
                        this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
                    },
                });
            },
            pickAdditional: (x: number, y: number, w: number, h: number): string | null => {
                const camera = this.renderer3D.getCamera();
                const { origin, dir } = this._picker.castRay(x, y, w, h, camera);
                let bestDist = Infinity;
                let bestGroupId: string | null = null;
                for (const node of this.ctx.sceneGraph.root.children) {
                    if (!(node instanceof ArrayGroup3D)) continue;
                    const source = this.getMesh(node.sourceId);
                    if (!source) continue;
                    const srcAABB = this.renderer3D.getMeshWorldAABB3D(source);
                    if (!srcAABB) continue;
                    const basis = (() => {
                        if (node.arrayParams.mode !== 'radial' || this._transformController?.orientationMode !== 'local') return undefined;
                        const m = source.localMatrix as Float32Array;
                        const c0 = Math.hypot(m[0], m[1], m[2]) || 1;
                        const c1 = Math.hypot(m[4], m[5], m[6]) || 1;
                        const c2 = Math.hypot(m[8], m[9], m[10]) || 1;
                        return { x: [m[0]/c0, m[1]/c0, m[2]/c0], y: [m[4]/c1, m[5]/c1, m[6]/c1], z: [m[8]/c2, m[9]/c2, m[10]/c2] } as LocalBasis3;
                    })();
                    const offsets = computeArrayOffsets(node.arrayParams, [source.x, source.y, source.z], basis);
                    for (const [ddx, ddy, ddz] of offsets) {
                        const t = _rayAABBIntersect(
                            origin[0], origin[1], origin[2],
                            dir[0], dir[1], dir[2],
                            srcAABB.minX + ddx, srcAABB.minY + ddy, srcAABB.minZ + ddz,
                            srcAABB.maxX + ddx, srcAABB.maxY + ddy, srcAABB.maxZ + ddz,
                        );
                        if (t !== null && t < bestDist) { bestDist = t; bestGroupId = node.id; }
                    }
                }
                return bestGroupId;
            },
        };

        this._transformController = new TransformController3D(callbacks, this._gizmoRenderer);
        // Pull-based: the renderer reads the live vertex-snap viz each frame (drawn on top of everything).
        this.renderer3D.setSnapVizProvider(() => this._transformController?.snapViz ?? null);

        // Mesh edit overlay — wireframe + selection highlights
        this._meshEditOverlay = new MeshEditOverlayRenderer(device, swapChainFormat);
        this.renderer3D.setMeshEditOverlayRenderer(this._meshEditOverlay);

        // Weight paint vertex dot overlay
        this.renderer3D.setWeightPaintVertexOverlay(new WeightPaintVertexOverlayRenderer(device, swapChainFormat));
        if (this._meshEditDataFn) {
            this.renderer3D.setMeshEditDataProvider(this._meshEditDataFn);
        }

        // Sync hover axis from controller to renderer each frame
        const syncCallback = () => {
            if (this._transformController && this._gizmoRenderer) {
                this.renderer3D.setHoveredGizmoAxis(this._transformController.hoveredAxis);
                this.renderer3D.setGizmoMode(this._transformController.mode);
                this.renderer3D.setHoveredCorner(this._transformController.hoveredCorner);
            }

            // Sync array gizmo data — check direct group selection (GPU instancing path) first,
            // then fall back to selected mesh being a child of a group (legacy path).
            let arrayGroup: ArrayGroup3D | null = null;
            if (this._selectedGroupId) {
                const node = this.ctx.sceneGraph.findNodeById(this._selectedGroupId);
                if (node instanceof ArrayGroup3D) arrayGroup = node;
            }
            if (!arrayGroup) {
                const selectedIds = this.renderer3D.getSelectedMeshIds();
                for (const id of selectedIds) {
                    const mesh = this.getMesh(id);
                    if (mesh?.parent instanceof ArrayGroup3D) { arrayGroup = mesh.parent; break; }
                }
            }
            if (arrayGroup) {
                const source = this.getMesh(arrayGroup.sourceId);
                if (source) {
                    const p = arrayGroup.arrayParams;
                    let data: ArrayGizmoData | null = null;   // explicit (procedural) arrays get no edit gizmo → stays null

                    if (p.mode === 'linear') {
                        const { countX, spacing } = p;
                        const len = Math.sqrt(spacing[0]**2 + spacing[1]**2 + spacing[2]**2) || 1;
                        data = {
                            groupId:        arrayGroup.id,
                            mode:           'linear',
                            sourcePos:      [source.x, source.y, source.z],
                            handlePos:      [source.x + countX * spacing[0], source.y + countX * spacing[1], source.z + countX * spacing[2]],
                            axisDir:        [spacing[0] / len, spacing[1] / len, spacing[2] / len],
                            countX,
                            currentSpacing: [...spacing] as [number, number, number],
                        };

                    } else if (p.mode === 'grid') {
                        const { countX, spacingX, countY, spacingY } = p;
                        const lenX = Math.sqrt(spacingX[0]**2 + spacingX[1]**2 + spacingX[2]**2) || 1;
                        const lenY = Math.sqrt(spacingY[0]**2 + spacingY[1]**2 + spacingY[2]**2) || 1;
                        data = {
                            groupId:         arrayGroup.id,
                            mode:            'grid',
                            sourcePos:       [source.x, source.y, source.z],
                            handlePos:       [source.x + countX * spacingX[0], source.y + countX * spacingX[1], source.z + countX * spacingX[2]],
                            axisDir:         [spacingX[0] / lenX, spacingX[1] / lenX, spacingX[2] / lenX],
                            countX,
                            currentSpacing:  [...spacingX] as [number, number, number],
                            handlePosY:      [source.x + countY * spacingY[0], source.y + countY * spacingY[1], source.z + countY * spacingY[2]],
                            axisDirY:        [spacingY[0] / lenY, spacingY[1] / lenY, spacingY[2] / lenY],
                            countY,
                            currentSpacingY: [...spacingY] as [number, number, number],
                        };

                    } else if (p.mode === 'radial') {
                        const { count, radius, axis, arcDeg, center } = p;

                        // Compute ring tangent/bitangent/normal — local or world orientation.
                        let radialTangent: [number, number, number] | undefined;
                        let radialBitangent: [number, number, number] | undefined;
                        let radialNormal: [number, number, number] | undefined;
                        if (this._transformController?.orientationMode === 'local') {
                            const m = source.localMatrix as Float32Array;
                            const c0 = Math.hypot(m[0], m[1], m[2]) || 1;
                            const c1 = Math.hypot(m[4], m[5], m[6]) || 1;
                            const c2 = Math.hypot(m[8], m[9], m[10]) || 1;
                            const lx: [number, number, number] = [m[0]/c0, m[1]/c0, m[2]/c0];
                            const ly: [number, number, number] = [m[4]/c1, m[5]/c1, m[6]/c1];
                            const lz: [number, number, number] = [m[8]/c2, m[9]/c2, m[10]/c2];
                            if (axis === 'y')      { radialTangent = lx; radialBitangent = lz; radialNormal = ly; }
                            else if (axis === 'x') { radialTangent = ly; radialBitangent = lz; radialNormal = lx; }
                            else                   { radialTangent = lx; radialBitangent = ly; radialNormal = lz; }
                        }

                        // Handle at angle 0: for x/y → center + radius * bitangent (cos=1 term);
                        //                    for z   → center + radius * tangent   (cos=1 term)
                        let handlePos: [number, number, number];
                        let axisDir: [number, number, number];
                        if (radialTangent && radialBitangent) {
                            const [pa0, pb0]: [number, number] = axis === 'z' ? [1, 0] : [0, 1];
                            handlePos = [
                                center[0] + radius * (pa0 * radialTangent[0] + pb0 * radialBitangent[0]),
                                center[1] + radius * (pa0 * radialTangent[1] + pb0 * radialBitangent[1]),
                                center[2] + radius * (pa0 * radialTangent[2] + pb0 * radialBitangent[2]),
                            ];
                            axisDir = axis === 'z' ? radialTangent : radialBitangent;
                        } else {
                            // world orientation — sin(0)=0, cos(0)=1
                            if (axis === 'y') {
                                handlePos = [center[0], center[1], center[2] + radius];
                                axisDir   = [0, 0, 1];
                            } else if (axis === 'x') {
                                handlePos = [center[0], center[1], center[2] + radius];
                                axisDir   = [0, 0, 1];
                            } else {
                                handlePos = [center[0] + radius, center[1], center[2]];
                                axisDir   = [1, 0, 0];
                            }
                        }

                        data = {
                            groupId:        arrayGroup.id,
                            mode:           'radial',
                            sourcePos:      center,
                            handlePos,
                            axisDir,
                            countX:         count,
                            currentSpacing: handlePos,  // not used for radial drag
                            radialCenter:   center,
                            currentRadius:  radius,
                            arcDeg,
                            radialAxis:     axis,
                            totalCount:     count,
                            radialTangent,
                            radialBitangent,
                            radialNormal,
                        };
                    }

                    this.renderer3D.setArrayGizmoData(data);
                } else {
                    this.renderer3D.setArrayGizmoData(null);
                }
            } else {
                this.renderer3D.setArrayGizmoData(null);
            }

            return false;
        };
        this._transformSyncCallback = syncCallback;
        this.ctx.webgpuRenderer.addPreRenderCallback(syncCallback);

        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (canvas) {
            this._transformController.attach(canvas as HTMLCanvasElement);
            this._setupBoneOverlayListeners();
        }
    }

    private _setupBoneOverlayListeners(): void {
        if (this._boneOverlayListenerCleanup) return; // already set up
        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (!canvas) return;

            // Canvas hover: update joint hover highlight; drive drag-to-move when dragging.
            const onMouseMove = (e: MouseEvent) => {
                const el = canvas as HTMLCanvasElement;
                const rect = el.getBoundingClientRect();
                const scaleX = el.width  / rect.width;
                const scaleY = el.height / rect.height;
                const px = (e.clientX - rect.left) * scaleX;
                const py = (e.clientY - rect.top)  * scaleY;

                // ── IK handle drag (target or pole) ─────────────────────────
                if (this._draggingIKHandle && this._boneOverlaySkeletonId) {
                    const skel = this.getSkeleton(this._boneOverlaySkeletonId);
                    const chain = skel?.data.ikChains?.find(c => c.id === this._draggingIKHandle!.chainId);
                    if (skel && chain) {
                        const camera = this.renderer3D.getCamera();
                        const { origin, dir } = this._picker.castRay(px, py, el.width, el.height, camera);
                        const denom = vec3.dot(dir as unknown as vec3, this._ikDragPlaneNormal);
                        if (Math.abs(denom) > 1e-6) {
                            const toPlane = vec3.sub(vec3.create(), this._ikDragPlanePoint, origin as unknown as vec3);
                            const t = vec3.dot(toPlane, this._ikDragPlaneNormal) / denom;
                            if (t > 0) {
                                const worldPt = vec3.scaleAndAdd(vec3.create(), origin as unknown as vec3, dir as unknown as vec3, t);
                                if (this._draggingIKHandle!.handleType === 'target') {
                                    chain.target = [worldPt[0], worldPt[1], worldPt[2]];
                                } else {
                                    chain.poleTarget = [worldPt[0], worldPt[1], worldPt[2]];
                                }
                                this.ctx.scheduleRender();
                            }
                        }
                    }
                    return;
                }

                // ── FK rotate drag ───────────────────────────────────────────
                if (this._isRotatingJoint && this._rotatingJointIdx !== null && this._rotatingJointAxis && this._boneOverlaySkeletonId) {
                    const skel = this.getSkeleton(this._boneOverlaySkeletonId);
                    if (skel) {
                        const dx = e.clientX - this._rotatingLastClientX;
                        const dy = e.clientY - this._rotatingLastClientY;
                        this._rotatingLastClientX = e.clientX;
                        this._rotatingLastClientY = e.clientY;
                        this._rotatingJointAccAngle += (dx + dy) * 0.01;
                        const a = this._rotatingJointAccAngle * 0.5;
                        const s = Math.sin(a), c = Math.cos(a);
                        const ax = this._rotatingJointAxis;
                        const dq: [number, number, number, number] =
                            ax === 'x' ? [s, 0, 0, c] :
                            ax === 'y' ? [0, s, 0, c] :
                                         [0, 0, s, c];
                        // Compose: delta * initialRotation (pre-multiply so delta is in world space)
                        const [ix, iy, iz, iw] = this._rotatingJointInitialQuat;
                        const [dx2, dy2, dz2, dw2] = dq;
                        const newQ: [number, number, number, number] = [
                            dw2*ix + dx2*iw + dy2*iz - dz2*iy,
                            dw2*iy - dx2*iz + dy2*iw + dz2*ix,
                            dw2*iz + dx2*iy - dy2*ix + dz2*iw,
                            dw2*iw - dx2*ix - dy2*iy - dz2*iz,
                        ];
                        skel.setJointRotation(this._rotatingJointIdx, newQ);
                        this.ctx.scheduleRender();
                    }
                    return;
                }

                // ── Joint gizmo axis drag ────────────────────────────────────
                if (this._isDraggingJointAxis && this._dragJointAxisAxis && this._selectedJointIndex !== null && this._boneOverlaySkeletonId) {
                    const skel = this.getSkeleton(this._boneOverlaySkeletonId);
                    if (skel) {
                        const j = skel.data.joints[this._selectedJointIndex];
                        if (j) {
                            const camera = this.renderer3D.getCamera();
                            const { origin, dir } = this._picker.castRay(px, py, el.width, el.height, camera);
                            const axisStr = this._dragJointAxisAxis;
                            const axisDir: vec3 = axisStr === 'x' ? vec3.fromValues(1,0,0) :
                                                  axisStr === 'y' ? vec3.fromValues(0,1,0) :
                                                  axisStr === 'z' ? vec3.fromValues(0,0,1) :
                                                  axisStr === 'xy' ? vec3.fromValues(0,0,1) :
                                                  axisStr === 'xz' ? vec3.fromValues(0,1,0) :
                                                                    vec3.fromValues(1,0,0); // yz
                            const isPlane = axisStr === 'xy' || axisStr === 'xz' || axisStr === 'yz';
                            let normal: vec3;
                            if (isPlane) {
                                normal = axisDir;
                            } else {
                                const camDir = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position as unknown as vec3, this._dragJointAxisJointStart));
                                normal = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axisDir, vec3.cross(vec3.create(), axisDir, camDir)));
                            }
                            const denom = vec3.dot(normal, dir as unknown as vec3);
                            if (Math.abs(denom) > 1e-6) {
                                const diff = vec3.subtract(vec3.create(), this._dragJointAxisJointStart, origin as unknown as vec3);
                                const t = vec3.dot(normal, diff) / denom;
                                if (t > 0) {
                                    const curPt = vec3.scaleAndAdd(vec3.create(), origin as unknown as vec3, dir as unknown as vec3, t);
                                    const disp = vec3.subtract(vec3.create(), curPt, this._dragJointAxisStartPt);
                                    let newWorldPos: vec3;
                                    if (isPlane) {
                                        newWorldPos = vec3.add(vec3.create(), this._dragJointAxisJointStart, disp);
                                    } else {
                                        const projDist = vec3.dot(disp, axisDir);
                                        newWorldPos = vec3.scaleAndAdd(vec3.create(), this._dragJointAxisJointStart, axisDir, projDist);
                                    }
                                    const invParent = mat4.create();
                                    if (j.parentIndex >= 0) {
                                        mat4.invert(invParent, skel.data.joints[j.parentIndex].worldMatrix as unknown as mat4);
                                    }
                                    const localPt = vec3.transformMat4(vec3.create(), newWorldPos, invParent);
                                    this.moveBone3D(skel.id, this._selectedJointIndex, [localPt[0], localPt[1], localPt[2]]);
                                }
                            }
                        }
                    }
                    return;
                }

                // ── Joint drag-to-move ───────────────────────────────────────
                // While the user holds the mouse down on a joint sphere, we
                // intersect the mouse ray with a camera-facing plane locked to
                // the joint's world position at drag start, then convert the
                // resulting world position back into the joint's local space.
                if (this._isDraggingJoint && this._dragJointIdx !== null && this._boneOverlaySkeletonId) {
                    const skel = this.getSkeleton(this._boneOverlaySkeletonId);
                    if (skel) {
                        const camera = this.renderer3D.getCamera();
                        const { origin, dir } = this._picker.castRay(px, py, el.width, el.height, camera);

                        // Ray-plane intersection: plane through _dragPlanePoint, normal _dragPlaneNormal
                        const denom = vec3.dot(dir as unknown as vec3, this._dragPlaneNormal);
                        if (Math.abs(denom) > 1e-6) {
                            const toPlane = vec3.sub(vec3.create(), this._dragPlanePoint, origin as unknown as vec3);
                            const t = vec3.dot(toPlane, this._dragPlaneNormal) / denom;
                            if (t > 0) {
                                const worldPt = vec3.scaleAndAdd(vec3.create(), origin as unknown as vec3, dir as unknown as vec3, t);
                                const j = skel.data.joints[this._dragJointIdx];
                                if (j) {
                                    // Convert world position → joint local space by inverting parent world matrix.
                                    // For root joints there is no parent, so local = world.
                                    const invParent = mat4.create();
                                    if (j.parentIndex >= 0) {
                                        mat4.invert(invParent, skel.data.joints[j.parentIndex].worldMatrix as unknown as mat4);
                                    }
                                    const localPt = vec3.transformMat4(vec3.create(), worldPt, invParent);
                                    this.moveBone3D(skel.id, this._dragJointIdx, [localPt[0], localPt[1], localPt[2]]);
                                }
                            }
                        }
                    }

                // Tail drag: move the tail sphere (updates tailOffset in the joint's own local frame).
                } else if (this._isDraggingTail && this._dragTailJointIdx !== null && this._boneOverlaySkeletonId) {
                    const skel = this.getSkeleton(this._boneOverlaySkeletonId);
                    if (skel) {
                        const camera = this.renderer3D.getCamera();
                        const { origin, dir } = this._picker.castRay(px, py, el.width, el.height, camera);
                        const denom = vec3.dot(dir as unknown as vec3, this._dragPlaneNormal);
                        if (Math.abs(denom) > 1e-6) {
                            const toPlane = vec3.sub(vec3.create(), this._dragPlanePoint, origin as unknown as vec3);
                            const t = vec3.dot(toPlane, this._dragPlaneNormal) / denom;
                            if (t > 0) {
                                const worldPt = vec3.scaleAndAdd(vec3.create(), origin as unknown as vec3, dir as unknown as vec3, t);
                                const j = skel.data.joints[this._dragTailJointIdx];
                                if (j) {
                                    // Convert world position → joint's own local frame.
                                    const invJoint = mat4.create();
                                    mat4.invert(invJoint, j.worldMatrix as unknown as mat4);
                                    const localPt = vec3.transformMat4(vec3.create(), worldPt, invJoint);
                                    skel.setJointTailOffset(this._dragTailJointIdx, [localPt[0], localPt[1], localPt[2]]);
                                    this.ctx.scheduleRender();
                                }
                            }
                        }
                    }
                    return; // skip hover logic while dragging
                }

                // ── Tail-follow preview for two-click root bone placement ────
                if (this._bonePlacementMode && this._bonePlacementPendingIdx !== null && this._bonePlacementSkeletonId) {
                    const skel = this.getSkeleton(this._bonePlacementSkeletonId);
                    if (skel) {
                        const camera = this.renderer3D.getCamera();
                        const { origin, dir } = this._picker.castRay(px, py, el.width, el.height, camera);
                        const meshHit = this._picker.pickMesh(px, py, el.width, el.height, camera, this.getAllMeshes());
                        let wX: number, wY: number, wZ: number;
                        if (meshHit) {
                            [wX, wY, wZ] = meshHit.hitPoint;
                        } else {
                            // Off-mesh: project onto camera-facing plane at the joint's depth
                            const j0 = skel.data.joints[this._bonePlacementPendingIdx];
                            const jDepth = j0 ? vec3.distance(
                                [j0.worldMatrix[12], j0.worldMatrix[13], j0.worldMatrix[14]] as unknown as vec3,
                                camera.position as unknown as vec3,
                            ) : 2;
                            wX = origin[0] + dir[0] * jDepth;
                            wY = origin[1] + dir[1] * jDepth;
                            wZ = origin[2] + dir[2] * jDepth;
                        }
                        const j = skel.data.joints[this._bonePlacementPendingIdx];
                        if (j) {
                            const invJ = mat4.create();
                            mat4.invert(invJ, j.worldMatrix as unknown as mat4);
                            const lt = vec3.transformMat4(vec3.create(), [wX, wY, wZ] as unknown as vec3, invJ);
                            skel.setJointTailOffset(this._bonePlacementPendingIdx, [lt[0], lt[1], lt[2]]);
                            this.ctx.scheduleRender();
                        }
                    }
                    // fall through to joint hover logic (shows the pending joint as selected)
                }

                // ── Normal hover (no drag active) ────────────────────────────
                // Suppress mesh hover highlight during bone placement — clicks belong to bone system.
                if (!this._bonePlacementMode) {
                    const hit = this.pick3D(px, py, el.width, el.height);
                    this.setHoveredMesh(hit?.meshId ?? null);
                }

                if (this._gizmoRenderer && this._boneOverlayExplicit && this._boneOverlaySkeletonId) {
                    const skel = this.getSkeleton(this._boneOverlaySkeletonId);
                    if (skel) {
                        const camera = this.renderer3D.getCamera();
                        const { origin, dir } = this._picker.castRay(px, py, el.width, el.height, camera);

                        // ── Joint gizmo hover (head-selected only; switches with tool mode) ──
                        let gizmoAxis: GizmoAxis = null;
                        if (this._selectedJointIndex !== null && !this._selectedJointIsTail) {
                            const j = skel.data.joints[this._selectedJointIndex];
                            if (j) {
                                const wp: [number, number, number] = [j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]];
                                gizmoAxis = this._armatureToolMode === 'rotate'
                                    ? this._gizmoRenderer.hitTestJointRotateGizmo(origin as unknown as vec3, dir as unknown as vec3, wp, camera)
                                    : this._gizmoRenderer.hitTestJointGizmo(origin as unknown as vec3, dir as unknown as vec3, wp, camera);
                            }
                        }
                        if (gizmoAxis !== this._jointGizmoHoveredAxis) {
                            this._jointGizmoHoveredAxis = gizmoAxis;
                            this.renderer3D.setJointGizmoHoveredAxis(gizmoAxis);
                            this.ctx.scheduleRender();
                        }

                        // ── IK handle hover (target or pole) ─────────────────────────
                        const enabledChains = (skel.data.ikChains ?? []).filter(c => c.enabled);
                        if (enabledChains.length > 0) {
                            const hit = this._gizmoRenderer.hitTestIKTargets(origin, dir, enabledChains, camera);
                            const same = hit?.chainId === this._hoveredIKHandle?.chainId
                                      && hit?.handleType === this._hoveredIKHandle?.handleType;
                            if (!same) {
                                this._hoveredIKHandle = hit;
                                this.renderer3D.setHoveredIKHandle(hit);
                                this.ctx.scheduleRender();
                            }
                        } else if (this._hoveredIKHandle !== null) {
                            this._hoveredIKHandle = null;
                            this.renderer3D.setHoveredIKHandle(null);
                            this.ctx.scheduleRender();
                        }

                        // ── Joint sphere hover (skip if over gizmo or IK handle) ────
                        if (!gizmoAxis && !this._hoveredIKHandle) {
                            const bv = this.renderer3D.getBoneVisibility();   // hidden bones aren't clickable
                            const hit = this._gizmoRenderer.hitTestJoint(origin, dir, skel, camera, bv.spring, bv.fk);
                            const newHead = hit && !hit.isTail ? hit.index : null;
                            const newTail = hit &&  hit.isTail ? hit.index : null;
                            if (newHead !== this._hoveredJointIndex || newTail !== this._hoveredTailJointIndex) {
                                this._hoveredJointIndex     = newHead;
                                this._hoveredTailJointIndex = newTail;
                                this.renderer3D.setHoveredJoint(newHead);
                                this.renderer3D.setHoveredTailJoint(newTail);
                                this.ctx.scheduleRender();
                            }
                        } else if (this._hoveredJointIndex !== null || this._hoveredTailJointIndex !== null) {
                            this._hoveredJointIndex     = null;
                            this._hoveredTailJointIndex = null;
                            this.renderer3D.setHoveredJoint(null);
                            this.renderer3D.setHoveredTailJoint(null);
                            this.ctx.scheduleRender();
                        }
                    }
                }
            };

            // Joint click / bone placement click
            const onMouseDown = (e: MouseEvent) => {
                const el2 = canvas as HTMLCanvasElement;
                const rect2 = el2.getBoundingClientRect();
                const px2 = (e.clientX - rect2.left) * (el2.width  / rect2.width);
                const py2 = (e.clientY - rect2.top)  * (el2.height / rect2.height);

                // ── Bone placement mode ────────────────────────────────────────
                if (this._bonePlacementMode && this._bonePlacementSkeletonId) {
                    const skel = this.getSkeleton(this._bonePlacementSkeletonId);
                    if (skel) {
                        const camera = this.renderer3D.getCamera();
                        const { origin, dir } = this._picker.castRay(px2, py2, el2.width, el2.height, camera);

                        // Guard: re-indexing on deletion can make cached index stale.
                        const rawParent = this._selectedJointIndex ?? -1;
                        const parentIdx = (rawParent >= 0 && rawParent < skel.data.joints.length) ? rawParent : -1;
                        if (rawParent !== parentIdx) {
                            this._selectedJointIndex = null;
                            this.renderer3D.setSelectedJoint(null);
                        }

                        if (parentIdx >= 0) {
                            // ── Child bone: single click ─────────────────────────────────────
                            // Tail-selected → head snaps to parent's tail (extend chain).
                            // Head-selected → head placed at parent's own position (branch here).
                            const meshHit = this._picker.pickMesh(px2, py2, el2.width, el2.height, camera, this.getAllMeshes());
                            if (!meshHit) { e.stopPropagation(); return; } // must hit mesh

                            const pj = skel.data.joints[parentIdx];
                            const localPos: [number, number, number] = this._selectedJointIsTail
                                ? [...pj.tailOffset] as [number, number, number]
                                : [0, 0, 0];
                            const newIdx = skel.addJoint(parentIdx, localPos, `joint_${skel.data.joints.length}`);
                            const nj = skel.data.joints[newIdx];
                            const invNJ = mat4.create();
                            mat4.invert(invNJ, nj.worldMatrix as unknown as mat4);
                            const [hX, hY, hZ] = meshHit.hitPoint;
                            const tailLocal = vec3.transformMat4(vec3.create(), [hX, hY, hZ] as unknown as vec3, invNJ);
                            skel.setJointTailOffset(newIdx, [tailLocal[0], tailLocal[1], tailLocal[2]]);

                            // Always select the new bone's tail — it's a leaf so the tail sphere renders.
                            // isTail=true means Add Bone immediately after will extend the chain from here.
                            this._selectedJointIndex = newIdx;
                            this._selectedJointIsTail = true;
                            this.renderer3D.setSelectedJoint(newIdx, true);
                            this._bonePlacementMode = false;
                            this._bonePlacementSkeletonId = null;
                            this._bonePlacementPendingIdx = null;
                            this.renderer3D.setBonePlacementActive(false);
                            this.ctx.emitSceneGraphChanged();
                            this.ctx.scheduleRender();

                        } else if (this._bonePlacementPendingIdx === null) {
                            // ── Root bone phase 1: head click — must hit mesh ──────────────
                            const meshHit = this._picker.pickMesh(px2, py2, el2.width, el2.height, camera, this.getAllMeshes());
                            if (!meshHit) { e.stopPropagation(); return; }

                            const [hX, hY, hZ] = meshHit.hitPoint;
                            // Add joint; tail will be updated live by mousemove → second click finalizes.
                            const newIdx = skel.addJoint(-1, [hX, hY, hZ], `joint_${skel.data.joints.length}`);
                            skel.setJointTailOffset(newIdx, [0, 0.05, 0]); // tiny placeholder until tail click
                            this._bonePlacementPendingIdx = newIdx;
                            this._selectedJointIndex = newIdx;
                            this.renderer3D.setSelectedJoint(newIdx);
                            this.ctx.scheduleRender();

                        } else {
                            // ── Root bone phase 2: tail click — must hit mesh ─────────────
                            const meshHit = this._picker.pickMesh(px2, py2, el2.width, el2.height, camera, this.getAllMeshes());
                            if (!meshHit) { e.stopPropagation(); return; } // keep phase alive

                            const pendingIdx = this._bonePlacementPendingIdx;
                            const j = skel.data.joints[pendingIdx];
                            if (j) {
                                const [tX, tY, tZ] = meshHit.hitPoint;
                                const invJ = mat4.create();
                                mat4.invert(invJ, j.worldMatrix as unknown as mat4);
                                const lt = vec3.transformMat4(vec3.create(), [tX, tY, tZ] as unknown as vec3, invJ);
                                skel.setJointTailOffset(pendingIdx, [lt[0], lt[1], lt[2]]);
                            }
                            // Switch selection to tail now that the bone is fully placed
                            this._selectedJointIsTail = true;
                            this.renderer3D.setSelectedJoint(pendingIdx, true);
                            this._bonePlacementMode = false;
                            this._bonePlacementSkeletonId = null;
                            this._bonePlacementPendingIdx = null;
                            this.renderer3D.setBonePlacementActive(false);
                            this.ctx.emitSceneGraphChanged();
                            this.ctx.scheduleRender();
                        }
                    }
                    e.stopPropagation();
                    return;
                }

                // ── Normal: select hovered joint and begin drag ──────────────
                // Only intercept clicks when the armature panel is explicitly open.
                if (!this._boneOverlayExplicit || !this._boneOverlaySkeletonId) return;

                const cam = this.renderer3D.getCamera();
                const pos = cam.position as unknown as vec3;
                const tgt = cam.target  as unknown as vec3;
                vec3.sub(this._dragPlaneNormal, pos, tgt);
                vec3.normalize(this._dragPlaneNormal, this._dragPlaneNormal);

                // ── FK rotate drag start ─────────────────────────────────────
                if (this._armatureToolMode === 'rotate' && this._jointGizmoHoveredAxis !== null
                    && (this._jointGizmoHoveredAxis === 'x' || this._jointGizmoHoveredAxis === 'y' || this._jointGizmoHoveredAxis === 'z')
                    && this._selectedJointIndex !== null && this._boneOverlaySkeletonId) {
                    const skelR = this.getSkeleton(this._boneOverlaySkeletonId);
                    if (skelR) {
                        const jr = skelR.data.joints[this._selectedJointIndex];
                        if (jr) {
                            this._isRotatingJoint = true;
                            this._rotatingJointIdx = this._selectedJointIndex;
                            this._rotatingJointAxis = this._jointGizmoHoveredAxis as 'x' | 'y' | 'z';
                            this._rotatingJointInitialQuat = [...jr.localRotation] as [number,number,number,number];
                            this._rotatingJointAccAngle = 0;
                            this._rotatingLastClientX = e.clientX;
                            this._rotatingLastClientY = e.clientY;
                            this.renderer3D.setJointGizmoDraggingAxis(this._jointGizmoHoveredAxis);
                            if (this._orbitController) this._orbitController.enabled = false;
                            e.stopPropagation();
                            return;
                        }
                    }
                }

                // ── Joint gizmo axis drag start ──────────────────────────────
                if (this._armatureToolMode === 'move' && this._jointGizmoHoveredAxis !== null && this._selectedJointIndex !== null && this._boneOverlaySkeletonId) {
                    const skelG = this.getSkeleton(this._boneOverlaySkeletonId);
                    if (skelG) {
                        const jg = skelG.data.joints[this._selectedJointIndex];
                        if (jg) {
                            const camera = this.renderer3D.getCamera();
                            const { origin, dir } = this._picker.castRay(px2, py2, el2.width, el2.height, camera);
                            const worldPos = vec3.fromValues(jg.worldMatrix[12], jg.worldMatrix[13], jg.worldMatrix[14]);
                            const axisStr = this._jointGizmoHoveredAxis;
                            const axisDir: vec3 = axisStr === 'x' ? vec3.fromValues(1,0,0) :
                                                  axisStr === 'y' ? vec3.fromValues(0,1,0) :
                                                  axisStr === 'z' ? vec3.fromValues(0,0,1) :
                                                  axisStr === 'xy' ? vec3.fromValues(0,0,1) :
                                                  axisStr === 'xz' ? vec3.fromValues(0,1,0) :
                                                                    vec3.fromValues(1,0,0); // yz
                            const isPlane = axisStr === 'xy' || axisStr === 'xz' || axisStr === 'yz';
                            let normal: vec3;
                            if (isPlane) {
                                normal = vec3.clone(axisDir);
                            } else {
                                const camDir = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position as unknown as vec3, worldPos));
                                normal = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axisDir, vec3.cross(vec3.create(), axisDir, camDir)));
                            }
                            const denom = vec3.dot(normal, dir as unknown as vec3);
                            if (Math.abs(denom) > 1e-6) {
                                const diff = vec3.subtract(vec3.create(), worldPos, origin as unknown as vec3);
                                const t = vec3.dot(normal, diff) / denom;
                                if (t > 0) {
                                    this._isDraggingJointAxis = true;
                                    this._dragJointAxisAxis = axisStr;
                                    vec3.scaleAndAdd(this._dragJointAxisStartPt, origin as unknown as vec3, dir as unknown as vec3, t);
                                    vec3.copy(this._dragJointAxisJointStart, worldPos);
                                    this.renderer3D.setJointGizmoDraggingAxis(axisStr);
                                    // Prevent the orbit controller from also starting a drag on this same click.
                                    if (this._orbitController) this._orbitController.enabled = false;
                                    e.stopPropagation();
                                    return;
                                }
                            }
                        }
                    }
                }

                // ── IK handle drag start (target or pole) ─────────────────────
                if (this._hoveredIKHandle && this._boneOverlaySkeletonId) {
                    const skelIK = this.getSkeleton(this._boneOverlaySkeletonId);
                    const chainIK = skelIK?.data.ikChains?.find(c => c.id === this._hoveredIKHandle!.chainId);
                    const isPole = this._hoveredIKHandle!.handleType === 'pole';
                    if (skelIK && chainIK && (!isPole || chainIK.poleTarget)) {
                        this._draggingIKHandle = { ...this._hoveredIKHandle! };
                        this.renderer3D.setDraggingIKHandle(this._draggingIKHandle);
                        // Build camera-facing drag plane at the handle's current position
                        const handlePos = isPole ? chainIK.poleTarget! : chainIK.target;
                        const camPos = this.renderer3D.getCamera().position as unknown as vec3;
                        const camTgt = this.renderer3D.getCamera().target  as unknown as vec3;
                        vec3.sub(this._ikDragPlaneNormal, camPos, camTgt);
                        vec3.normalize(this._ikDragPlaneNormal, this._ikDragPlaneNormal);
                        vec3.set(this._ikDragPlanePoint, handlePos[0], handlePos[1], handlePos[2]);
                        if (this._orbitController) this._orbitController.enabled = false;
                        e.stopPropagation();
                        return;
                    }
                }

                // ── Tail handle drag ──────────────────────────────────────────
                if (this._hoveredTailJointIndex !== null && !this._weightPaint.isActive()) {
                    const skel = this.getSkeleton(this._boneOverlaySkeletonId);
                    if (skel) {
                        const j = skel.data.joints[this._hoveredTailJointIndex];
                        if (j) {
                            // Select the owning joint so panel XYZ inputs activate
                            this._selectedJointIndex = this._hoveredTailJointIndex;
                            this._selectedJointIsTail = true; // tail sphere → extend-chain semantics
                            this.renderer3D.setSelectedJoint(this._selectedJointIndex, true);
                            this.ctx.emitSceneGraphChanged();
                            // Drag plane at the tail world position
                            const wm = j.worldMatrix;
                            const to = j.tailOffset ?? [0, 0.3, 0];
                            vec3.set(this._dragPlanePoint,
                                wm[0]*to[0] + wm[4]*to[1] + wm[8]*to[2]  + wm[12],
                                wm[1]*to[0] + wm[5]*to[1] + wm[9]*to[2]  + wm[13],
                                wm[2]*to[0] + wm[6]*to[1] + wm[10]*to[2] + wm[14],
                            );
                            if (this._orbitController) this._orbitController.enabled = false;
                            this._isDraggingTail   = true;
                            this._dragTailJointIdx = this._hoveredTailJointIndex;
                        }
                    }
                    e.stopPropagation();
                    return;
                }

                // ── Head sphere drag ──────────────────────────────────────────
                if (this._hoveredJointIndex === null) return;

                // Select the clicked joint and emit so the panel syncs
                this._selectedJointIndex = this._hoveredJointIndex;
                this._selectedJointIsTail = false; // head sphere → branch-here semantics
                this.renderer3D.setSelectedJoint(this._selectedJointIndex);
                this.ctx.emitSceneGraphChanged();
                this.ctx.scheduleRender();

                // Begin drag: lock a camera-facing plane to the joint world position.
                // Dragging is suppressed during weight paint — clicking a joint just selects it.
                const skelHead = this.getSkeleton(this._boneOverlaySkeletonId);
                if (skelHead && !this._weightPaint.isActive()) {
                    const j = skelHead.data.joints[this._hoveredJointIndex];
                    if (j) {
                        if (this._orbitController) this._orbitController.enabled = false;
                        this._isDraggingJoint = true;
                        this._dragJointIdx = this._hoveredJointIndex;
                        vec3.set(this._dragPlanePoint, j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]);
                    }
                }
                e.stopPropagation(); // prevent mesh deselect on joint click
            };

            // End drag on mouse-up; emit so panel refreshes final position.
            const onMouseUp = () => {
                // Re-enable orbit after joint drag — but not if weight paint mode is holding it disabled.
                if (this._orbitController && !this._weightPaint.isActive()) this._orbitController.enabled = true;
                if (this._draggingIKHandle) {
                    this._draggingIKHandle = null;
                    this.renderer3D.setDraggingIKHandle(null);
                    this.ctx.emitSceneGraphChanged();
                }
                if (this._isRotatingJoint) {
                    this._isRotatingJoint = false;
                    this._rotatingJointIdx = null;
                    this._rotatingJointAxis = null;
                    this.renderer3D.setJointGizmoDraggingAxis(null);
                    this.ctx.emitSceneGraphChanged();
                }
                if (this._isDraggingJointAxis) {
                    this._isDraggingJointAxis = false;
                    this._dragJointAxisAxis = null;
                    this.renderer3D.setJointGizmoDraggingAxis(null);
                    this.ctx.emitSceneGraphChanged();
                }
                if (this._isDraggingJoint) {
                    this._isDraggingJoint = false;
                    this._dragJointIdx = null;
                    this.ctx.emitSceneGraphChanged();
                }
                if (this._isDraggingTail) {
                    this._isDraggingTail   = false;
                    this._dragTailJointIdx = null;
                    this.ctx.emitSceneGraphChanged();
                }
            };

            const onMouseLeave = () => {
                this.setHoveredMesh(null);
                if (this._draggingIKHandle) {
                    this._draggingIKHandle = null;
                    this.renderer3D.setDraggingIKHandle(null);
                }
                if (this._hoveredIKHandle) {
                    this._hoveredIKHandle = null;
                    this.renderer3D.setHoveredIKHandle(null);
                    this.ctx.scheduleRender();
                }
                if (this._isRotatingJoint) {
                    this._isRotatingJoint = false;
                    this._rotatingJointIdx = null;
                    this._rotatingJointAxis = null;
                    this.renderer3D.setJointGizmoDraggingAxis(null);
                }
                if (this._isDraggingJointAxis) {
                    this._isDraggingJointAxis = false;
                    this._dragJointAxisAxis = null;
                    this.renderer3D.setJointGizmoDraggingAxis(null);
                }
                if (this._isDraggingJoint) {
                    this._isDraggingJoint = false;
                    this._dragJointIdx = null;
                }
                if (this._isDraggingTail) {
                    this._isDraggingTail   = false;
                    this._dragTailJointIdx = null;
                }
                if (this._hoveredJointIndex !== null) {
                    this._hoveredJointIndex = null;
                    this.renderer3D.setHoveredJoint(null);
                    this.ctx.scheduleRender();
                }
                if (this._jointGizmoHoveredAxis !== null) {
                    this._jointGizmoHoveredAxis = null;
                    this.renderer3D.setJointGizmoHoveredAxis(null);
                    this.ctx.scheduleRender();
                }
            };

            addZonelessListener((canvas as HTMLCanvasElement), 'mousemove', onMouseMove);
            addZonelessListener((canvas as HTMLCanvasElement), 'mouseleave', onMouseLeave);
            addZonelessListener((canvas as HTMLCanvasElement), 'mousedown', onMouseDown);
            addZonelessListener((canvas as HTMLCanvasElement), 'mouseup',   onMouseUp);
            this._boneOverlayListenerCleanup = () => {
                removeZonelessListener((canvas as HTMLCanvasElement), 'mousemove',  onMouseMove);
                removeZonelessListener((canvas as HTMLCanvasElement), 'mouseleave', onMouseLeave);
                removeZonelessListener((canvas as HTMLCanvasElement), 'mousedown',  onMouseDown);
                removeZonelessListener((canvas as HTMLCanvasElement), 'mouseup',    onMouseUp);
            };
    }

    disableTransformControls(): void {
        this._setThinWrapper(null);   // drop any thin-wrapper gizmo target so it can't draw a phantom box
        this._boneOverlayListenerCleanup?.();
        this._boneOverlayListenerCleanup = undefined;
        // Remove the per-frame gizmo-sync callback (else it leaks + runs every frame forever — see field doc).
        if (this._transformSyncCallback) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._transformSyncCallback);
            this._transformSyncCallback = undefined;
        }
        this._transformController?.detach();
        this._transformController = undefined;
        if (this._gizmoRenderer) {
            this.renderer3D.setGizmoRenderer(undefined as any);
            this._gizmoRenderer.destroy();
            this._gizmoRenderer = undefined;
        }
        if (this._meshEditOverlay) {
            this.renderer3D.setMeshEditOverlayRenderer(undefined);
            this.renderer3D.setMeshEditDataProvider(undefined);
            this._meshEditOverlay.destroy();
            this._meshEditOverlay = undefined;
        }
        // Clear bone overlay, drag, and placement state
        this._armatureSavedMeshRotation = null; // discarded without restore on forced teardown
        this._boneOverlayExplicit = false;
        this._boneOverlaySkeletonId = null;
        this._selectedJointIndex = null;
        this._hoveredJointIndex = null;
        this._armatureOrbitCenter = null;
        this._armatureOrthoX = 0;
        this._armatureOrthoY = 0;
        this._armatureIllustrationCx = 0;
        this._armatureIllustrationCy = 0;
        this.renderer3D.getCamera().orthoOffsetX = 0;
        this.renderer3D.getCamera().orthoOffsetY = 0;
        this._isDraggingJoint = false;
        this._dragJointIdx = null;
        this._isDraggingTail = false;
        this._dragTailJointIdx = null;
        this._hoveredTailJointIndex = null;
        this.renderer3D.setHoveredTailJoint(null);
        this._bonePlacementMode = false;
        this._bonePlacementSkeletonId = null;
        this.renderer3D.setBonePlacementActive(false);
    }

    setGizmoMode(mode: GizmoMode): void {
        if (this._transformController) this._transformController.mode = mode;
        this.renderer3D.setGizmoMode(mode);
        this.ctx.scheduleRender();
    }

    getGizmoMode(): GizmoMode {
        return this.renderer3D.getGizmoMode();
    }

    setGizmoOrientation(mode: 'world' | 'local'): void {
        if (this._transformController) this._transformController.orientationMode = mode;
        else if (this._gizmoRenderer)  this._gizmoRenderer.orientationMode = mode;
        this.ctx.scheduleRender();
    }

    getGizmoOrientation(): 'world' | 'local' {
        return this._transformController?.orientationMode ?? this._gizmoRenderer?.orientationMode ?? 'world';
    }

    get snapGridSize(): number { return this._transformController?.snapGridSize ?? 1.0; }

    set snapGridSize(v: number) { if (this._transformController) this._transformController.snapGridSize = v; this._pushGridConfig(); }

    get snapAngle(): number { return this._transformController?.snapAngle ?? Math.PI / 12; }

    set snapAngle(v: number) { if (this._transformController) this._transformController.snapAngle = v; }

    get snapScaleStep(): number { return this._transformController?.snapScaleStep ?? 0.25; }

    set snapScaleStep(v: number) { if (this._transformController) this._transformController.snapScaleStep = v; }

    get snapActive(): boolean { return this._transformController?.snapActive ?? false; }

    getDragInfo(): {
        isDragging: boolean;
        mode: GizmoMode;
        axis: GizmoAxis;
        angleDeg: number | null;
        gizmoCenterWorld: [number, number, number] | null;
    } {
        const tc = this._transformController;
        if (!tc || !tc.isDragging) {
            return { isDragging: false, mode: this.renderer3D.getGizmoMode(), axis: null, angleDeg: null, gizmoCenterWorld: null };
        }
        return {
            isDragging: true,
            mode: this.renderer3D.getGizmoMode(),
            axis: this.renderer3D.getDraggingAxis(),
            angleDeg: tc.dragAngleDeg,
            gizmoCenterWorld: tc.dragGizmoCenter,
        };
    }

    get snapMode(): SnapMode { return this._transformController?.snapMode ?? 'grid'; }

    set snapMode(m: SnapMode) { if (this._transformController) this._transformController.snapMode = m; }

    getSnapTarget(): [number, number, number] | null {
        return this._transformController?.snapTarget ?? null;
    }

    getSnapViz(): SnapVizData | null {
        return this._transformController?.snapViz ?? null;
    }

    get snapVertexRadiusPx(): number { return this._transformController?.snapVertexRadiusPx ?? 20; }

    set snapVertexRadiusPx(v: number) { if (this._transformController) this._transformController.snapVertexRadiusPx = v; }

    get snapCandidateRadiusPx(): number { return this._transformController?.snapCandidateRadiusPx ?? 50; }

    set snapCandidateRadiusPx(v: number) { if (this._transformController) this._transformController.snapCandidateRadiusPx = v; }

    beginTransform3D(mode: 'grab' | 'rotate' | 'scale'): void {
        this._transformController?.beginTransform3D(mode);
    }

    commitTransform3D(): void {
        this._transformController?.commitTransform3D();
    }

    cancelTransform3D(): void {
        this._transformController?.cancelTransform3D();
    }

    moveBone3D(skeletonId: string, jointIndex: number, localPos: [number, number, number]): void {
        this.getSkeleton(skeletonId)?.moveJoint(jointIndex, localPos);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    setJointTailOffset3D(skeletonId: string, jointIndex: number, offset: [number, number, number]): void {
        this.getSkeleton(skeletonId)?.setJointTailOffset(jointIndex, offset);
        this.ctx.scheduleRender();
    }

    removeBone3D(skeletonId: string, jointIndex: number): void {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return;
        skel.removeJoint(jointIndex);
        // removeJoint re-indexes joints — any cached index is now stale. Clear
        // both selected and hovered so the next click re-establishes a clean state.
        this._selectedJointIndex = null;
        this._hoveredJointIndex = null;
        this._hoveredTailJointIndex = null;
        this.renderer3D.setSelectedJoint(null);
        this.renderer3D.setHoveredJoint(null);
        this.renderer3D.setHoveredTailJoint(null);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    renameBone3D(skeletonId: string, jointIndex: number, name: string): void {
        this.getSkeleton(skeletonId)?.renameJoint(jointIndex, name);
        this.ctx.emitSceneGraphChanged();
    }

    setWeightPaintShowSkeleton(show: boolean): void {
        this.renderer3D.setWeightPaintShowSkeleton(show);
        this.ctx.scheduleRender();
    }

    setBoneVisibility(showSpring: boolean, showFk: boolean): void {
        this.renderer3D.setBoneVisibility(showSpring, showFk);
        this.ctx.scheduleRender();
    }

    getBoneVisibility(): { spring: boolean; fk: boolean } { return this.renderer3D.getBoneVisibility(); }

    setWeightPaintUnlit(unlit: boolean): void {
        this.renderer3D.setWeightPaintUnlit(unlit);
        this.ctx.scheduleRender();
    }

    addIKChain(skelId: string, endJointIdx: number, chainLength: number): string {
        const skel = this.getSkeleton(skelId);
        if (!skel) return '';
        if (!skel.data.ikChains) skel.data.ikChains = [];
        const joint = skel.data.joints[endJointIdx];
        const initTarget: [number, number, number] = joint
            ? [joint.worldMatrix[12], joint.worldMatrix[13], joint.worldMatrix[14]]
            : [0, 0, 0];
        const chain: IKChain = {
            id: _nanoid(),
            endJointIdx,
            chainLength: Math.max(2, chainLength),
            target: initTarget,
            blendWeight: 1,
            enabled: true,
        };
        skel.data.ikChains.push(chain);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return chain.id;
    }

    removeIKChain(skelId: string, chainId: string): void {
        const skel = this.getSkeleton(skelId);
        if (!skel?.data.ikChains) return;
        const idx = skel.data.ikChains.findIndex(c => c.id === chainId);
        if (idx < 0) return;
        // Clear ikRotation on joints that belonged to this chain
        const chain = skel.data.ikChains[idx];
        let cur = chain.endJointIdx;
        for (let i = 0; i <= chain.chainLength && cur >= 0; i++) {
            skel.data.joints[cur].ikRotation = undefined;
            cur = skel.data.joints[cur].parentIndex;
        }
        skel.data.ikChains.splice(idx, 1);
        if (this._hoveredIKHandle?.chainId === chainId) {
            this._hoveredIKHandle = null;
            this.renderer3D.setHoveredIKHandle(null);
        }
        if (this._draggingIKHandle?.chainId === chainId) {
            this._draggingIKHandle = null;
            this.renderer3D.setDraggingIKHandle(null);
            if (this._orbitController) this._orbitController.enabled = true;
        }
        skel.computeWorldMatrices();
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    getIKChains(skelId: string): IKChain[] {
        return this.getSkeleton(skelId)?.data.ikChains ?? [];
    }

    setIKTarget(skelId: string, chainId: string, x: number, y: number, z: number): void {
        const chain = this.getSkeleton(skelId)?.data.ikChains?.find(c => c.id === chainId);
        if (!chain) return;
        chain.target = [x, y, z];
        this.ctx.scheduleRender();
    }

    setIKChainEnabled(skelId: string, chainId: string, enabled: boolean): void {
        const skel = this.getSkeleton(skelId);
        const chain = skel?.data.ikChains?.find(c => c.id === chainId);
        if (!chain || !skel) return;
        chain.enabled = enabled;
        if (!enabled) clearAllIKRotations(skel);
        skel.computeWorldMatrices();
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    setIKChainLength(skelId: string, chainId: string, chainLength: number): void {
        const chain = this.getSkeleton(skelId)?.data.ikChains?.find(c => c.id === chainId);
        if (!chain) return;
        chain.chainLength = Math.max(2, chainLength);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    setIKBlendWeight(skelId: string, chainId: string, weight: number): void {
        const chain = this.getSkeleton(skelId)?.data.ikChains?.find(c => c.id === chainId);
        if (!chain) return;
        chain.blendWeight = Math.max(0, Math.min(1, weight));
        this.ctx.scheduleRender();
    }

    setPoleTarget(skelId: string, chainId: string, x: number, y: number, z: number): void {
        const chain = this.getSkeleton(skelId)?.data.ikChains?.find(c => c.id === chainId);
        if (!chain) return;
        chain.poleTarget = [x, y, z];
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    clearPoleTarget(skelId: string, chainId: string): void {
        const chain = this.getSkeleton(skelId)?.data.ikChains?.find(c => c.id === chainId);
        if (!chain) return;
        delete chain.poleTarget;
        // Clear dragging/hovering if they were on this chain's pole handle
        if (this._hoveredIKHandle?.chainId === chainId && this._hoveredIKHandle.handleType === 'pole') {
            this._hoveredIKHandle = null;
            this.renderer3D.setHoveredIKHandle(null);
        }
        if (this._draggingIKHandle?.chainId === chainId && this._draggingIKHandle.handleType === 'pole') {
            this._draggingIKHandle = null;
            this.renderer3D.setDraggingIKHandle(null);
            if (this._orbitController) this._orbitController.enabled = true;
        }
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    highlightJoint3D(jointIndex: number | null): void {
        this.renderer3D.setHighlightJoint(jointIndex);
        this.ctx.scheduleRender();
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════════
    // Bridge accessors — small public reads/writes so NON-tangle Scene3DManager code (and its subsystem
    // host-closures) can reach tangle-owned state without moving that code here. Added for Phase B splice.
    // ══════════════════════════════════════════════════════════════════════════════════════════════════

    /** Public wrapper so the manager's kept `_applyIllustrationCamera` private delegator can drive it. */
    applyIllustrationCamera(): void { this._applyIllustrationCamera(); }
    /** Public wrapper so the manager's kept `_forceIllustrationResync` private delegator can drive it. */
    forceIllustrationResync(): void { this._forceIllustrationResync(); }
    /** Public wrapper so the manager's kept `_setThinWrapper` private delegator can drive it. */
    setSelectedThinWrapper(node: MeshGroup3D | null): void { this._setThinWrapper(node); }

    /** The live illustration-camera sync record (null when no 2D camera sync is active). */
    getIllustrationSync(): { panX: number; panY: number; zoom: number; canvasW: number; canvasH: number } | null { return this._illustrationSync; }
    /** Stored projection preference — persistence reads/writes it via the manager. */
    get illustrationProjection(): 'perspective' | 'orthographic' { return this._illustrationProjection; }
    set illustrationProjection(mode: 'perspective' | 'orthographic') { this._illustrationProjection = mode; }

    /** The transform gizmo controller (undefined until enableTransformControls). */
    getTransformController(): TransformController3D | undefined { return this._transformController; }
    /** The gizmo renderer (undefined until enableTransformControls). */
    getGizmoRenderer(): GizmoRenderer | undefined { return this._gizmoRenderer; }
    /** Mesh-edit orbit-center anchor (null when not in mesh-edit orbit). */
    getMeshEditOrbitCenter(): [number, number, number] | null { return this._meshEditOrbitCenter; }
    /** Whether the Armature panel has pinned the bone overlay. */
    isBoneOverlayActive(): boolean { return this._boneOverlayExplicit; }
    /** The last directly-selected ArrayGroup3D id (null when none). */
    getSelectedGroupId(): string | null { return this._selectedGroupId; }
    setSelectedGroupId(id: string | null): void { this._selectedGroupId = id; }
    /** The thin-wrapper container currently selected as a unit (null when the selection isn't one). */
    getSelectedThinWrapper(): MeshGroup3D | null { return this._selectedThinWrapper; }
    /** The thin-wrapper transform-sync listener list (owners mirror the container's live transform). */
    getThinWrapperTransformSyncs(): ((container: MeshGroup3D) => void)[] { return this._thinWrapperTransformSyncs; }

    // Mesh-edit / City orbit-center lock — enterCityMode3D/exitCityMode3D (non-moved) claim the same
    // camera-lock the mesh-edit orbit uses, so they drive these through accessors.
    setMeshEditOrbitCenter(v: [number, number, number] | null): void { this._meshEditOrbitCenter = v; }
    get meshEditOrthoX(): number { return this._meshEditOrthoX; }
    set meshEditOrthoX(v: number) { this._meshEditOrthoX = v; }
    get meshEditOrthoY(): number { return this._meshEditOrthoY; }
    set meshEditOrthoY(v: number) { this._meshEditOrthoY = v; }
    get meshEditIllustrationCx(): number { return this._meshEditIllustrationCx; }
    set meshEditIllustrationCx(v: number) { this._meshEditIllustrationCx = v; }
    get meshEditIllustrationCy(): number { return this._meshEditIllustrationCy; }
    set meshEditIllustrationCy(v: number) { this._meshEditIllustrationCy = v; }

}
