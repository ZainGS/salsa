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
import { ParticleEmitter3D } from '../../scene-graph/shapes/particle-emitter-3d';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { WeightPaintVertexOverlayRenderer } from '../../renderer/3d/weight-paint-overlay-renderer';
import { Mesh3D } from '../../scene-graph/shapes/mesh-3d';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { ArrayGroup3D, ArrayParams, computeArrayOffsets, LocalBasis3 } from '../../scene-graph/shapes/array-group-3d';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import { SkinnedMesh3D } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { IKChain } from '../../types/armature-3d';
import { clearAllIKRotations } from '../../renderer/3d/ik-solver';
import { solveIKAndConstraints } from '../../renderer/3d/constraint-solver';
import { solveSpringBones, resetSpringState } from '../../renderer/3d/spring-bone-solver';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import { constrainCharacterScale, geometryMinY } from '../../game/character-scale';
import type { UndoManager3D } from './undo-manager-3d';
import type { Scene3DCharacter } from './scene3d-character';
import type { Scene3DWeightPaint } from './scene3d-weight-paint';
import { ArmaturePointerGesture, type ArmClientRect } from './armature-pointer-gesture';
import { claimPointerEvent } from '../../renderer/util/pointer-claims';

/** Short random id (module-local, mirrors the Scene3DManager helper). Used by addIKChain. */
const _nanoid = () => Math.random().toString(36).slice(2, 10);

/** The armature tool strip (UI review 2026-10-07 §4). */
export type ArmatureTool = 'select' | 'rotate' | 'move' | 'addbone' | 'ik' | 'weight';
export const ARMATURE_TOOLS: readonly ArmatureTool[] = ['select', 'rotate', 'move', 'addbone', 'ik', 'weight'];

/** What an armature press grabs (TOUCH-9 pick-on-down): bone placement (a tap), the FK rotate ring, the joint move
 *  gizmo (with its drag plane start), an IK handle, a tail sphere or a head sphere. */
export type ArmTarget =
    | { kind: 'place' }
    | { kind: 'rotate'; joint: number; axis: 'x' | 'y' | 'z' }
    | { kind: 'axis'; joint: number; axis: Exclude<GizmoAxis, null>; startPt: vec3; jointStart: vec3 }
    | { kind: 'ik'; handle: IKHandleHit }
    | { kind: 'tail'; joint: number }
    | { kind: 'head'; joint: number };

/** A head press in progress (see Scene3DArmature._armHead). */
type ArmHeadPress = { skelId: string; joint: number; p0: [number, number, number]; x: number; y: number; slop: number; pending: boolean };

/** World direction of a joint-gizmo axis (a plane handle → its normal). */
function _jointAxisDir(a: GizmoAxis): vec3 {
    return a === 'x' ? vec3.fromValues(1, 0, 0) : a === 'y' ? vec3.fromValues(0, 1, 0) : a === 'z' ? vec3.fromValues(0, 0, 1)
        : a === 'xy' ? vec3.fromValues(0, 0, 1) : a === 'xz' ? vec3.fromValues(0, 1, 0) : vec3.fromValues(1, 0, 0);   // yz
}
/** Scratch vectors for the per-move ray / plane intersection (no allocation per pointer move). */
/** Edit Mesh / UV entry view (UI review 2026-10-07 §3 #17): a 3/4 view from the front-right, above (radians; azimuth
 *  0 = looking down −Z from +Z, positive = from +X), framed so the mesh fills ~60 % of the view (1 / 1.7). */
export const EDIT_VIEW_AZIMUTH = 0.6;
export const EDIT_VIEW_ELEVATION = 0.45;
export const EDIT_VIEW_PADDING = 1.7;
/** Re-entering the same mesh's edit view within this long after leaving it is a mode SWITCH: the camera is kept. */
export const EDIT_CAMERA_KEEP_MS = 1500;
/** Armature entry framing: the mesh from the current direction (front-on from the 2D view), filling most of the view. */
export const ARMATURE_VIEW_PADDING = 1.33;
/** Which edit mode owns the decoupled edit camera: Edit Mesh / UV editor, or the Armature. */
export type EditViewOwner = 'meshEdit' | 'armature';
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const _armTmpA = vec3.create();
const _armTmpB = vec3.create();

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
    /** Round 8: 3D Play mode is running — every editor pointer path (hover pick, click-select, gizmo) is off. */
    readonly isPlaying: boolean;
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
    /** SIM LOD (src/world/sim-lod.ts): reset a system's per-frame counters; should this skeleton's springs solve
     *  this frame (NEAR band only; exempt: the player, the selection, posing, scripts, previews)? Absent = always. */
    simLodBegin?(system: string): void;
    simLodSpringsDue?(skelId: string): boolean;
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
    /** Host hide flag (setViewGizmoHidden) — applied to every gizmo instance, current and future. */
    private _viewGizmoHidden = false;

    // ── (a) gizmo ────────────────────────────────────────────────────────────────────────────────────
    private _gizmoRenderer?: GizmoRenderer;
    private _meshEditOverlay?: MeshEditOverlayRenderer;
    private _transformController?: TransformController3D;
    private _transformSyncCallback?: () => boolean;
    private _isMeshEditModeFn?: () => boolean;
    private _meshEditDataFn?: () => MeshEditDrawData | null;

    // ── (b) bone overlay + joint ─────────────────────────────────────────────────────────────────────
    private _boneOverlaySkeletonId: string | null = null;
    /** The PRIMARY selected joint (the gizmo's). An accessor (UI review §4): any change notifies the joint-selection
     *  listeners, and a change made by the legacy single-select paths drops the rest of a multi-selection. */
    private __selJoint: number | null = null;
    private get _selectedJointIndex(): number | null { return this.__selJoint; }
    private set _selectedJointIndex(v: number | null) {
        if (v === this.__selJoint) return;
        this.__selJoint = v;
        if (!this._jointSelKeepExtras && this._extraJoints.size > 0) { this._extraJoints.clear(); this._syncExtraJoints(); }
        this._emitJointSelection();
    }
    /** The other joints of a multi-selection (additive tap / selectArmatureJoint3D(…, true)), in selection order. */
    private _extraJoints = new Set<number>();
    private _jointSelKeepExtras = false;
    private _jointSelListeners = new Set<(sel: { skeletonId: string; jointIndex: number }[]) => void>();
    private _jointSelKey = '';
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
    /** Edit-mesh mode's OWN ortho zoom, DECOUPLED from the 2D illustration zoom. Non-null only while
     *  Edit Mesh mode is active (set by enableMeshEditOrbit). When set, the orbit update derives
     *  orthoSize from this instead of `_illustrationSync.zoom`, so (a) the mesh is framed to a sensible
     *  size on entry regardless of the artboard zoom, and (b) zooming in edit mode never mutates the
     *  2D canvas zoom. Surface-paint / group-orbit leave this null and keep the illustration weld. */
    private _meshEditZoom: number | null = null;
    /** Teardown for the capture-phase wheel interceptor installed while Edit Mesh mode is active. */
    private _meshEditWheelCleanup: (() => void) | null = null;
    /** interactionService.cameraOwnsView value before entering Edit Mesh (restored on exit). Edit Mesh needs
     *  cameraOwnsView=false so its pan (which flows through the illustration weld) isn't blocked — but if it was
     *  entered from free3D (cameraOwnsView=true) we must put that back on exit so free3D pan stays decoupled. */
    private _meshEditPrevCameraOwnsView: boolean | null = null;
    /** The mesh the current Edit Mesh / UV orbit was entered on (null = none). */
    private _meshEditCamMeshId: string | null = null;
    /** The Edit Mesh / UV camera at its last exit — re-used when the same mesh's edit view is re-entered right away
     *  (a mode SWITCH: Edit Mesh ↔ UV editor exits one and enters the other in the same click), so switching modes
     *  keeps the user's camera instead of re-framing (UI review 2026-10-07 §3 #17). */
    private _lastEditCam: { meshId: string; target: [number, number, number]; azimuth: number; elevation: number; radius: number; zoom: number; framedZoom: number; at: number } | null = null;
    /** The mode that owns the DECOUPLED edit camera (`_meshEditZoom`, the wheel interceptor, cameraOwnsView): Edit Mesh /
     *  UV ('meshEdit', enableMeshEditOrbit) or the Armature ('armature', enterArmatureMode3D / showBoneOverlay3D).
     *  The Armature used to follow the 2D zoom: framed on entry, then the next pan / zoom / Add Skeleton snapped the
     *  camera back to the 2D view (the "armature camera jump"). A teardown only releases the camera while its own mode
     *  still owns it. */
    private _editViewOwner: EditViewOwner | null = null;
    /** The armature view's mesh (the kept-camera key on leaving) and the cameraOwnsView value it replaced. */
    private _armCamMeshId: string | null = null;
    private _armPrevCameraOwnsView: boolean | null = null;
    /** The edit view's zoom when it was last framed (entry / Frame): the zoom readout's 100 %. */
    private _editFramedZoom: number | null = null;

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
    /** Reused joint-index list for solveIKAndConstraints (no per-frame allocation). */
    private readonly _ikSolveScratch: number[] = [];
    // The per-frame spring solve registered by enableOrbitControls / torn down by disableOrbitControls.
    private _springSolveCallback: (() => boolean) | null = null;
    private _springLastTime = 0;
    /** SIM LOD: skeletons whose springs were suspended (far / off screen / fogged) — reset when they resume. */
    private readonly _springsSuspended = new Set<string>();

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
    /** Rest-geometry lowest Y (the soles) per vertex buffer, for the feet-anchored character scale (constrainScale). */
    private readonly _restMinYCache = new WeakMap<object, number | null>();
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

    /** An edit view / orbit owns the camera: the 2D illustration sync must not touch it. */
    private get _orbitOwnsCamera(): boolean {
        return this._boneOverlayExplicit || this._meshEditOrbitCenter !== null || this._editViewOwner !== null;
    }

    syncIllustrationCamera(panX: number, panY: number, zoom: number, canvasW: number, canvasH: number): void {
        if (this._orbitOwnsCamera) {
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
        // Remember the intent, but DON'T touch cam.mode while orbit/free3D owns the camera. free3D is perspective;
        // a host call setting the 2D illustration projection (e.g. 'orthographic' on load, AFTER the doc restore
        // set perspective) would otherwise flip free3D to ORTHO — which silently breaks pan (the ortho orbit-loop
        // branch pins the target every frame) and zoom (the wheel dolly early-returns in ortho), while ROTATE
        // still works. That was the "reload into 3D Free → can't pan/zoom until I toggle modes" bug. The stored
        // projection re-applies when orbit mode exits (syncIllustrationCamera guards the same way, line ~276).
        if (this._orbitOwnsCamera) { this.ctx.scheduleRender(); return; }
        this.renderer3D.getCamera().mode = mode;
        if (this._illustrationSync) {
            this._applyIllustrationCamera();
        } else {
            this.ctx.scheduleRender();
        }
    }

    private _applyIllustrationCamera(): void {
        if (!this._illustrationSync) return;
        if (this._orbitOwnsCamera) return; // orbit owns the camera
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
        renderer.addPreRenderCallback(this._autoSyncCallback, 'illustrationCameraSync');
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
        // On-demand renderer: an instant (non-damped) camera change — a wheel dolly especially — must request a
        // frame, or it applies to the camera but doesn't draw until a stray mouse-move schedules one.
        this._orbitController.onChange = () => this.ctx.scheduleRender();
        this._wireOrbitTouch(this._orbitController);
        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (canvas) this._orbitController.attach(canvas);

        // Register per-frame update for damping/momentum.
        // When bone overlay is active, applySpherical() is called unconditionally every
        // frame so the orbit camera always wins over any illustration-camera auto-sync
        // callback that may be registered ahead of this one in the pre-render list.
        this._orbitUpdateCallback = () => {
            if (!this._orbitController) return false;
            // Self-heal the canvas binding: enableOrbitControls may have run during document restore BEFORE the
            // renderer's canvas was ready (fresh page load into free3D) — attach() was skipped, so pan/zoom/orbit
            // input was dead until a mode toggle re-ran enableOrbitControls. Re-attach on the first rendered frame
            // once the live canvas exists (cheap ref check; attach() is only called when it actually differs).
            const liveCanvas = this.ctx.webgpuRenderer.getCanvas();
            if (liveCanvas && this._orbitController.attachedCanvas !== liveCanvas) {
                this._orbitController.attach(liveCanvas as HTMLCanvasElement);
            }
            const hadMomentum = this._orbitController.update();
            // The Armature's own edit camera (decoupled from the 2D view like Edit Mesh — see _editViewOwner).
            if (this._editViewOwner === 'armature' && this._meshEditZoom != null) return this._applyDecoupledOrtho(hadMomentum);
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

                if (cam.mode === 'perspective') {
                    // free3D: the orbit controller FULLY owns the camera — orbit (left-drag), pan (middle/right-drag
                    // moves the target) and dolly (wheel). Don't pin the target to `oc` (that reset the target every
                    // frame, so pan never stuck) and don't read the 2D illustration pan/zoom: this view is decoupled
                    // from the 2D artboard, and pan here must not touch the 2D pan (see interactionService.cameraOwnsView).
                    ctrl.applySpherical();
                    if (hadMomentum) this.ctx.scheduleRender();
                    return false;
                }

                // DECOUPLED ortho creator modes (Edit Mesh / surface-paint / group-orbit): when `_meshEditZoom`
                // is set the view is fully owned by the orbit controller and its own zoom — orbit (Alt+left),
                // PAN (middle/right-drag moves the target), and zoom (`_meshEditZoom` via the wheel interceptor).
                // The target is NOT pinned to `oc` (pinning reset it every frame, so pan never stuck) and the 2D
                // illustration pan/zoom is NOT read or written — so navigating the object never shifts the 2D
                // artboard (cameraOwnsView blocks the raster pan/zoom path; the wheel interceptor owns the wheel).
                if (this._meshEditZoom != null) return this._applyDecoupledOrtho(hadMomentum);

                // LEGACY fallback (only if a mode failed to seed `_meshEditZoom`): the old illustration weld —
                // target pinned at oc, orthoSize + pan derived from the 2D view.
                cam.setTarget(oc[0], oc[1], oc[2]);
                ctrl.applySpherical();
                if (this._illustrationSync) {
                    const { panX, panY, zoom, canvasH } = this._illustrationSync;
                    const cx = -panX / (canvasH * zoom);
                    const cy =  panY / (canvasH * zoom);
                    this._meshEditOrthoX = cx - oc[0];
                    this._meshEditOrthoY = cy - oc[1];
                    cam.orthoSize = 1 / zoom;
                    const r = Math.max(0.001, ctrl.radius);
                    ctrl.panSpeed = cam.orthoSize / (canvasH * r);
                }
                cam.orthoOffsetX = this._meshEditOrthoX;
                cam.orthoOffsetY = this._meshEditOrthoY;
                if (hadMomentum) this.ctx.scheduleRender();
                return false;
            }
            if (hadMomentum) this.ctx.scheduleRender();
            return hadMomentum;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._orbitUpdateCallback, 'orbit');

        // Per-frame IK solve: FK pass → FABRIK → final worldMatrices.
        // Only active when bone overlay is explicit and skeleton has enabled IK chains.
        this._ikSolveCallback = () => {
            if (!this._boneOverlayExplicit || !this._boneOverlaySkeletonId) return false;
            const skel = this.getSkeleton(this._boneOverlaySkeletonId);
            if (!skel) return false;
            const hasIK          = skel.data.ikChains?.some(c => c.enabled) ?? false;
            const hasConstraints = skel.data.joints.some(j => j.constraints?.length);
            if (!hasIK && !hasConstraints) return false;
            // FK → IK → constraints → final matrices, with ONE full FK pass: the post-IK and final passes are partial
            // recomputes of only the subtrees the solvers changed (was up to 3 full passes a frame — §7.3d).
            solveIKAndConstraints(skel, hasIK, hasConstraints, this._ikSolveScratch);
            return false;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._ikSolveCallback, 'ik+constraints');

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
            this.host.simLodBegin?.('springs');
            for (const skel of this.getAllSkeletons()) {
                if (!skel.data.springChains?.some(c => c.enabled)) continue;
                if (!this._springsActiveFor(skel.id, now)) continue;   // idle characters don't simulate (crowd perf)
                // SIM LOD: springs solve only near the camera and on screen. A suspended skeleton is RESET when it comes
                // back (its spring state restarts from the current pose — no catch-up spike; see resetSpringState).
                if (this.host.simLodSpringsDue && !this.host.simLodSpringsDue(skel.id)) { this._springsSuspended.add(skel.id); continue; }
                if (this._springsSuspended.delete(skel.id)) resetSpringState(skel);
                if (solveSpringBones(skel, dt)) moving = true;
            }
            if (!moving) this._springLastTime = 0;   // settled → reset the clock so the next nudge starts fresh
            return moving;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._springSolveCallback, 'springBones');

        // If bone overlay was already shown before orbit was set up, create the gizmo now.
        if (this._boneOverlayExplicit) {
            this._ensureViewGizmo();
        }

        return this._orbitController;
    }

    /** One frame of a DECOUPLED ortho edit view: orbit + pan own the target, the view's own zoom sets orthoSize. */
    private _applyDecoupledOrtho(hadMomentum: boolean): boolean {
        const ctrl = this._orbitController!, cam = this.renderer3D.getCamera();
        const animating = this._stepEditAnim();   // an animated Frame (animateEditView) moves the view first
        ctrl.applySpherical();                 // orbit + pan own the target
        cam.orthoSize = 1 / (this._meshEditZoom ?? 1);
        cam.orthoOffsetX = 0;
        cam.orthoOffsetY = 0;
        const canvasH = this._illustrationSync?.canvasH
            ?? this.ctx.webgpuRenderer.getCanvas()?.height ?? 1000;
        const r = Math.max(0.001, ctrl.radius);
        ctrl.panSpeed = cam.orthoSize / (canvasH * r);   // world units / pixel = orthoSize / canvasH
        if (hadMomentum || animating) this.ctx.scheduleRender();
        return false;
    }

    private _ensureViewGizmo(): void {
        this.enableViewGizmo();
    }

    enableViewGizmo(position?: import('../../renderer/3d/view-gizmo').ViewGizmoPosition): void {
        if (!this._orbitController) return;
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;
        if (this._viewGizmo) {
            // Never leave a gizmo anchored to a canvas the renderer no longer draws to (a canvas swap with no
            // reattach): move it onto the current one instead of keeping the stale anchor.
            if (this._viewGizmo.canvas !== canvas) this._viewGizmo.setCanvas(canvas);
            return;
        }
        this._viewGizmo = new ViewGizmo(
            canvas,
            this.renderer3D.getCamera(),
            this._orbitController,
            () => this.ctx.scheduleRender(),
            position ?? this._viewGizmoPos,
        );
        if (this._viewGizmoHidden) this._viewGizmo.setHidden(true);
        this._viewGizmo.draw();
        this._viewGizmoFrameCb = () => { this._viewGizmo?.draw(); return false; };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._viewGizmoFrameCb, 'viewGizmo');
    }

    setViewGizmoPosition(position: import('../../renderer/3d/view-gizmo').ViewGizmoPosition): void {
        this._viewGizmoPos = position;
        this._viewGizmo?.setPosition(position);
    }

    /** Host hide of the nav gizmo (Toggle UI, viewer mode): survives the gizmo being torn down and re-created by mode
     *  changes; independent of whether any mode currently shows one. */
    setViewGizmoHidden(hidden: boolean): void {
        this._viewGizmoHidden = hidden;
        this._viewGizmo?.setHidden(hidden);
    }

    /** True while a nav gizmo exists AND is displayed (not host-hidden, its canvas attached and sized). */
    isViewGizmoVisible(): boolean { return !!this._viewGizmo?.visible; }

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

    /** Re-attach the 3D canvas input listeners to the CURRENT canvas after a canvas SWAP (the Shell↔illustration
     *  reinitialize()). enableOrbitControls / _setupBoneOverlayListeners bound to the OLD canvas; the renderer's
     *  reinitialize re-binds the 2D tools but not these, so free3D pan/zoom/orbit (and armature bone dragging) is
     *  dead after a route change until a mode toggle re-runs enableOrbitControls. attach() detaches the stale
     *  binding first, so this is idempotent. */
    reattachCanvasListeners(): void {
        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (!canvas) return;
        // The nav gizmo belongs to the canvas it was made for: a SWAP means that canvas (and the page around it) is
        // gone — Frogmarks' route change to a board / package editor / player. Keeping it re-anchored here would show
        // the illustration's gizmo over a board; the next view-state apply (every document load) re-creates it on the
        // new canvas if the loaded document is in a 3D camera mode.
        if (this._viewGizmo && this._viewGizmo.canvas !== canvas) this.disableViewGizmo();
        this._orbitController?.attach(canvas as HTMLCanvasElement);
        this._transformController?.attach(canvas as HTMLCanvasElement);   // 3D select + gizmo (also self-heals in its sync callback)
        if (this._boneOverlayExplicit) {
            this._boneOverlayListenerCleanup?.();          // drop the stale (old-canvas) removers
            this._boneOverlayListenerCleanup = undefined;
            this._setupBoneOverlayListeners();             // re-bind to the new canvas
        }
    }

    enableMeshEditOrbit(meshId: string): void {
        // The Armature still holds the edit camera (its teardown hasn't run yet): hand its claim over (cameraOwnsView,
        // the wheel) and keep its camera for this switch, so the late teardown has nothing of Edit Mesh's to undo.
        if (this._editViewOwner === 'armature') this._releaseArmatureView();
        this.enableOrbitControls({ altOrbitOnly: true });

        const cam = this.renderer3D.getCamera();
        // Edit Mesh is an ORTHOGRAPHIC editing workspace. Force ortho so (a) frameMesh sizes via orthoSize,
        // and (b) the orbit update takes the edit-mesh (ortho) path, not the free3D (perspective) path.
        cam.mode = 'orthographic';
        const meshCenter = this.getMeshCenter(meshId);
        const kept = this._takeKeptEditCamera(meshId);
        this._meshEditCamMeshId = meshId;

        if (kept && this._orbitController) {
            // A mode switch on the same mesh (Edit Mesh ↔ UV): the user's camera, exactly as they left it.
            cam.setTarget(kept.target[0], kept.target[1], kept.target[2]);
            this._orbitController.radius = kept.radius;
            this._orbitController.setSpherical(kept.azimuth, kept.elevation);
            this._meshEditZoom = kept.zoom;
            this._editFramedZoom = kept.framedZoom;
            cam.orthoSize = 1 / Math.max(0.0001, kept.zoom);
            this._meshEditOrbitCenter = meshCenter ? [meshCenter[0], meshCenter[1], meshCenter[2]] : [kept.target[0], kept.target[1], kept.target[2]];
        } else {
            // A fresh entry: a 3/4 view (from the front-right, above) so the mesh reads as 3D, then FRAME it to ~60 % of
            // the view and seed Edit-Mesh mode's OWN ortho zoom from that framing. From here on the orbit update derives
            // orthoSize from `_meshEditZoom` (below), NOT from the 2D illustration zoom — so the mesh is sized to itself
            // and zooming here never touches the 2D zoom. (It used to keep the 2D view's straight-on direction: a cube
            // read as a flat square.)
            if (meshCenter && this._orbitController) {
                cam.setTarget(meshCenter[0], meshCenter[1], meshCenter[2]);
                this._orbitController.syncFromCamera();
                this._orbitController.setSpherical(EDIT_VIEW_AZIMUTH, EDIT_VIEW_ELEVATION);
            }
            this.frameMesh(meshId, EDIT_VIEW_PADDING);
            this._meshEditZoom = 1 / Math.max(0.0001, cam.orthoSize);
            this._editFramedZoom = this._meshEditZoom;

            if (meshCenter) {
                cam.setTarget(meshCenter[0], meshCenter[1], meshCenter[2]);
                this._orbitController?.syncFromCamera();
                this._meshEditOrbitCenter = [meshCenter[0], meshCenter[1], meshCenter[2]];
            } else {
                const t = cam.target;
                this._meshEditOrbitCenter = [t[0], t[1], t[2]];
            }
        }

        // Framed = mesh centred in the view; no ortho offset.
        const oc = this._meshEditOrbitCenter;
        this._meshEditOrthoX = 0;
        this._meshEditOrthoY = 0;
        this._meshEditIllustrationCx = oc[0];
        this._meshEditIllustrationCy = oc[1];
        cam.orthoOffsetX = 0;
        cam.orthoOffsetY = 0;

        this._editViewOwner = 'meshEdit';
        this._installMeshEditWheel();
        // Edit Mesh pan is now DECOUPLED (orbit controller moves the target; wheel interceptor owns zoom), so
        // claim the view: cameraOwnsView=true blocks the raster pan/zoom path from touching the 2D artboard.
        // Save the prior value so exit restores it (e.g. returning to free3D stays decoupled).
        this._meshEditPrevCameraOwnsView = this.ctx.interactionService.cameraOwnsView;
        this.ctx.interactionService.cameraOwnsView = true;
        this.ctx.interactionService.suppressBoxSelect = true;
        this.enableViewGizmo();
        // Show the focus background (hides the 2D illustration content behind the mesh
        // for a clean editing/painting workspace — same system as armature mode).
        this.renderer3D.setMeshEditModeActive(true);
        this._syncFocusBgLiveLoop();   // hold the live loop if the focus bg is animated ('wavy')
        this.ctx.scheduleRender();
    }

    disableMeshEditOrbit(): void {
        // Remember this edit camera: entering the same mesh's edit view right away (a mode switch) keeps it.
        const oc = this._orbitController, camNow = this.renderer3D.getCamera();
        this._lastEditCam = this._meshEditCamMeshId && oc && this._meshEditZoom != null ? {
            meshId: this._meshEditCamMeshId, target: [camNow.target[0], camNow.target[1], camNow.target[2]],
            azimuth: oc.azimuth, elevation: oc.elevation, radius: oc.radius, zoom: this._meshEditZoom,
            framedZoom: this._editFramedZoom ?? this._meshEditZoom, at: nowMs(),
        } : null;
        this._meshEditCamMeshId = null;
        if (this._editViewOwner === 'meshEdit') { this._editViewOwner = null; this._editFramedZoom = null; this._editAnim = null; }
        this.ctx.interactionService.suppressBoxSelect = false;
        this._meshEditOrbitCenter = null;
        this._meshEditOrthoX = 0;
        this._meshEditOrthoY = 0;
        this._meshEditZoom = null;
        this._removeMeshEditWheel();
        // Restore the cameraOwnsView we overrode on entry (so free3D re-entry stays pan-decoupled).
        if (this._meshEditPrevCameraOwnsView != null) {
            this.ctx.interactionService.cameraOwnsView = this._meshEditPrevCameraOwnsView;
            this._meshEditPrevCameraOwnsView = null;
        }
        const cam = this.renderer3D.getCamera();
        cam.orthoOffsetX = 0;
        cam.orthoOffsetY = 0;
        this.renderer3D.setMeshEditModeActive(false);
        this._syncFocusBgLiveLoop();   // release any animated-bg live-loop hold
        this.disableOrbitControls();
        this._forceIllustrationResync();   // snap the camera back to the 2D view NOW (not on the next pan)
    }

    /** The kept edit camera for `meshId` when its edit view was left within {@link EDIT_CAMERA_KEEP_MS} (consumed). */
    private _takeKeptEditCamera(meshId: string): NonNullable<Scene3DArmature['_lastEditCam']> | null {
        const k = this._lastEditCam;
        this._lastEditCam = null;
        return k && k.meshId === meshId && nowMs() - k.at <= EDIT_CAMERA_KEEP_MS ? k : null;
    }

    enterMeshOrbit3D(meshId: string, opts: { azimuth?: number; elevation?: number; padding?: number } = {}): void {
        this.enableOrbitControls({ altOrbitOnly: true });
        this.renderer3D.getCamera().mode = 'orthographic';          // frame + decouple in ortho (see _claimDecoupledOrthoView)
        this.frameMesh(meshId, opts.padding ?? 1.7);                 // camera → framed (sets target = centre + fit radius)
        const center = this.getMeshCenter(meshId);
        if (center) {
            const cam = this.renderer3D.getCamera();
            cam.setTarget(center[0], center[1], center[2]);
            this._orbitController?.syncFromCamera();                 // adopt the framed radius/angle
            this._orbitController?.setSpherical(opts.azimuth ?? Math.PI * 0.18, opts.elevation ?? 1.0);   // 3/4 top-down
            this._meshEditOrbitCenter = [center[0], center[1], center[2]];   // ← orbit now owns the camera
        }
        // Decouple pan+zoom from the 2D artboard (orbit owns pan; wheel interceptor owns zoom).
        this._claimDecoupledOrthoView();
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
        this._meshEditZoom = null;          // defensive: if an Edit-Mesh session exits through this path
        if (this._editViewOwner === 'meshEdit') { this._editViewOwner = null; this._meshEditCamMeshId = null; }
        this._removeMeshEditWheel();
        // Restore the cameraOwnsView we claimed on entry (surface-paint / group-orbit / Edit-Mesh via this path).
        if (this._meshEditPrevCameraOwnsView != null) {
            this.ctx.interactionService.cameraOwnsView = this._meshEditPrevCameraOwnsView;
            this._meshEditPrevCameraOwnsView = null;
        }
        // Zero the ortho offset the orbit loop accumulated (mesh center ≠ 2D centre). _applyIllustrationCamera
        // never resets orthoOffset, so leaving it non-zero would show the returned-to 2D view SHIFTED after a
        // surface-paint / group-orbit session. disableMeshEditOrbit already does this; match it here.
        this._meshEditOrthoX = 0;
        this._meshEditOrthoY = 0;
        this.renderer3D.getCamera().orthoOffsetX = 0;
        this.renderer3D.getCamera().orthoOffsetY = 0;
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
        // Decouple pan+zoom from the 2D artboard (orbit owns pan; wheel interceptor owns zoom).
        this._claimDecoupledOrthoView();
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

    /** While Edit Mesh mode is active, own the wheel entirely: adjust the DECOUPLED `_meshEditZoom`
     *  and swallow the event (capture-phase preventDefault + stopPropagation) so it never reaches the
     *  app's canvas-zoom handler — 3D editing zoom must not change the 2D illustration zoom. In
     *  orthographic mode the orbit controller's own wheel dolly is a no-op and falls through, which is
     *  precisely the fall-through we intercept here. */
    private _installMeshEditWheel(): void {
        this._removeMeshEditWheel();
        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (!canvas) return;
        const onWheel = (e: WheelEvent): void => {
            if (this._meshEditZoom == null) return;
            e.preventDefault();
            e.stopPropagation();
            // Scroll up = zoom in = larger zoom = smaller orthoSize. Proportional per notch.
            if (Math.abs(e.deltaY) < 0.5) return;   // deltaY 0 (horizontal tilt / trackpad jitter) is not a zoom step
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            this._meshEditZoom = Math.max(1e-3, Math.min(1e4, this._meshEditZoom * factor));
            this.ctx.scheduleRender();
        };
        canvas.addEventListener('wheel', onWheel, { capture: true, passive: false });
        this._meshEditWheelCleanup = () => canvas.removeEventListener('wheel', onWheel, { capture: true });
    }

    /** After a reframe set cam.orthoSize: a decoupled ortho creator view (Edit Mesh / surface paint / group orbit)
     *  re-derives orthoSize from `_meshEditZoom` every frame, so adopt the framed size (else Frame only re-targets). */
    reseedDecoupledZoom(): void {
        const cam = this.renderer3D.getCamera();
        if (this._meshEditZoom == null || cam.mode !== 'orthographic') return;
        this._meshEditZoom = 1 / Math.max(0.0001, cam.orthoSize);
    }

    private _removeMeshEditWheel(): void {
        this._meshEditWheelCleanup?.();
        this._meshEditWheelCleanup = null;
    }

    /** Claim the DECOUPLED ortho creator view for surface-paint / group-orbit (Edit Mesh does the equivalent
     *  inline). Forces ortho, seeds `_meshEditZoom` from the already-framed orthoSize, installs the wheel
     *  interceptor, and takes cameraOwnsView so pan/zoom gestures never touch the 2D artboard. Call AFTER the
     *  caller has framed the mesh/group (set cam.orthoSize). */
    private _claimDecoupledOrthoView(): void {
        const cam = this.renderer3D.getCamera();
        cam.mode = 'orthographic';
        this._meshEditZoom = 1 / Math.max(0.0001, cam.orthoSize);
        this._installMeshEditWheel();
        this._meshEditPrevCameraOwnsView = this.ctx.interactionService.cameraOwnsView;
        this.ctx.interactionService.cameraOwnsView = true;
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

    // ── TOUCH-3 (docs/ui/touch-controls.md) ──────────────────────────────────────────────────────────
    /** Host "Navigate" lock: one finger orbits in every scheme (tool modes included). Survives orbit re-creation. */
    private _touchNavLock = false;
    /** Double-tap handler (client coords) — Scene3DManager frames the tapped mesh, or everything. */
    touchDoubleTapHandler: ((clientX: number, clientY: number) => void) | null = null;

    setTouchNavigate3D(on: boolean): void {
        this._touchNavLock = !!on;
        if (this._orbitController) this._orbitController.touchNavLock = this._touchNavLock;
    }
    getTouchNavigate3D(): boolean { return this._touchNavLock; }

    /** Hook a freshly created orbit controller's touch gestures into this view's zoom / pan paths. */
    private _wireOrbitTouch(orb: OrbitController): void {
        orb.touchNavLock = this._touchNavLock;
        orb.onDoubleTap = (x, y) => this.touchDoubleTapHandler?.(x, y);
        // Edit views (Edit Mesh / UV / Armature): a pen / finger drag off the selection orbits, two fingers pan, the
        // host's Pan tool pans (live: they follow the mode, whichever controller instance is up).
        orb.isEditNav = () => this._editViewOwner !== null;
        orb.isPanTool = () => this.isEditPanTool();
        // Ortho pinch: the decoupled creator view zooms `_meshEditZoom` (like its wheel interceptor); an illustration-
        // synced ortho view zooms the 2D view, which the per-frame sync turns into orthoSize.
        orb.onTouchZoom = (ratio, cx, cy) => {
            if (this._meshEditZoom != null) {
                this._meshEditZoom = Math.max(1e-3, Math.min(1e4, this._meshEditZoom * ratio));
                this.ctx.scheduleRender();
            } else {
                this.ctx.webgpuRenderer.touchZoom2D(ratio, cx, cy);
            }
        };
        // Ortho pan in an illustration-synced view: the target is re-pinned every frame, so pan the 2D view instead.
        orb.onTouchPan = (dx, dy) => {
            if (this.renderer3D.getCamera().mode !== 'orthographic' || this._meshEditZoom != null) return false;
            this.ctx.webgpuRenderer.touchPan2D(dx, dy);
            return true;
        };
        // The 2D raster pinch stands down while this controller owns multi-finger touch (no double zoom).
        this.ctx.interactionService.touchGestures3D = () => {
            const o = this._orbitController;
            return !!o && o.enabled && o.attachedCanvas !== null;
        };
    }

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
            // Panel explicitly closed — release ownership and tear down dedicated listeners. When another edit mode
            // already took the camera over (a host that entered Edit Mesh / UV before this teardown ran), its orbit,
            // gizmo mode and box-select suppression are left alone.
            const otherOwnsView = this._editViewOwner === 'meshEdit';
            if (this._editViewOwner === 'armature') this._releaseArmatureView();
            if (!otherOwnsView) this.ctx.interactionService.suppressBoxSelect = false;
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
            if (!otherOwnsView) {
                // Restore T/R/S gizmo — joint selection sets mode to null to hide
                // the mesh gizmo while bone gizmos are showing; reset on exit.
                this.setGizmoMode('move');
                // Disable orbit controls now that armature editing is done.
                this.disableOrbitControls();
            }
            this.ctx.emitSceneGraphChanged();
            this.ctx.scheduleRender();
            return;
        }
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return;
        // Frame/isolate THIS skeleton's character. The host passes the mesh that was selected when the panel opened —
        // which is the wrong character once the user picks a different skeleton in the list (the camera + isolation
        // stayed on the first character, which could even leave the chosen one hidden). Use the passed mesh only if it
        // belongs to this skeleton; otherwise its own body.
        const prevSkelId = this._boneOverlaySkeletonId;
        meshId = this._meshForSkeleton(skeletonId, meshId) ?? meshId;
        if (prevSkelId && prevSkelId !== skeletonId && meshId) this._retargetArmatureCharacter(meshId);
        // Mark as explicit so _syncBoneOverlay won't clobber it when the mesh
        // selection changes (e.g. after emitSceneGraphChanged fires).
        this.ctx.interactionService.suppressBoxSelect = true;
        this._boneOverlayExplicit = true;
        this._boneOverlaySkeletonId = skeletonId;
        // Re-seed the spring sim to the CURRENT rest pose on entry. Otherwise stale tip state from a prior
        // session (the WeakMap survives mode exits) + the mesh-rotation zeroing below make the first active
        // frame whip the springs violently ("exploded into spikes when I opened armature mode"). Also reset the
        // spring clock so the first frame uses a sane dt, not a giant (now − last-settled) gap.
        resetSpringState(skel);
        this._springLastTime = 0;
        this.renderer3D.setBoneOverlaySkeleton(skel);
        this.renderer3D.setArmatureModeActive(true);
        this._setupBoneOverlayListeners();
        // Notify Frogmarks first — their sceneGraphChanged handler may call
        // enableOrbitControls or otherwise reset camera state.  We set up the
        // orbit pivot AFTER so cam.target = meshCenter is the final word.
        this.ctx.emitSceneGraphChanged();
        // Zero mesh rotation if not already done by enterArmatureMode3D.
        if (meshId) this._zeroMeshRotationForArmature(meshId);

        // The Armature's own edit camera (framed once on entry, then only the user's orbit / pan / zoom move it). This
        // used to reset the camera to the 2D view here — the jump on Add Skeleton — and then follow the 2D zoom.
        if (this._editViewOwner !== 'armature') this._enterArmatureView(meshId);
        else if (this._armatureOrbitCenter === null) {
            const t = this.renderer3D.getCamera().target;
            this._armatureOrbitCenter = [t[0], t[1], t[2]];
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
        }
        this._enterArmatureView(meshId);
        this.ctx.scheduleRender();
    }

    /**
     * Claim the Armature's edit camera (the same decoupled ortho view Edit Mesh uses): the orbit controller owns the
     * camera, `_meshEditZoom` is its zoom (wheel / pinch / the host's zoom box), cameraOwnsView keeps pan / zoom off the
     * 2D artboard. A fresh entry frames `meshId` from the current direction (front-on from the 2D view); a mode switch
     * on the same mesh (Edit Mesh / UV left right before) keeps that camera. Idempotent.
     */
    private _enterArmatureView(meshId: string | undefined): void {
        if (this._editViewOwner === 'armature') return;
        const cam = this.renderer3D.getCamera();
        // Edit Mesh / UV still up (its teardown didn't run first): carry its camera and zoom over as they are.
        const takeOver = this._editViewOwner === 'meshEdit' && this._meshEditZoom != null;
        if (!this._orbitController) this.enableOrbitControls({ altOrbitOnly: true });
        else this._orbitController.altOrbitOnly = true;
        cam.mode = 'orthographic';
        const kept = meshId && !takeOver ? this._takeKeptEditCamera(meshId) : null;
        if (kept && this._orbitController) {
            cam.setTarget(kept.target[0], kept.target[1], kept.target[2]);
            this._orbitController.radius = kept.radius;
            this._orbitController.setSpherical(kept.azimuth, kept.elevation);
            this._meshEditZoom = kept.zoom;
            this._editFramedZoom = kept.framedZoom;
        } else if (!takeOver) {
            if (!meshId || !this.frameMesh(meshId, ARMATURE_VIEW_PADDING)) this._orbitController?.syncFromCamera();   // target + orthoSize
            this._meshEditZoom = 1 / Math.max(0.0001, cam.orthoSize);
            this._editFramedZoom = this._meshEditZoom;
        }
        cam.orthoSize = 1 / Math.max(0.0001, this._meshEditZoom ?? 1);
        const t = cam.target;
        this._armatureOrbitCenter = [t[0], t[1], t[2]];
        this._armatureOrthoX = 0;
        this._armatureOrthoY = 0;
        cam.orthoOffsetX = 0;
        cam.orthoOffsetY = 0;
        this._armCamMeshId = meshId ?? null;
        if (takeOver) { this._meshEditCamMeshId = null; this._meshEditOrbitCenter = null; }
        this._editViewOwner = 'armature';
        this._installMeshEditWheel();
        if (takeOver) { this._armPrevCameraOwnsView = this._meshEditPrevCameraOwnsView; this._meshEditPrevCameraOwnsView = null; }
        if (this._armPrevCameraOwnsView === null) this._armPrevCameraOwnsView = this.ctx.interactionService.cameraOwnsView;
        this.ctx.interactionService.cameraOwnsView = true;
        this.enableViewGizmo();
        this.ctx.scheduleRender();
    }

    /** Leave the Armature's edit camera (showBoneOverlay3D(null)): remember it so a switch to Edit Mesh / UV on the same
     *  mesh keeps it, drop the decoupled zoom + wheel interceptor, give cameraOwnsView back. The caller tears the orbit
     *  down. */
    private _releaseArmatureView(): void {
        const oc = this._orbitController, cam = this.renderer3D.getCamera();
        this._lastEditCam = this._armCamMeshId && oc && this._meshEditZoom != null ? {
            meshId: this._armCamMeshId, target: [cam.target[0], cam.target[1], cam.target[2]],
            azimuth: oc.azimuth, elevation: oc.elevation, radius: oc.radius, zoom: this._meshEditZoom,
            framedZoom: this._editFramedZoom ?? this._meshEditZoom, at: nowMs(),
        } : null;
        this._editViewOwner = null;
        this._armCamMeshId = null;
        this._meshEditZoom = null;
        this._editFramedZoom = null;
        this._editAnim = null;
        this._removeMeshEditWheel();
        if (this._armPrevCameraOwnsView !== null) {
            this.ctx.interactionService.cameraOwnsView = this._armPrevCameraOwnsView;
            this._armPrevCameraOwnsView = null;
        }
        this._forceIllustrationResync();
    }

    /** Which edit mode owns the decoupled edit camera (null = none). */
    get editViewOwner(): EditViewOwner | null { return this._editViewOwner; }

    /** The host's Pan (hand) tool is on in an edit view (ShapeManager.enablePanningTool): a drag pans the edit camera
     *  and the mode's tools ignore the press. */
    isEditPanTool(): boolean {
        return this._editViewOwner !== null && (this.ctx.interactionService as { isPanToolSelected?: boolean }).isPanToolSelected === true;
    }

    /**
     * Frame the edit view's subject with its entry framing, keeping the current view angle: Edit Mesh / UV — the mesh
     * (60 %); Armature — its mesh. Re-seeds the view's zoom (and the zoom readout's 100 %). False outside an edit view.
     */
    frameEditView(): boolean {
        const owner = this._editViewOwner;
        if (!owner) return false;
        const id = owner === 'armature' ? this._armCamMeshId : this._meshEditCamMeshId;
        if (!id || !this.frameMesh(id, owner === 'armature' ? ARMATURE_VIEW_PADDING : EDIT_VIEW_PADDING)) return false;
        this._editFramedZoom = this._meshEditZoom;
        this.ctx.scheduleRender();
        return true;
    }

    /** A running edit-camera move (animateEditView): from / to the target, orbit angles and zoom, what the last frame set
     *  (anything else moving the camera since — the user's orbit / pan / zoom — ends it there). */
    private _editAnim: {
        from: { target: [number, number, number]; azimuth: number; elevation: number; zoom: number };
        to: { target: [number, number, number]; azimuth: number; elevation: number; zoom: number };
        t0: number; ms: number;
        set: { target: [number, number, number]; azimuth: number; elevation: number; zoom: number } | null;
    } | null = null;

    /**
     * ANIMATE the edit camera (Edit Mesh / UV / Armature's decoupled ortho view) to an orbit target + azimuth / elevation
     * + zoom over `ms` (ease in-out; the azimuth the short way round; the zoom in log space). The edit view's own state
     * moves (the orbit controller, `_meshEditZoom`), so everything after it — orbit, pan, zoom, Frame — carries on from
     * there. Any other camera move while it runs (the user orbits / pans / zooms) ends it where it is. False outside an
     * edit view.
     */
    animateEditView(to: { target: [number, number, number]; azimuth: number; elevation: number; zoom: number }, ms = 250): boolean {
        const ctrl = this._orbitController;
        if (!this._editViewOwner || this._meshEditZoom == null || !ctrl) return false;
        if (![...to.target, to.azimuth, to.elevation, to.zoom].every(Number.isFinite) || !(to.zoom > 0)) return false;
        const cam = this.renderer3D.getCamera();
        const from = { target: [cam.target[0], cam.target[1], cam.target[2]] as [number, number, number], azimuth: ctrl.azimuth, elevation: ctrl.elevation, zoom: this._meshEditZoom };
        let daz = (to.azimuth - from.azimuth) % (2 * Math.PI);
        if (daz > Math.PI) daz -= 2 * Math.PI;
        if (daz < -Math.PI) daz += 2 * Math.PI;
        const elevation = Math.max(ctrl.minElevation, Math.min(ctrl.maxElevation, to.elevation));
        const zoom = Math.max(1e-3, Math.min(1e4, to.zoom));
        this._editAnim = { from, to: { target: [...to.target], azimuth: from.azimuth + daz, elevation, zoom }, t0: nowMs(), ms: Math.max(0, ms), set: null };
        if (!(ms > 0)) this._stepEditAnim();
        this.ctx.scheduleRender();
        return true;
    }

    /** True while an edit-camera move (animateEditView) runs. */
    get isEditViewAnimating(): boolean { return this._editAnim !== null; }

    /** One frame of the edit-camera move: true while it still runs (the caller keeps the frames coming). */
    private _stepEditAnim(): boolean {
        const a = this._editAnim, ctrl = this._orbitController;
        if (!a) return false;
        if (!ctrl || !this._editViewOwner || this._meshEditZoom == null) { this._editAnim = null; return false; }
        const cam = this.renderer3D.getCamera();
        const s = a.set;
        const near = (x: number, y: number): boolean => Math.abs(x - y) <= 1e-5 * (1 + Math.abs(y));
        if (s && !(near(ctrl.azimuth, s.azimuth) && near(ctrl.elevation, s.elevation) && near(this._meshEditZoom, s.zoom)
            && near(cam.target[0], s.target[0]) && near(cam.target[1], s.target[1]) && near(cam.target[2], s.target[2]))) {
            this._editAnim = null;   // the user moved the camera: stop here
            return false;
        }
        const k = a.ms > 0 ? Math.max(0, Math.min(1, (nowMs() - a.t0) / a.ms)) : 1;
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // ease in-out (cubic)
        const lerp = (x: number, y: number): number => x + (y - x) * e;
        const target: [number, number, number] = [lerp(a.from.target[0], a.to.target[0]), lerp(a.from.target[1], a.to.target[1]), lerp(a.from.target[2], a.to.target[2])];
        const zoom = Math.exp(lerp(Math.log(a.from.zoom), Math.log(a.to.zoom)));
        cam.setTarget(target[0], target[1], target[2]);
        ctrl.azimuth = lerp(a.from.azimuth, a.to.azimuth);
        ctrl.elevation = lerp(a.from.elevation, a.to.elevation);
        ctrl.stopDamping();
        ctrl.applySpherical();
        this._meshEditZoom = zoom;
        cam.orthoSize = 1 / zoom;
        a.set = { target: [cam.target[0], cam.target[1], cam.target[2]], azimuth: ctrl.azimuth, elevation: ctrl.elevation, zoom };
        if (k >= 1) { this._editAnim = null; return false; }
        return true;
    }

    /** Zoom the edit view by `factor` (> 1 = in): the decoupled ortho zoom (the zoom box's − / +). False outside one. */
    zoomEditView(factor: number): boolean {
        if (!this._editViewOwner || this._meshEditZoom == null || !Number.isFinite(factor) || factor <= 0) return false;
        this._meshEditZoom = Math.max(1e-3, Math.min(1e4, this._meshEditZoom * factor));
        this.ctx.scheduleRender();
        return true;
    }

    /** The edit view's zoom relative to its framing (1 = as framed on entry / by Frame), or null outside an edit view. */
    getEditViewZoom(): number | null {
        if (!this._editViewOwner || this._meshEditZoom == null) return null;
        return this._meshEditZoom / Math.max(1e-6, this._editFramedZoom ?? this._meshEditZoom);
    }

    /** The mesh to frame for a skeleton: `preferred` if it rides this skeleton, else the skeleton's procedural body,
     *  else any skinned mesh bound to it. */
    private _meshForSkeleton(skeletonId: string, preferred?: string): string | undefined {
        const rides = (m: Mesh3D | null | undefined) => !!m && (m as { skeletonId?: string | null }).skeletonId === skeletonId;
        if (preferred && rides(this.getMesh(preferred))) return preferred;
        const all = this.getAllMeshes().filter(rides);
        return (all.find(m => (m as { isProceduralBody?: boolean }).isProceduralBody) ?? all[0])?.id;
    }

    /** Switching to another character's skeleton while already in armature mode: put the previous character's facing
     *  back, isolate + face-front the new one, and re-aim the orbit pivot at it (keeping the current zoom/angle). */
    private _retargetArmatureCharacter(meshId: string): void {
        if (this._armatureSavedMeshRotation && this._armatureSavedMeshRotation.meshId !== meshId) {
            const s = this._armatureSavedMeshRotation, prev = this.getMesh(s.meshId);
            if (prev) { prev.setRotation3D(s.rx, s.ry, s.rz); prev.updateLocalMatrix(); }
            this._armatureSavedMeshRotation = null;
        }
        if (this._isolatedMeshId) this.isolateMesh3D(meshId);
        this._zeroMeshRotationForArmature(meshId);
        const c = this.getMeshCenter(meshId);
        if (!c) return;
        const cam = this.renderer3D.getCamera();
        cam.setTarget(c[0], c[1], c[2]);
        this._orbitController?.syncFromCamera();
        this._armatureOrbitCenter = [c[0], c[1], c[2]];
        this._armatureOrthoX = 0; this._armatureOrthoY = 0;
        cam.orthoOffsetX = 0; cam.orthoOffsetY = 0;
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
        // the legacy Move / Rotate buttons ARE the tool strip's Move / Rotate tools
        if (this._armTool !== mode) this._leaveArmTool(mode);
        this._armTool = mode;
        this._setJointGizmoHidden(false);
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
        // DEEP walk (audit 2026-09-14) — include meshes inside nested subgroups too.
        commonGroup.forEachDeep((child) => {
            if (child instanceof Mesh3D) expanded.add(child.id);
        });
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
            // DEEP walk (audit 2026-09-14): a one-level loop skipped Mesh3D grandchildren inside NESTED
            // MeshGroup3Ds, so moving the outer group left nested subgroups behind.
            node.forEachDeep((child) => {
                if (child instanceof Mesh3D) meshIds.add(child.id);
            });
        } else if (node instanceof Mesh3D) {
            // Selecting a character part in the outliner selects the WHOLE character (move as one unit).
            const { meshIds: expanded } = this._expandGroupSelection(this._expandCharacterSelection(new Set([nodeId])));
            meshIds = expanded;
        } else if (node instanceof ParticleEmitter3D) {
            // Particle EMITTERS are selectable objects too (icon click / outliner row): keep the id in
            // the shared selected set so the gizmo anchors on it. Without this branch, the sync that
            // follows an emitter icon-pick resolved the id as "not a mesh" and WIPED the selection the
            // transform controller had just made.
            meshIds.add(nodeId);
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

        const swapChainFormat = this.ctx.webgpuRenderer.getSwapChainFormat() ?? 'bgra8unorm';
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
                const resolve = (id: string): Mesh3D | MeshGroup3D | ParticleEmitter3D | null => {
                    const m = this.getMesh(id) ?? (container && container.id === id ? container : null);
                    if (m) return m;
                    // Particle emitters are gizmo targets too — resolve through the scene graph.
                    const n = this.ctx.sceneGraph.findNodeById(id);
                    return n instanceof ParticleEmitter3D ? n : null;
                };
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
                // P5 (editing-loop-polish.md): sceneRadius used to update ONLY on reframe — a mesh
                // dragged far out could hit the far plane. Grow it (monotone, cheap) from each moved
                // node's world position; the next reframe re-derives the exact radius.
                const cam = this.renderer3D.getCamera();
                if (cam.autoFar) {
                    for (const id of after.keys()) {
                        const t = resolve(id);
                        if (!t) continue;
                        const lm = t.localMatrix as unknown as Float32Array;
                        const d = Math.hypot(lm[12] - cam.target[0], lm[13] - cam.target[1], lm[14] - cam.target[2]);
                        if (d + 1 > cam.sceneRadius) cam.sceneRadius = d + 1;
                    }
                }
            },
            // Character scale (2026-10-04): a procedural body scales UNIFORMLY from its FEET (its origin sits at the
            // hips), and a part riding its skeleton keeps its transform (its TRS is unused — the skin carries the body's).
            constrainScale: (mesh: Mesh3D, init: { x: number; y: number; z: number; sx: number; sy: number; sz: number }, corner: boolean) => {
                if (!mesh.isProceduralBody && !mesh.transformViaSkeleton) return;
                const g = mesh.geometry;
                let lo: number | null = null;
                if (g?.vertices?.length) {
                    const c = this._restMinYCache.get(g.vertices);
                    lo = c !== undefined ? c : geometryMinY(g.vertices, FLOATS_PER_VERT);
                    if (c === undefined) this._restMinYCache.set(g.vertices, lo);
                }
                constrainCharacterScale(mesh, init, lo, { corner });
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
            isAdditiveSelect: () => this.ctx.interactionService.additiveSelect3D === true,
            isSnapLatched: () => this.ctx.interactionService.snapLatch3D === true,
            isInputSuppressed: () => this.host.isPlaying,
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
                const patch: Partial<ArrayParams> = g.arrayParams.mode === 'grid'
                    ? { spacingX: newSpacing } : { spacing: newSpacing };
                for (const sg of this._getGroupSiblingArrays(groupId)) {
                    this.updateArrayParams3D(sg.id, patch);
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
                    this.updateArrayParams3D(sg.id, { spacingY: newSpacingY });
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
                    this.updateArrayParams3D(sg.id, { radius: newRadius });
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
            // Particle emitters as gizmo targets (the thin-wrapper cast precedent): the controller only
            // reads id/x/y/z/rotation*/scale*/localMatrix on them; its geometry paths stay mesh-only.
            getEmitters: (): Mesh3D[] => {
                const out: ParticleEmitter3D[] = [];
                for (const n of this.ctx.sceneGraph.root.children) {
                    if (n instanceof ParticleEmitter3D && n.visible) out.push(n);
                }
                return out as unknown as Mesh3D[];
            },
            // Screen-space pick against the emitter ICONS (constant-px billboards): project each emitter
            // through the camera, nearest within the icon radius wins. Runs BEFORE the mesh raycast in
            // the controller (icons draw depth-always on top, so they must win over meshes behind them).
            pickEmitter: (x: number, y: number, w: number, h: number): string | null => {
                const camera = this.renderer3D.getCamera();
                const vp = camera.getViewProjectionMatrix() as Float32Array;
                const PICK_PX = 14;
                let bestD2 = PICK_PX * PICK_PX;
                let bestId: string | null = null;
                for (const n of this.ctx.sceneGraph.root.children) {
                    if (!(n instanceof ParticleEmitter3D) || !n.visible) continue;
                    const m = n.localMatrix as unknown as Float32Array;
                    const wx = m[12], wy = m[13], wz = m[14];
                    const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
                    if (cw <= 1e-6) continue;                       // behind the camera
                    const cx = (vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw;
                    const cy = (vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw;
                    const px = (cx * 0.5 + 0.5) * w;
                    const py = (1 - (cy * 0.5 + 0.5)) * h;
                    const d2 = (px - x) * (px - x) + (py - y) * (py - y);
                    if (d2 < bestD2) { bestD2 = d2; bestId = n.id; }
                }
                return bestId;
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
            // Play mode (Round 8): editor gizmo state isn't drawn — skip the per-frame selection scan + array gizmo.
            if (this.host.isPlaying) { if (this.renderer3D.getArrayGizmoData()) this.renderer3D.setArrayGizmoData(null); return false; }
            // Self-heal the canvas binding (same as the orbit controller): enableTransformControls may have run
            // before the canvas was ready (fresh load) or the canvas was swapped — re-attach so 3D select + gizmo
            // dragging aren't silently dead until re-enable.
            const liveCanvas = this.ctx.webgpuRenderer.getCanvas();
            if (this._transformController && liveCanvas && this._transformController.attachedCanvas !== liveCanvas) {
                this._transformController.attach(liveCanvas as HTMLCanvasElement);
            }
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
        this.ctx.webgpuRenderer.addPreRenderCallback(syncCallback, 'transformGizmoSync');

        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (canvas) {
            this._transformController.attach(canvas as HTMLCanvasElement);
            this._setupBoneOverlayListeners();
        }
    }

    // ── Armature overlay pointer input (mobile-parity TOUCH-9 / TOUCH-16, docs/ui/touch-controls.md §3b) ──────────
    // Pointer events (capture phase, so it runs before the orbit controller) driven through ArmaturePointerGesture:
    // the press PICKS (pick-on-down — it used to read the mousemove hover index, which a finger never sets), a finger
    // gets ×2 hit radii and a delayed drag start, a 2nd finger / pointercancel CANCELS a drag and restores the pose +
    // joint selection exactly (no undo entry), and a finger never hovers (the mesh hover outline used to stick on the
    // last tapped mesh). Mouse behaviour is unchanged apart from: hover is coalesced to one pick per frame, and a drag
    // keeps going outside the canvas (pointer capture) instead of stopping on mouseleave.

    /** The overlay's pointer state machine — null until the listeners are bound. */
    private _armGesture: ArmaturePointerGesture<ArmTarget> | null = null;
    /** Puts back what the live drag changed (pose + joint selection) — a 2nd finger / pointercancel runs it. */
    private _armRestore: (() => void) | null = null;
    /** The pointerType of the last overlay press (the additive head press's tap / drag slop). */
    private _armPointerType = 'mouse';
    /** A head press (move / rotate tool) in progress: the joint, its local position at the press (one 'Move joint' undo
     *  step on release when it changed), the press point + slop. `pending` = an ADDITIVE press (Shift / the host's
     *  latch) still deciding: released within the slop → toggle the joint; moved past it → select it (additively,
     *  unless already selected) and drag it, no toggle. */
    private _armHead: ArmHeadPress | null = null;
    /** Mouse / pen press slop (CSS px) before an additive head press becomes a drag (as Edit Mesh's drag-the-selection). */
    static readonly HEAD_DRAG_SLOP_PX = 4;
    /** The mesh id the pointer hover last set and the renderer's hovered-id set it produced: hovering the same mesh
     *  again is a no-op (it used to allocate a Set + schedule a render on every mouse move). */
    private _ptrHoverId: string | null = null;
    private _ptrHoverSet: Set<string> | null = null;
    /** TOUCH-8: joint / tail / IK handle / joint-gizmo hit radii multiplier under a finger. */
    static readonly TOUCH_HIT_SCALE = 2;

    /** True while an armature drag (joint, tail, joint gizmo, IK handle) or a finger press about to become one owns a
     *  pointer. Hosts use it to skip per-move UI work. */
    get isArmatureDragActive(): boolean { return this._armGesture?.busy ?? false; }

    private _setupBoneOverlayListeners(): void {
        if (this._boneOverlayListenerCleanup) return; // already set up
        const el = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!el) return;
        const raf = typeof requestAnimationFrame === 'function';
        const toPx = (x: number, y: number, r: ArmClientRect): { x: number; y: number } => ({
            x: (x - r.left) * (el.width / (r.width || 1)),
            y: (y - r.top) * (el.height / (r.height || 1)),
        });
        const gesture = new ArmaturePointerGesture<ArmTarget>({
            measure: () => el.getBoundingClientRect(),
            capture: (id) => { try { el.setPointerCapture(id); } catch { /* pointer already gone */ } },
            release: (id) => { try { if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id); } catch { /* gone */ } },
            requestFrame: (cb) => (raf ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number)),
            cancelFrame: (id) => { if (raf) cancelAnimationFrame(id); else clearTimeout(id); },
        }, {
            pick: (x, y, r, touch) => { const p = toPx(x, y, r); return this._armPick(p.x, p.y, el.width, el.height, touch); },
            isTap: (t) => t.kind === 'place',
            // Pen / finger (round-3 feedback): bone placement and a joint that is NOT selected act on a tap only — a drag
            // from there is the camera's (it orbits). A drag from a selected joint (or a gizmo / IK handle) moves it.
            tapOnly: (t) => t.kind === 'place' || ((t.kind === 'head' || t.kind === 'tail') && !this._isJointSelected(t.joint)),
            tap: (_t, x, y, r) => { const p = toPx(x, y, r); this._placeBoneAt(p.x, p.y, el.width, el.height); },
            pendingMove: (_t, x, y, r) => { const p = toPx(x, y, r); this._bonePlacementPreview(p.x, p.y, el.width, el.height); },
            begin: (t, x, y, r) => this._armBegin(t, x, y),
            move: (x, y, r) => { const p = toPx(x, y, r); this._armDragMove(x, y, p.x, p.y, el.width, el.height); },
            end: () => this._armEnd(),
            cancel: () => this._armCancel(),
            hover: (x, y, r) => { if (this.host.isPlaying) return; const p = toPx(x, y, r); this._armHover(p.x, p.y, el.width, el.height); },
            claim: (e) => claimPointerEvent(e),
        });
        this._armGesture = gesture;

        // The old mousedown handler stopped the mousedown of a press it took (so e.g. a document mousedown listener never
        // saw a joint click); the compat mousedown that follows a taken MOUSE pointerdown is stopped the same way.
        let stopMouseDown = false;
        // Play mode (Round 8): no hover pick (a full-scene raycast per mouse move under pointer-lock), no joint hover,
        // no drags. Up / cancel always run so a drag can never stay stuck.
        const onDown = (e: PointerEvent) => {
            if (this.host.isPlaying) return;
            if (this.isEditPanTool()) return;   // the host's Pan tool: the drag pans the camera
            this._armShift = !!e.shiftKey;   // additive joint select (Shift, or the host's latch)
            this._armPointerType = e.pointerType || 'mouse';
            const took = gesture.down(e);
            if (e.pointerType !== 'touch') stopMouseDown = took;
        };
        const onMouseDown = (e: MouseEvent) => { if (stopMouseDown) { stopMouseDown = false; e.stopPropagation(); } };
        const onMove = (e: PointerEvent) => { if (!this.host.isPlaying || gesture.busy) gesture.move(e); };
        const onUp = (e: PointerEvent) => gesture.up(e);
        const onCancel = (e: PointerEvent) => gesture.cancel(e);
        const onLost = (e: PointerEvent) => gesture.lostCapture(e);
        const onLeave = () => { gesture.leave(); if (!gesture.busy) this._armClearHover(); };

        addZonelessListener(el, 'pointerdown',   onDown,   { capture: true });
        addZonelessListener(el, 'pointermove',   onMove,   { capture: true });
        addZonelessListener(el, 'pointerup',     onUp,     { capture: true });
        addZonelessListener(el, 'pointercancel', onCancel, { capture: true });
        addZonelessListener(el, 'lostpointercapture', onLost, { capture: true });
        addZonelessListener(el, 'pointerleave',  onLeave);
        addZonelessListener(el, 'mousedown',     onMouseDown);
        this._boneOverlayListenerCleanup = () => {
            removeZonelessListener(el, 'pointerdown',   onDown,   { capture: true });
            removeZonelessListener(el, 'pointermove',   onMove,   { capture: true });
            removeZonelessListener(el, 'pointerup',     onUp,     { capture: true });
            removeZonelessListener(el, 'pointercancel', onCancel, { capture: true });
            removeZonelessListener(el, 'lostpointercapture', onLost, { capture: true });
            removeZonelessListener(el, 'pointerleave',  onLeave);
            removeZonelessListener(el, 'mousedown',     onMouseDown);
            gesture.reset();   // a live drag ends normally (its pose kept); a pending finger press is dropped
            if (this._armGesture === gesture) this._armGesture = null;
        };
    }

    /** The joint is in the joint selection (the primary or one of a multi-selection). */
    private _isJointSelected(joint: number): boolean {
        return this._selectedJointIndex === joint || this._extraJoints.has(joint);
    }

    /** Ray-test the armature handles at canvas px (x, y): the selected joint's gizmo axis (move / rotate), an IK handle,
     *  else a joint head / tail sphere (only when neither of the first two is under the pointer — the hover rule).
     *  Hidden handles (the gizmo during weight paint / bone placement, IK handles during weight paint) aren't hit. */
    private _armHitTest(skel: Skeleton3D, x: number, y: number, w: number, h: number, touch: boolean): {
        origin: vec3; dir: vec3; axis: GizmoAxis; ik: IKHandleHit | null; head: number | null; tail: number | null;
    } {
        const gr = this._gizmoRenderer!;
        const camera = this.renderer3D.getCamera();
        const { origin, dir } = this._picker.castRay(x, y, w, h, camera);
        const wp = this._weightPaint.isActive();
        gr.hitScale = touch ? Scene3DArmature.TOUCH_HIT_SCALE : 1;
        try {
            let axis: GizmoAxis = null;
            if (this._selectedJointIndex !== null && !this._selectedJointIsTail && !wp && !this._bonePlacementMode && !this._jointGizmoHidden) {
                const j = skel.data.joints[this._selectedJointIndex];
                if (j) {
                    const p: [number, number, number] = [j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]];
                    axis = this._armatureToolMode === 'rotate'
                        ? gr.hitTestJointRotateGizmo(origin, dir, p, camera)
                        : gr.hitTestJointGizmo(origin, dir, p, camera);
                }
            }
            let ik: IKHandleHit | null = null;
            if (!wp) {
                const chains = (skel.data.ikChains ?? []).filter(c => c.enabled);
                if (chains.length > 0) ik = gr.hitTestIKTargets(origin, dir, chains, camera);
            }
            let head: number | null = null, tail: number | null = null;
            if (!axis && !ik) {
                const bv = this.renderer3D.getBoneVisibility();   // hidden bones aren't clickable
                const hit = gr.hitTestJoint(origin, dir, skel, camera, bv.spring, bv.fk);
                if (hit) { if (hit.isTail) tail = hit.index; else head = hit.index; }
            }
            return { origin, dir, axis, ik, head, tail };
        } finally {
            gr.hitScale = 1;
        }
    }

    /** What a press at canvas px (x, y) grabs (pick-on-down), in the old mousedown's priority: bone placement, the FK
     *  rotate ring, the joint move gizmo, an IK handle, a tail sphere, a head sphere. Null = let the press through. */
    private _armPick(x: number, y: number, w: number, h: number, touch: boolean): ArmTarget | null {
        if (this._bonePlacementMode && this._bonePlacementSkeletonId) return { kind: 'place' };
        // Only intercept presses when the armature panel is explicitly open.
        if (!this._boneOverlayExplicit || !this._boneOverlaySkeletonId || !this._gizmoRenderer) return null;
        const skel = this.getSkeleton(this._boneOverlaySkeletonId);
        if (!skel) return null;
        const hit = this._armHitTest(skel, x, y, w, h, touch);
        const sel = this._selectedJointIndex;
        if (this._armatureToolMode === 'rotate' && sel !== null && skel.data.joints[sel]
            && (hit.axis === 'x' || hit.axis === 'y' || hit.axis === 'z')) {
            return { kind: 'rotate', joint: sel, axis: hit.axis };
        }
        if (this._armatureToolMode === 'move' && hit.axis !== null && sel !== null && skel.data.joints[sel]) {
            const jg = skel.data.joints[sel];
            const camera = this.renderer3D.getCamera();
            const origin = hit.origin, dir = hit.dir;
            const worldPos = vec3.fromValues(jg.worldMatrix[12], jg.worldMatrix[13], jg.worldMatrix[14]);
            const axisDir = _jointAxisDir(hit.axis);
            const isPlane = hit.axis === 'xy' || hit.axis === 'xz' || hit.axis === 'yz';
            let normal: vec3;
            if (isPlane) {
                normal = vec3.clone(axisDir);
            } else {
                const camDir = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position as unknown as vec3, worldPos));
                normal = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axisDir, vec3.cross(vec3.create(), axisDir, camDir)));
            }
            const denom = vec3.dot(normal, dir);
            if (Math.abs(denom) > 1e-6) {
                const t = vec3.dot(normal, vec3.subtract(vec3.create(), worldPos, origin)) / denom;
                if (t > 0) {
                    return { kind: 'axis', joint: sel, axis: hit.axis, startPt: vec3.scaleAndAdd(vec3.create(), origin, dir, t), jointStart: worldPos };
                }
            }
        }
        if (hit.ik) {
            const chain = skel.data.ikChains?.find(c => c.id === hit.ik!.chainId);
            if (chain && (hit.ik.handleType !== 'pole' || chain.poleTarget)) return { kind: 'ik', handle: { ...hit.ik } };
        }
        if (hit.tail !== null && !this._weightPaint.isActive() && skel.data.joints[hit.tail]) return { kind: 'tail', joint: hit.tail };
        if (hit.head !== null && skel.data.joints[hit.head]) return { kind: 'head', joint: hit.head };
        return null;
    }

    /** Start the drag the press picked (at the PRESS point — a finger's drag starts a frame / a few px later). Takes a
     *  snapshot so {@link _armCancel} can put the pose and the joint selection back exactly. */
    private _armBegin(t: ArmTarget, clientX: number, clientY: number): boolean {
        if (t.kind === 'place') return false;
        const skel = this._boneOverlaySkeletonId ? this.getSkeleton(this._boneOverlaySkeletonId) : null;
        if (!skel) return false;
        const joints = skel.data.joints;
        const cam = this.renderer3D.getCamera();
        // Camera-facing drag plane normal (head / tail drags).
        vec3.sub(this._dragPlaneNormal, cam.position as unknown as vec3, cam.target as unknown as vec3);
        vec3.normalize(this._dragPlaneNormal, this._dragPlaneNormal);
        const holdOrbit = () => { if (this._orbitController) this._orbitController.enabled = false; };
        const prevSel = this._selectedJointIndex, prevTail = this._selectedJointIsTail;
        const restoreSelection = () => {
            this._selectedJointIndex = prevSel;
            this._selectedJointIsTail = prevTail;
            this.renderer3D.setSelectedJoint(prevSel, prevTail);
        };

        switch (t.kind) {
            case 'rotate': {
                const jr = joints[t.joint];
                if (!jr) return false;
                const q0 = [...jr.localRotation] as [number, number, number, number];
                this._isRotatingJoint = true;
                this._rotatingJointIdx = t.joint;
                this._rotatingJointAxis = t.axis;
                this._rotatingJointInitialQuat = [...q0] as [number, number, number, number];
                this._rotatingJointAccAngle = 0;
                this._rotatingLastClientX = clientX;
                this._rotatingLastClientY = clientY;
                this.renderer3D.setJointGizmoDraggingAxis(t.axis);
                holdOrbit();
                this._armRestore = () => skel.setJointRotation(t.joint, q0);
                return true;
            }
            case 'axis': {
                const j = joints[t.joint];
                if (!j) return false;
                const p0 = [...j.localPosition] as [number, number, number];
                this._isDraggingJointAxis = true;
                this._dragJointAxisAxis = t.axis;
                vec3.copy(this._dragJointAxisStartPt, t.startPt);
                vec3.copy(this._dragJointAxisJointStart, t.jointStart);
                this.renderer3D.setJointGizmoDraggingAxis(t.axis);
                holdOrbit();
                this._armRestore = () => skel.moveJoint(t.joint, p0);
                return true;
            }
            case 'ik': {
                const chain = skel.data.ikChains?.find(c => c.id === t.handle.chainId);
                if (!chain) return false;
                const isPole = t.handle.handleType === 'pole';
                const handlePos = isPole ? chain.poleTarget : chain.target;
                if (!handlePos) return false;
                const target0 = [...chain.target] as [number, number, number];
                const pole0 = chain.poleTarget ? [...chain.poleTarget] as [number, number, number] : undefined;
                this._draggingIKHandle = { ...t.handle };
                this.renderer3D.setDraggingIKHandle(this._draggingIKHandle);
                vec3.sub(this._ikDragPlaneNormal, cam.position as unknown as vec3, cam.target as unknown as vec3);
                vec3.normalize(this._ikDragPlaneNormal, this._ikDragPlaneNormal);
                vec3.set(this._ikDragPlanePoint, handlePos[0], handlePos[1], handlePos[2]);
                holdOrbit();
                this._armRestore = () => { chain.target = target0; if (pole0) chain.poleTarget = pole0; };
                return true;
            }
            case 'tail': {
                const j = joints[t.joint];
                if (!j) return false;
                const off0 = [...j.tailOffset] as [number, number, number];
                // Select the owning joint so panel XYZ inputs activate (tail sphere → extend-chain semantics).
                this._selectedJointIndex = t.joint;
                this._selectedJointIsTail = true;
                this.renderer3D.setSelectedJoint(t.joint, true);
                this.ctx.emitSceneGraphChanged();
                const wm = j.worldMatrix, to = j.tailOffset ?? [0, 0.3, 0];
                vec3.set(this._dragPlanePoint,
                    wm[0]*to[0] + wm[4]*to[1] + wm[8]*to[2]  + wm[12],
                    wm[1]*to[0] + wm[5]*to[1] + wm[9]*to[2]  + wm[13],
                    wm[2]*to[0] + wm[6]*to[1] + wm[10]*to[2] + wm[14],
                );
                holdOrbit();
                this._isDraggingTail = true;
                this._dragTailJointIdx = t.joint;
                this._armRestore = () => { skel.setJointTailOffset(t.joint, off0); restoreSelection(); };
                return true;
            }
            case 'head': {
                const j = joints[t.joint];
                if (!j) return false;
                // Tool strip (UI review §4): Shift / the additive latch toggles the joint in a multi-selection (on the
                // RELEASE of a tap in Move / Rotate — a drag past the slop moves it instead); the Select and IK tools
                // only select (no drag). The press is taken back exactly by a 2nd finger / pointercancel / Esc.
                const additive = this._armShift || (this.ctx.interactionService as { additiveSelect3D?: boolean }).additiveSelect3D === true;
                const p0 = [...j.localPosition] as [number, number, number];
                const canDrag = this._armTool !== 'select' && this._armTool !== 'ik' && !this._weightPaint.isActive();
                if (additive && canDrag) {
                    // Additive press in Move / Rotate: nothing changes yet — the release toggles the joint (a tap), a
                    // move past the slop drags it instead (_armHeadDragStart). Cancel restores the pose + selection.
                    const snap = this._snapshotJointSelection();
                    const hp: ArmHeadPress = {
                        skelId: skel.id, joint: t.joint, p0, x: clientX, y: clientY, pending: true,
                        slop: this._armPointerType === 'touch' ? ArmaturePointerGesture.TAP_SLOP_PX : Scene3DArmature.HEAD_DRAG_SLOP_PX,
                    };
                    this._armHead = hp;
                    holdOrbit();
                    this._armRestore = () => { if (!hp.pending) skel.moveJoint(t.joint, p0); this._restoreJointSelection(snap); };
                    return true;
                }
                // Select / IK tools (and an additive press during weight paint): select (toggle) on the press, no drag.
                if (additive || this._armTool === 'select' || this._armTool === 'ik') {
                    const snap = this._snapshotJointSelection();
                    this.selectArmatureJoint(skel.id, t.joint, additive);
                    this._armRestore = () => this._restoreJointSelection(snap);
                    return true;
                }
                // Select the pressed joint and emit so the panel syncs (head sphere → branch-here semantics).
                this._selectedJointIndex = t.joint;
                this._selectedJointIsTail = false;
                this.renderer3D.setSelectedJoint(t.joint);
                this.ctx.emitSceneGraphChanged();
                this.ctx.scheduleRender();
                // Dragging is suppressed during weight paint — pressing a joint just selects it.
                if (!this._weightPaint.isActive()) {
                    holdOrbit();
                    this._isDraggingJoint = true;
                    this._dragJointIdx = t.joint;
                    vec3.set(this._dragPlanePoint, j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]);
                    this._armHead = { skelId: skel.id, joint: t.joint, p0, x: clientX, y: clientY, slop: 0, pending: false };
                    this._armRestore = () => { skel.moveJoint(t.joint, p0); restoreSelection(); };
                } else {
                    this._armRestore = restoreSelection;
                }
                return true;
            }
        }
        return false;
    }

    /** Ray (canvas px) ∩ the plane through `point` with `normal`, or null (parallel / behind the camera). */
    private _armRayPlane(x: number, y: number, w: number, h: number, point: vec3, normal: vec3): vec3 | null {
        const { origin, dir } = this._picker.castRay(x, y, w, h, this.renderer3D.getCamera());
        const o = origin, d = dir;
        const denom = vec3.dot(d, normal);
        if (Math.abs(denom) <= 1e-6) return null;
        const t = vec3.dot(vec3.sub(_armTmpA, point, o), normal) / denom;
        if (t <= 0) return null;
        return vec3.scaleAndAdd(_armTmpB, o, d, t);
    }

    /** One drag step (client + canvas px). Joint moves write the skeleton directly + render: the panel / outliner
     *  refresh ONCE at the end (moveBone3D's per-move scene-graph event bumped the structure version and refreshed the
     *  armature panel every frame of a drag). */
    private _armDragMove(clientX: number, clientY: number, x: number, y: number, w: number, h: number): void {
        const skel = this._boneOverlaySkeletonId ? this.getSkeleton(this._boneOverlaySkeletonId) : null;
        if (!skel) return;

        // ── An additive head press still deciding: within the slop it stays a tap; past it, it becomes the joint drag.
        const hp = this._armHead;
        if (hp?.pending) {
            if (Math.hypot(clientX - hp.x, clientY - hp.y) <= hp.slop) return;
            if (!this._armHeadDragStart(skel, hp)) return;
        }

        // ── IK handle drag (target or pole) ─────────────────────────
        if (this._draggingIKHandle) {
            const chain = skel.data.ikChains?.find(c => c.id === this._draggingIKHandle!.chainId);
            const p = chain ? this._armRayPlane(x, y, w, h, this._ikDragPlanePoint, this._ikDragPlaneNormal) : null;
            if (chain && p) {
                if (this._draggingIKHandle.handleType === 'target') chain.target = [p[0], p[1], p[2]];
                else chain.poleTarget = [p[0], p[1], p[2]];
                this.ctx.scheduleRender();
            }
            return;
        }

        // ── FK rotate drag ───────────────────────────────────────────
        if (this._isRotatingJoint && this._rotatingJointIdx !== null && this._rotatingJointAxis) {
            const dx = clientX - this._rotatingLastClientX;
            const dy = clientY - this._rotatingLastClientY;
            this._rotatingLastClientX = clientX;
            this._rotatingLastClientY = clientY;
            this._rotatingJointAccAngle += (dx + dy) * 0.01;
            const a = this._rotatingJointAccAngle * 0.5;
            const s = Math.sin(a), c = Math.cos(a);
            const ax = this._rotatingJointAxis;
            const dq: [number, number, number, number] = ax === 'x' ? [s, 0, 0, c] : ax === 'y' ? [0, s, 0, c] : [0, 0, s, c];
            // Compose: delta * initialRotation (pre-multiply so delta is in world space)
            const [ix, iy, iz, iw] = this._rotatingJointInitialQuat;
            const [dx2, dy2, dz2, dw2] = dq;
            skel.setJointRotation(this._rotatingJointIdx, [
                dw2*ix + dx2*iw + dy2*iz - dz2*iy,
                dw2*iy - dx2*iz + dy2*iw + dz2*ix,
                dw2*iz + dx2*iy - dy2*ix + dz2*iw,
                dw2*iw - dx2*ix - dy2*iy - dz2*iz,
            ]);
            this.ctx.scheduleRender();
            return;
        }

        // ── Joint gizmo axis drag ────────────────────────────────────
        if (this._isDraggingJointAxis && this._dragJointAxisAxis && this._selectedJointIndex !== null) {
            const j = skel.data.joints[this._selectedJointIndex];
            if (!j) return;
            const camera = this.renderer3D.getCamera();
            const axisStr = this._dragJointAxisAxis;
            const axisDir = _jointAxisDir(axisStr);
            const isPlane = axisStr === 'xy' || axisStr === 'xz' || axisStr === 'yz';
            let normal: vec3;
            if (isPlane) {
                normal = axisDir;
            } else {
                const camDir = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.position as unknown as vec3, this._dragJointAxisJointStart));
                normal = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), axisDir, vec3.cross(vec3.create(), axisDir, camDir)));
            }
            const curPt = this._armRayPlane(x, y, w, h, this._dragJointAxisJointStart, normal);
            if (!curPt) return;
            const disp = vec3.subtract(vec3.create(), curPt, this._dragJointAxisStartPt);
            const newWorldPos = isPlane
                ? vec3.add(vec3.create(), this._dragJointAxisJointStart, disp)
                : vec3.scaleAndAdd(vec3.create(), this._dragJointAxisJointStart, axisDir, vec3.dot(disp, axisDir));
            const invParent = mat4.create();
            if (j.parentIndex >= 0) mat4.invert(invParent, skel.data.joints[j.parentIndex].worldMatrix as unknown as mat4);
            const lp = vec3.transformMat4(vec3.create(), newWorldPos, invParent);
            skel.moveJoint(this._selectedJointIndex, [lp[0], lp[1], lp[2]]);
            this.ctx.scheduleRender();
            return;
        }

        // ── Joint drag-to-move: the ray ∩ a camera-facing plane locked to the joint's world position at drag start,
        //    converted back into the joint's local space (root joints: local = world). ──
        if (this._isDraggingJoint && this._dragJointIdx !== null) {
            const j = skel.data.joints[this._dragJointIdx];
            const p = j ? this._armRayPlane(x, y, w, h, this._dragPlanePoint, this._dragPlaneNormal) : null;
            if (!j || !p) return;
            const invParent = mat4.create();
            if (j.parentIndex >= 0) mat4.invert(invParent, skel.data.joints[j.parentIndex].worldMatrix as unknown as mat4);
            const lp = vec3.transformMat4(vec3.create(), p, invParent);
            skel.moveJoint(this._dragJointIdx, [lp[0], lp[1], lp[2]]);
            this.ctx.scheduleRender();
            return;
        }

        // ── Tail drag: tailOffset in the joint's own local frame ─────
        if (this._isDraggingTail && this._dragTailJointIdx !== null) {
            const j = skel.data.joints[this._dragTailJointIdx];
            const p = j ? this._armRayPlane(x, y, w, h, this._dragPlanePoint, this._dragPlaneNormal) : null;
            if (!j || !p) return;
            const invJoint = mat4.create();
            mat4.invert(invJoint, j.worldMatrix as unknown as mat4);
            const lp = vec3.transformMat4(vec3.create(), p, invJoint);
            skel.setJointTailOffset(this._dragTailJointIdx, [lp[0], lp[1], lp[2]]);
            this.ctx.scheduleRender();
        }
    }

    /** Clear every drag flag (+ the renderer's dragging state) and give the orbit back — unless weight paint is
     *  holding it disabled. */
    private _armClearDrag(): void {
        if (this._orbitController && !this._weightPaint.isActive()) this._orbitController.enabled = true;
        if (this._draggingIKHandle) { this._draggingIKHandle = null; this.renderer3D.setDraggingIKHandle(null); }
        if (this._isRotatingJoint || this._isDraggingJointAxis) this.renderer3D.setJointGizmoDraggingAxis(null);
        this._isRotatingJoint = false;
        this._rotatingJointIdx = null;
        this._rotatingJointAxis = null;
        this._isDraggingJointAxis = false;
        this._dragJointAxisAxis = null;
        this._isDraggingJoint = false;
        this._dragJointIdx = null;
        this._isDraggingTail = false;
        this._dragTailJointIdx = null;
        this._armHead = null;
    }

    /** An additive head press moved past its slop: it is a drag, not a tap — the pressed joint joins the selection
     *  (additively; already selected → it just becomes the primary, the rest kept) and the joint drag starts. */
    private _armHeadDragStart(skel: Skeleton3D, hp: ArmHeadPress): boolean {
        const j = skel.data.joints[hp.joint];
        if (!j || skel.id !== hp.skelId) return false;
        hp.pending = false;
        const cur = this.__selJoint;
        if (cur !== hp.joint && !this._extraJoints.has(hp.joint)) {
            this.selectArmatureJoint(skel.id, hp.joint, true);
        } else if (cur !== hp.joint || this._selectedJointIsTail) {
            const extras = new Set(this._extraJoints);
            extras.delete(hp.joint);
            if (cur !== null && cur !== hp.joint) extras.add(cur);
            this._jointSelKeepExtras = true;
            try {
                this._extraJoints = extras;
                this._selectedJointIndex = hp.joint;
                this._selectedJointIsTail = false;
            } finally { this._jointSelKeepExtras = false; }
            this.renderer3D.setSelectedJoint(hp.joint);
            this._syncExtraJoints();
            this._emitJointSelection();
            this.ctx.emitSceneGraphChanged();
        }
        this._isDraggingJoint = true;
        this._dragJointIdx = hp.joint;
        vec3.set(this._dragPlanePoint, j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]);
        return true;
    }

    /** The drag finished: keep the result and emit ONCE so the panel refreshes the final position. A head drag that
     *  moved its joint is ONE 'Move joint' undo step; an additive head press released within its slop toggles the joint. */
    private _armEnd(): void {
        const hp = this._armHead;
        this._armRestore = null;
        this._armClearDrag();
        if (hp?.pending) {
            this.selectArmatureJoint(hp.skelId, hp.joint, true);
        } else if (hp) {
            const j = this.getSkeleton(hp.skelId)?.data.joints[hp.joint];
            const p1 = j ? [...j.localPosition] as [number, number, number] : null;
            if (p1 && (p1[0] !== hp.p0[0] || p1[1] !== hp.p0[1] || p1[2] !== hp.p0[2])) {
                const p0 = hp.p0, apply = (p: [number, number, number]) => {
                    this.getSkeleton(hp.skelId)?.moveJoint(hp.joint, [...p] as [number, number, number]);
                    this.ctx.emitSceneGraphChanged();
                    this.ctx.scheduleRender();
                };
                (this.host.undoManager as UndoManager3D | undefined)?.push({
                    description: 'Move joint',
                    undo: () => apply(p0),
                    redo: () => apply(p1),
                });
            }
        }
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Esc: take back a live armature drag / a pending press (pose + selection restored, no undo step). */
    private _armAbort(): boolean {
        const g = this._armGesture;
        if (!g?.busy) return false;
        g.abort();
        return true;
    }

    /** The drag was taken back (a 2nd finger → pinch / orbit, or pointercancel): pose + joint selection restored
     *  exactly, no undo entry. */
    private _armCancel(): void {
        const restore = this._armRestore;
        this._armRestore = null;
        this._armClearDrag();
        restore?.();
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Mouse / pen hover (one per frame): the mesh hover outline, the root-bone tail preview, and the joint / gizmo /
     *  IK hover highlights. A finger never hovers (TOUCH-16). */
    private _armHover(x: number, y: number, w: number, h: number): void {
        this._bonePlacementPreview(x, y, w, h);
        // Suppress mesh hover highlight during bone placement — clicks belong to the bone system.
        if (!this._bonePlacementMode) {
            const id = this.pick3D(x, y, w, h)?.meshId ?? null;
            if (id !== this._ptrHoverId || this.renderer3D.getHoveredMeshIds() !== this._ptrHoverSet) {
                this.setHoveredMesh(id);
                this._ptrHoverId = id;
                this._ptrHoverSet = this.renderer3D.getHoveredMeshIds();
            }
        }
        if (!this._gizmoRenderer || !this._boneOverlayExplicit || !this._boneOverlaySkeletonId) return;
        const skel = this.getSkeleton(this._boneOverlaySkeletonId);
        if (!skel) return;
        const hit = this._armHitTest(skel, x, y, w, h, false);
        if (hit.axis !== this._jointGizmoHoveredAxis) {
            this._jointGizmoHoveredAxis = hit.axis;
            this.renderer3D.setJointGizmoHoveredAxis(hit.axis);
            this.ctx.scheduleRender();
        }
        const ik = hit.ik;
        if (ik?.chainId !== this._hoveredIKHandle?.chainId || ik?.handleType !== this._hoveredIKHandle?.handleType) {
            this._hoveredIKHandle = ik;
            this.renderer3D.setHoveredIKHandle(ik);
            this.ctx.scheduleRender();
        }
        if (hit.head !== this._hoveredJointIndex || hit.tail !== this._hoveredTailJointIndex) {
            this._hoveredJointIndex = hit.head;
            this._hoveredTailJointIndex = hit.tail;
            this.renderer3D.setHoveredJoint(hit.head);
            this.renderer3D.setHoveredTailJoint(hit.tail);
            this.ctx.scheduleRender();
        }
    }

    /** The pointer left the canvas (or a finger lifted): drop every hover highlight. */
    private _armClearHover(): void {
        if (this.renderer3D.getHoveredMeshIds().size > 0 || this._ptrHoverId !== null) {
            this.setHoveredMesh(null);
            this._ptrHoverId = null;
            this._ptrHoverSet = this.renderer3D.getHoveredMeshIds();
        }
        if (this._hoveredIKHandle) {
            this._hoveredIKHandle = null;
            this.renderer3D.setHoveredIKHandle(null);
            this.ctx.scheduleRender();
        }
        if (this._hoveredJointIndex !== null || this._hoveredTailJointIndex !== null) {
            this._hoveredJointIndex = null;
            this._hoveredTailJointIndex = null;
            this.renderer3D.setHoveredJoint(null);
            this.renderer3D.setHoveredTailJoint(null);
            this.ctx.scheduleRender();
        }
        if (this._jointGizmoHoveredAxis !== null) {
            this._jointGizmoHoveredAxis = null;
            this.renderer3D.setJointGizmoHoveredAxis(null);
            this.ctx.scheduleRender();
        }
    }

    /** Root-bone placement, phase 2: the pending joint's tail follows the pointer (onto the mesh, else a
     *  camera-facing plane at the joint's depth). */
    private _bonePlacementPreview(x: number, y: number, w: number, h: number): void {
        if (!this._bonePlacementMode || this._bonePlacementPendingIdx === null || !this._bonePlacementSkeletonId) return;
        const skel = this.getSkeleton(this._bonePlacementSkeletonId);
        const j = skel?.data.joints[this._bonePlacementPendingIdx];
        if (!skel || !j) return;
        const camera = this.renderer3D.getCamera();
        const { origin, dir } = this._picker.castRay(x, y, w, h, camera);
        const meshHit = this._picker.pickMesh(x, y, w, h, camera, this.getAllMeshes());
        let wX: number, wY: number, wZ: number;
        if (meshHit) {
            [wX, wY, wZ] = meshHit.hitPoint;
        } else {
            const jDepth = vec3.distance(
                [j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]] as unknown as vec3,
                camera.position as unknown as vec3,
            );
            wX = origin[0] + dir[0] * jDepth;
            wY = origin[1] + dir[1] * jDepth;
            wZ = origin[2] + dir[2] * jDepth;
        }
        const invJ = mat4.create();
        mat4.invert(invJ, j.worldMatrix as unknown as mat4);
        const lt = vec3.transformMat4(vec3.create(), [wX, wY, wZ] as unknown as vec3, invJ);
        skel.setJointTailOffset(this._bonePlacementPendingIdx, [lt[0], lt[1], lt[2]]);
        this.ctx.scheduleRender();
    }

    /** Bone placement press (mouse) / tap (finger) at canvas px: a child bone from the selected joint, or the root
     *  bone's head then tail. Every placement must hit a mesh (a miss keeps the phase alive). */
    private _placeBoneAt(x: number, y: number, w: number, h: number): void {
        if (!this._bonePlacementMode || !this._bonePlacementSkeletonId) return;
        const skel = this.getSkeleton(this._bonePlacementSkeletonId);
        if (!skel) return;
        const camera = this.renderer3D.getCamera();

        // Guard: re-indexing on deletion can make cached index stale.
        const rawParent = this._selectedJointIndex ?? -1;
        const parentIdx = (rawParent >= 0 && rawParent < skel.data.joints.length) ? rawParent : -1;
        if (rawParent !== parentIdx) {
            this._selectedJointIndex = null;
            this.renderer3D.setSelectedJoint(null);
        }

        const meshHit = this._picker.pickMesh(x, y, w, h, camera, this.getAllMeshes());
        if (!meshHit) return;   // must hit the mesh

        if (parentIdx >= 0) {
            // ── Child bone: single press ─────────────────────────────────────
            // Tail-selected → head snaps to parent's tail (extend chain). Head-selected → head at the parent (branch).
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
            // Always select the new bone's tail — it's a leaf so the tail sphere renders; Add Bone again extends it.
            this._selectedJointIndex = newIdx;
            this._selectedJointIsTail = true;
            this.renderer3D.setSelectedJoint(newIdx, true);
            this._endBonePlacement();
        } else if (this._bonePlacementPendingIdx === null) {
            // ── Root bone phase 1: head ──────────────────────────────────────
            const [hX, hY, hZ] = meshHit.hitPoint;
            // Add the joint; its tail follows the pointer (preview) until the second press finalizes it.
            const newIdx = skel.addJoint(-1, [hX, hY, hZ], `joint_${skel.data.joints.length}`);
            skel.setJointTailOffset(newIdx, [0, 0.05, 0]); // tiny placeholder until the tail press
            this._bonePlacementPendingIdx = newIdx;
            this._selectedJointIndex = newIdx;
            this.renderer3D.setSelectedJoint(newIdx);
            this.ctx.scheduleRender();
        } else {
            // ── Root bone phase 2: tail ──────────────────────────────────────
            const pendingIdx = this._bonePlacementPendingIdx;
            const j = skel.data.joints[pendingIdx];
            if (j) {
                const [tX, tY, tZ] = meshHit.hitPoint;
                const invJ = mat4.create();
                mat4.invert(invJ, j.worldMatrix as unknown as mat4);
                const lt = vec3.transformMat4(vec3.create(), [tX, tY, tZ] as unknown as vec3, invJ);
                skel.setJointTailOffset(pendingIdx, [lt[0], lt[1], lt[2]]);
            }
            // Switch selection to the tail now that the bone is fully placed
            this._selectedJointIsTail = true;
            this.renderer3D.setSelectedJoint(pendingIdx, true);
            this._endBonePlacement();
        }
    }

    private _endBonePlacement(): void {
        const skelId = this._bonePlacementSkeletonId;
        this._bonePlacementMode = false;
        this._bonePlacementSkeletonId = null;
        this._bonePlacementPendingIdx = null;
        this.renderer3D.setBonePlacementActive(false);
        // The tool strip's Add Bone tool stays on: the next tap adds the next bone (extending from the new tail).
        if (this._armTool === 'addbone' && skelId) this.enterBonePlacementMode3D(skelId);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    // ── Armature tool strip + tap-select (UI review 2026-10-07 §4) ───────────────────────────────────

    /** The active tool of the armature tool strip. */
    private _armTool: ArmatureTool = 'move';
    /** The last overlay press had Shift held. */
    private _armShift = false;
    /** The Weight tool entered weight paint (leaving the tool exits it). */
    private _armWeightEntered = false;
    private _jointGizmoHidden = false;

    private _setJointGizmoHidden(hidden: boolean): void {
        this._jointGizmoHidden = hidden;
        (this.renderer3D as { setJointGizmoHidden?(h: boolean): void }).setJointGizmoHidden?.(hidden);
    }

    private _syncExtraJoints(): void {
        (this.renderer3D as { setExtraSelectedJoints?(s: ReadonlySet<number> | null): void }).setExtraSelectedJoints?.(this._extraJoints.size ? this._extraJoints : null);
    }

    /** The selected joints (primary first, then the rest in selection order) of the overlay skeleton. */
    getSelectedArmatureJoints(): { skeletonId: string; jointIndex: number }[] {
        const id = this._boneOverlaySkeletonId, p = this.__selJoint;
        if (!id || p === null) return [];
        return [p, ...[...this._extraJoints].filter(j => j !== p)].map(jointIndex => ({ skeletonId: id, jointIndex }));
    }

    /** Subscribe to joint-selection changes (tap, panel, programmatic, a removed bone); returns the unsubscribe. */
    onJointSelectionChanged(cb: (sel: { skeletonId: string; jointIndex: number }[]) => void): () => void {
        this._jointSelListeners.add(cb);
        return () => { this._jointSelListeners.delete(cb); };
    }

    private _emitJointSelection(): void {
        const sel = this.getSelectedArmatureJoints();
        const key = sel.map(s => `${s.skeletonId}:${s.jointIndex}`).join(',');
        if (key === this._jointSelKey) return;
        this._jointSelKey = key;
        for (const cb of [...this._jointSelListeners]) { try { cb(sel); } catch (err) { console.warn('[3D] joint selection listener', err); } }
    }

    private _snapshotJointSelection(): { primary: number | null; tail: boolean; extras: number[] } {
        return { primary: this.__selJoint, tail: this._selectedJointIsTail, extras: [...this._extraJoints] };
    }

    private _restoreJointSelection(s: { primary: number | null; tail: boolean; extras: number[] }): void {
        this._jointSelKeepExtras = true;
        try {
            this._extraJoints = new Set(s.extras);
            this._selectedJointIndex = s.primary;
            this._selectedJointIsTail = s.tail;
        } finally { this._jointSelKeepExtras = false; }
        this.renderer3D.setSelectedJoint(s.primary, s.tail);
        this._syncExtraJoints();
        this._emitJointSelection();
        this.ctx.scheduleRender();
    }

    /**
     * Select joint `jointIndex` of the overlay skeleton (tap-select). Not additive: only it. Additive: toggles it in a
     * multi-selection (an added joint becomes the primary — the gizmo's; removing the primary promotes the most recent
     * other one). The Weight tool paints the new primary joint. False when `skeletonId` is not the overlay skeleton or
     * the joint does not exist.
     */
    selectArmatureJoint(skeletonId: string, jointIndex: number, additive = false): boolean {
        const skel = this.getSkeleton(skeletonId);
        if (!skel || skeletonId !== this._boneOverlaySkeletonId || !skel.data.joints[jointIndex]) return false;
        const cur = this.__selJoint;
        let primary: number | null = jointIndex;
        const extras = new Set(this._extraJoints);
        if (additive && cur !== null) {
            const selected = cur === jointIndex || extras.has(jointIndex);
            if (selected) {
                extras.delete(jointIndex);
                if (cur === jointIndex) { const rest = [...extras]; primary = rest.length ? rest[rest.length - 1] : null; if (primary !== null) extras.delete(primary); }
                else primary = cur;
            } else {
                extras.add(cur);
                extras.delete(jointIndex);
            }
        } else extras.clear();
        this._jointSelKeepExtras = true;
        try {
            this._extraJoints = extras;
            this._selectedJointIndex = primary;
            this._selectedJointIsTail = false;
        } finally { this._jointSelKeepExtras = false; }
        this.renderer3D.setSelectedJoint(primary);
        this._syncExtraJoints();
        if (this._armTool === 'weight' && this._weightPaint.isActive() && primary !== null) this._weightPaint.setWeightPaintJoint3D(primary);
        this._emitJointSelection();
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * The overlay skeleton's joint (head) nearest client point (clientX, clientY) on screen within `radiusCss` CSS px
     * (default 24), or null — only while a bone overlay is shown (Armature mode). Hidden bone categories are skipped.
     */
    pickArmatureJointAt(clientX: number, clientY: number, radiusCss = 24): { skeletonId: string; jointIndex: number; jointName: string } | null {
        const id = this._boneOverlaySkeletonId;
        const skel = id ? this.getSkeleton(id) : null;
        const el = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!id || !skel || !el) return null;
        const r = el.getBoundingClientRect();
        const vp = this.renderer3D.getCamera().getViewProjectionMatrix() as unknown as ArrayLike<number>;
        const bv = (this.renderer3D as { getBoneVisibility?(): { spring: boolean; fk: boolean } }).getBoneVisibility?.() ?? { spring: true, fk: true };
        const spring = new Set<number>();
        for (const c of skel.data.springChains ?? []) if (c.enabled) for (const ji of c.jointIndices) spring.add(ji);
        let best: number | null = null, bestD = radiusCss;
        for (const j of skel.data.joints) {
            if (!(spring.has(j.index) ? bv.spring : bv.fk) && j.index !== this.__selJoint) continue;
            const wx = j.worldMatrix[12], wy = j.worldMatrix[13], wz = j.worldMatrix[14];
            const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
            if (!(cw > 1e-9)) continue;
            const nx = (vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12]) / cw, ny = (vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13]) / cw;
            const sx = r.left + (nx + 1) * 0.5 * r.width, sy = r.top + (1 - ny) * 0.5 * r.height;
            const d = Math.hypot(sx - clientX, sy - clientY);
            if (d <= bestD) { bestD = d; best = j.index; }
        }
        return best === null ? null : { skeletonId: id, jointIndex: best, jointName: skel.data.joints[best].name };
    }

    getArmatureActiveTool(): ArmatureTool { return this._armTool; }

    /** Leaving the current tool for `next`: Add Bone stops placing, Weight leaves weight paint (if it entered it). */
    private _leaveArmTool(next: ArmatureTool): void {
        if (this._armTool === 'addbone' && next !== 'addbone' && this._bonePlacementMode) this.exitBonePlacementMode3D();
        if (this._armTool === 'weight' && next !== 'weight' && this._armWeightEntered) {
            this._armWeightEntered = false;
            if (this._weightPaint.isActive()) this._weightPaint.exitWeightPaintMode3D();
        }
    }

    /**
     * Switch the armature tool strip's tool (UI review §4): select (tap selects, no gizmo, no drag), rotate / move (the
     * joint gizmo — FK rotate / bind-pose move), addbone (bone placement stays on: each tap on the mesh adds a bone from
     * the selected joint), ik (taps select the IK end joint; setArmatureIK3D configures it; IK handles stay draggable),
     * weight (weight paint of the overlay skeleton's skinned mesh on the selected joint). False (tool unchanged) when the
     * tool needs a skeleton / a skinned mesh that isn't there.
     */
    setArmatureActiveTool(tool: ArmatureTool): boolean {
        if (!ARMATURE_TOOLS.includes(tool)) return false;
        const skelId = this._boneOverlaySkeletonId;
        if ((tool === 'addbone' || tool === 'weight') && !skelId) return false;
        if (tool === 'weight' && !this._weightPaint.isActive()) {
            const meshId = this._meshForSkeleton(skelId!);
            const mesh = meshId ? this.getMesh(meshId) : null;
            if (!meshId || !(mesh instanceof SkinnedMesh3D)) return false;
            this._leaveArmTool(tool);
            const joint = this.__selJoint ?? 0;
            if (!this._weightPaint.enterWeightPaintMode3D(meshId, skelId!, joint)) return false;
            this._armWeightEntered = true;
        } else {
            this._leaveArmTool(tool);
        }
        if (tool === 'move' || tool === 'rotate') this.setArmatureToolMode(tool);
        this._armTool = tool;
        this._setJointGizmoHidden(tool !== 'move' && tool !== 'rotate');
        if (tool === 'addbone' && !this._bonePlacementMode) this.enterBonePlacementMode3D(skelId!);
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Add a child joint of `parentJointIndex` (-1 = a new root): its head at the parent's tail, its tail continuing the
     * parent's bone (same direction and length; a root gets [0, 0.3, 0]). The new joint becomes the selection (when the
     * skeleton is the overlay's). ONE undo step. Returns the new joint index, or -1.
     */
    addArmatureChildJoint(skeletonId: string, parentJointIndex: number, name?: string): number {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return -1;
        const joints = skel.data.joints;
        if (!Number.isInteger(parentJointIndex) || parentJointIndex < -1 || parentJointIndex >= joints.length) return -1;
        const parent = parentJointIndex >= 0 ? joints[parentJointIndex] : null;
        const localPos: [number, number, number] = parent ? [...parent.tailOffset] as [number, number, number] : [0, 0, 0];
        let tail: [number, number, number] = parent ? [...parent.tailOffset] as [number, number, number] : [0, 0.3, 0];
        if (!(Math.hypot(tail[0], tail[1], tail[2]) > 1e-6)) tail = [0, 0.3, 0];
        const nm = name?.trim() || `joint_${joints.length}`;
        const before = this._snapshotJointSelection();
        const add = (): number => {
            const idx = skel.addJoint(parentJointIndex, localPos, nm);
            skel.setJointTailOffset(idx, tail);
            if (skeletonId === this._boneOverlaySkeletonId) this.selectArmatureJoint(skeletonId, idx, false);
            this.ctx.emitSceneGraphChanged();
            this.ctx.scheduleRender();
            return idx;
        };
        const idx = add();
        this.host.undoManager.push({
            description: 'Add bone',
            undo: () => {
                if (skel.data.joints.length === idx + 1) skel.removeJoint(idx);
                if (skeletonId === this._boneOverlaySkeletonId) this._restoreJointSelection(before);
                this.ctx.emitSceneGraphChanged();
                this.ctx.scheduleRender();
            },
            redo: () => { if (skel.data.joints.length === idx) add(); },
        });
        return idx;
    }

    /**
     * IK on the chain ending at `jointIndex` (the tool strip's IK + the joint properties' "chain length + pole"): creates
     * the chain when there is none (target = the joint's position), sets its length (≥ 2, as addIKChain), enabled, and
     * the pole — `poleJointIndex` a joint (the pole target is placed at that joint's current world position), null =
     * no pole, undefined = unchanged. Returns the chain id, or null (no such skeleton / joint; or disabling a chain that
     * doesn't exist — nothing to do). Not an undo step (as the other IK chain setters).
     */
    setArmatureIK(skeletonId: string, jointIndex: number, opts: { chainLength: number; poleJointIndex?: number | null; enabled: boolean }): string | null {
        const skel = this.getSkeleton(skeletonId);
        const joints = skel?.data.joints;
        if (!skel || !joints?.[jointIndex]) return null;
        let chain = skel.data.ikChains?.find(c => c.endJointIdx === jointIndex) ?? null;
        const len = Math.max(2, Math.min(64, Math.round(Number.isFinite(opts.chainLength) ? opts.chainLength : 2)));
        if (!chain) {
            if (!opts.enabled) return null;
            const id = this.addIKChain(skeletonId, jointIndex, len);
            chain = skel.data.ikChains?.find(c => c.id === id) ?? null;
            if (!chain) return null;
        }
        if (chain.chainLength !== len) this.setIKChainLength(skeletonId, chain.id, len);
        if (chain.enabled !== !!opts.enabled) this.setIKChainEnabled(skeletonId, chain.id, !!opts.enabled);
        if (opts.poleJointIndex === null) {
            delete chain.poleJointIdx;
            if (chain.poleTarget) this.clearPoleTarget(skeletonId, chain.id);
        } else if (typeof opts.poleJointIndex === 'number') {
            const pj = joints[opts.poleJointIndex];
            if (pj && opts.poleJointIndex !== jointIndex) {
                chain.poleJointIdx = opts.poleJointIndex;
                this.setPoleTarget(skeletonId, chain.id, pj.worldMatrix[12], pj.worldMatrix[13], pj.worldMatrix[14]);
            }
        }
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return chain.id;
    }

    /** The IK chain ending at `jointIndex` (setArmatureIK3D's settings + its id / target / pole target), or null. */
    getArmatureIK(skeletonId: string, jointIndex: number): {
        chainId: string; chainLength: number; poleJointIndex: number | null; enabled: boolean;
        target: [number, number, number]; poleTarget: [number, number, number] | null;
    } | null {
        const skel = this.getSkeleton(skeletonId);
        const c = skel?.data.ikChains?.find(ch => ch.endJointIdx === jointIndex);
        if (!skel || !c) return null;
        const pj = typeof c.poleJointIdx === 'number' && c.poleJointIdx < skel.data.joints.length ? c.poleJointIdx : null;
        return {
            chainId: c.id, chainLength: c.chainLength, poleJointIndex: pj, enabled: c.enabled,
            target: [...c.target] as [number, number, number], poleTarget: c.poleTarget ? [...c.poleTarget] as [number, number, number] : null,
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
            this.renderer3D.setGizmoRenderer(undefined);
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
        this.ctx.interactionService.suppressBoxSelect = false;   // the normal (skeletonId===null) teardown clears this; the forced path must too, or box-select/delete/group stay disabled
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
        if (this._armAbort()) return;   // Esc during a joint / handle drag (or a press about to become one)
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

    // ── Skeleton authoring — creation (moved from the manager so the whole bone-authoring
    //    boundary lives here; the manager keeps one-line delegators) ─────────────────────────

    /** Create an empty Skeleton3D with no joints and add it to the scene root. Returns the skeleton ID. */
    createEmptySkeleton3D(name = 'Skeleton'): string {
        const skel = new Skeleton3D({ name, joints: [], clips: [] });
        skel.name = name;
        this.ctx.sceneGraph.root.addChild(skel);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return skel.id;
    }

    /** Append a joint to a skeleton. Returns the new joint index. */
    addBone3D(skeletonId: string, parentIndex: number, localPos: [number, number, number], name?: string): number {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return -1;
        const idx = skel.addJoint(parentIndex, localPos, name);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return idx;
    }

    /**
     * Auto-bind a Mesh3D to a Skeleton3D using inverse-distance² heat diffusion.
     * Upgrades the mesh in-place to a SkinnedMesh3D; computes inverseBindMatrices
     * from joint world positions at the moment of binding.
     * Returns false if the mesh or skeleton is not found.
     */
    bindMeshToSkeleton3D(meshId: string, skeletonId: string): boolean {
        const mesh = this.getMesh(meshId);
        const skel = this.getSkeleton(skeletonId);
        if (!mesh || !skel) return false;

        const { joints } = skel.data;
        if (joints.length === 0) return false;
        const geom = mesh.geometry;
        if (!geom) return false;

        const stride = FLOATS_PER_VERT;
        const vertCount = geom.vertices.length / stride;
        const worldMat = mesh.localMatrix as unknown as Float32Array;

        const jointIndices = new Uint8Array(vertCount * 4);
        const jointWeights = new Float32Array(vertCount * 4);

        // Bind at the REST pose. The mesh geometry is authored in the rest pose, so both the
        // auto-weights (vertex→nearest-joint distance) AND the inverse-bind matrices must be
        // computed against rest-pose joint positions. Binding while the skeleton is POSED corrupts
        // both: weights match the posed joints, and inverse-bind makes the posed pose the new
        // "rest" → the mesh snaps to its rest (T-pose) geometry. So snapshot the current pose,
        // reset joints to identity, bind, then restore the pose.
        const savedRot = joints.map(j => [...j.localRotation] as [number, number, number, number]);
        for (const j of joints) j.localRotation = [0, 0, 0, 1];
        skel.computeWorldMatrices();

        for (let vi = 0; vi < vertCount; vi++) {
            const off = vi * stride;
            const vx = geom.vertices[off], vy = geom.vertices[off + 1], vz = geom.vertices[off + 2];
            // Transform to world space
            const wx = worldMat[0]*vx + worldMat[4]*vy + worldMat[8]*vz + worldMat[12];
            const wy = worldMat[1]*vx + worldMat[5]*vy + worldMat[9]*vz + worldMat[13];
            const wz = worldMat[2]*vx + worldMat[6]*vy + worldMat[10]*vz + worldMat[14];

            // Compute distances to each joint world position (translation column)
            const dists: { ji: number; w: number }[] = joints.map((j, ji) => {
                const jx = j.worldMatrix[12], jy = j.worldMatrix[13], jz = j.worldMatrix[14];
                const d = Math.max(Math.sqrt((wx-jx)**2 + (wy-jy)**2 + (wz-jz)**2), 0.001);
                return { ji, w: 1 / (d * d) };
            });
            dists.sort((a, b) => b.w - a.w);

            const top4 = dists.slice(0, 4);
            const totalW = top4.reduce((s, x) => s + x.w, 0);
            for (let k = 0; k < 4; k++) {
                const slot = vi * 4 + k;
                if (k < top4.length) {
                    jointIndices[slot] = top4[k].ji;
                    jointWeights[slot] = top4[k].w / totalW;
                }
            }
        }

        // Compute inverse bind matrices from current joint world matrices, then
        // recompute world matrices so skinMatrices = worldMatrix × inverseBindMatrix
        // is correct for the first render frame.  Without this second call,
        // skinMatrices still contain worldMatrix × zeros (the default inverse bind)
        // and the GPU shader collapses all vertices to the origin.
        skel.computeInverseBindMatrices();
        // Restore the user's pose (bound at rest; now re-applied so the mesh deforms to it
        // instead of snapping back to the rest/T-pose).
        for (let i = 0; i < joints.length; i++) joints[i].localRotation = savedRot[i];
        skel.computeWorldMatrices();

        // Upgrade Mesh3D → SkinnedMesh3D in the scene graph
        const parent = mesh.parent ?? this.ctx.sceneGraph.root;
        // Deep-copy the material so nested RGBA objects are independent references.
        const mat = mesh.material;
        const skinnedMesh = new SkinnedMesh3D(this.ctx.interactionService, mesh.x, mesh.y, mesh.z, {
            primitive: mesh.meshPrimitive,
            geometry: geom,
            material: {
                ...mat,
                diffuse:  { ...mat.diffuse },
                specular: { ...mat.specular },
                emissive: { ...mat.emissive },
            },
        });
        // Copy transform and display properties
        skinnedMesh.setId(mesh.id);
        skinnedMesh.name = mesh.name;
        skinnedMesh.visible = mesh.visible;
        skinnedMesh.editMesh = mesh.editMesh;
        skinnedMesh.vertexColors = mesh.vertexColors;
        skinnedMesh.setScale3D(mesh.scaleX, mesh.scaleY, mesh.scaleZ);
        skinnedMesh.setRotation3D(mesh.rotationX, mesh.rotationY, mesh.rotation);

        skinnedMesh.skeletonId = skel.id;
        skinnedMesh.skeleton = skel;
        skinnedMesh.jointIndices = jointIndices;
        skinnedMesh.jointWeights = jointWeights;
        skinnedMesh.skinDirty = true;
        skel.matricesDirty = true;

        // The bound mesh now DRIVES its skeleton: its object transform lives on the skeleton (like a procedural
        // body) so moving / scaling / fitToFrame-ing the mesh moves the RIG with it. Without this the renderer
        // applies the mesh's model matrix to the deformed body (inst.modelMatrix) while the bones stay at their
        // authored positions — the body slides off its skeleton (the metaball-creature "rig detached" bug).
        // objectTransform is seeded from the current transform; _syncCharacterSkeletons keeps it in step after.
        skinnedMesh.transformViaSkeleton = true;
        skel.objectTransform.set(skinnedMesh.localMatrix as unknown as Float32Array);
        skel.computeWorldMatrices();

        parent.removeChild(mesh);
        this.ctx.sceneGraph.unregisterNode(mesh);
        parent.addChild(skinnedMesh);
        this.ctx.sceneGraph.registerNode(skinnedMesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return true;
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
