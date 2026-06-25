/**
 * Scene3DManager — Delegate for 3D scene operations.
 *
 * Handles:
 *  - Camera creation and control
 *  - Orbit controller attach/detach
 *  - Mesh creation (box, sphere, plane, cylinder, torus, custom)
 *  - Mesh property manipulation (position, rotation, scale, material)
 *  - PS1 aesthetic configuration
 *  - Lighting (directional + ambient)
 *
 * Frogmarks can access this via `shapeManager.scene3d`.
 */

import type { ManagerContext } from './manager-context';
import { mat4, vec4, vec3, mat3, quat } from 'gl-matrix';
import { Camera3D, Camera3DConfig } from '../../renderer/3d/camera-3d';
import { OrbitController, OrbitControllerConfig } from '../../renderer/3d/orbit-controller';
import { ViewGizmo } from '../../renderer/3d/view-gizmo';
import { Renderer3D, PS1Config, DEFAULT_PS1_CONFIG, WOBBLE_PRESET, POCKET_PRESET, FogConfig, DEFAULT_FOG_CONFIG, PostProcessConfig } from '../../renderer/3d/renderer-3d';
import { Material3D } from '../../renderer/3d/material-3d';
import { MeshGeometry, generateRibbon, FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import { Mesh3D, Mesh3DConfig, MeshPrimitive, Submesh3D } from '../../scene-graph/shapes/mesh-3d';
import { RasterTextureManager } from '../../renderer/raster/raster-texture-manager';
import { EyeParams, renderEyes, defaultEyeParams } from './eye-generator';
import { HairParams, generateHair, DEFAULT_HAIR_PARAMS, HeadFrame, TAIL_BONES } from './hair-generator';
import {
    ClothingParams, TopParams, BodyFit, JointFit, ArmFit, generateTop, generateBottom, defaultTopParams, defaultBottomParams,
    clothingPresetNames, clothingPreset, normSleeveLength, RING as GARMENT_RING,
} from './clothing-generator';
import { generateBodyResult, type ArmSurface } from './body-generator';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import { ArrayGroup3D, ArrayParams, LinearArrayParams, GridArrayParams, RadialArrayParams, computeArrayOffsets, getArrayInstanceCount, LocalBasis3, InstanceOverride } from '../../scene-graph/shapes/array-group-3d';
import { GizmoRenderer, GizmoMode, GizmoAxis, ArrayGizmoData, ArrayHandleHit, IKHandleHit } from '../../renderer/3d/gizmo-renderer';
import { MeshEditOverlayRenderer, type MeshEditDrawData } from '../../renderer/3d/mesh-edit-overlay-renderer';
import { WeightPaintVertexOverlayRenderer } from '../../renderer/3d/weight-paint-overlay-renderer';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { TransformController3D, type SnapMode, type SnapVizData } from './transform-controller-3d';
import { TextureLibrary } from '../texture-library';
import {
  Mesh3DKeyframeTracks, TrackName, KeyframeEasing, Keyframe,
  Camera3DKeyframeTracks, CameraTrackName,
  sampleTrack, setKeyframe, removeKeyframe,
  interpolateVec3, interpolateVec4, interpolateScalar,
  FrameLinkAnimation3D, DEFAULT_FRAME_LINK_ANIMATION_3D, evalFrameLink3D,
} from '../../types/keyframe-3d';
import { AnimationPlayer3D, AnimationPlayer3DConfig } from '../../renderer/3d/animation-player-3d';
import { UndoManager3D } from './undo-manager-3d';
import { parseOBJ } from '../../renderer/3d/obj-importer';
import { parseGLB, parseGLTF, GltfMeshResult, parseSkinnedGLB, parseSkinnedGLTF } from '../../renderer/3d/gltf-importer';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { SkinnedMesh3D, fromBase64ToUint8, fromBase64ToFloat32 } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { Joint3D, SkeletonData, SkeletonAnimClip, ArmatureBgOptions, IKChain, IKKeyframeTrack, NLATrack, NLAClipSegment, SpringCollider, SpringChain } from '../../types/armature-3d';
import { solveAllIKChains, clearAllIKRotations } from '../../renderer/3d/ik-solver';
import { solveAllConstraints, clearAllConstraintState } from '../../renderer/3d/constraint-solver';
import { solveSpringBones, resetSpringState } from '../../renderer/3d/spring-bone-solver';
import { applySkeletonClipAtFrame, evaluateNLAAtFrame, snapshotSkeletonPose, type SkeletonPose } from '../../renderer/3d/skeleton-animator';
import { exportSceneToGlb, type GltfExportResult } from '../../renderer/3d/gltf-exporter';
import { RenderStyle } from '../../renderer/3d/material-3d';
import { HtmlTexture3D, HtmlTexture3DOptions } from '../../renderer/3d/html-texture-3d';
import { RibbonData, RibbonControlPoint, RibbonPathMode } from '../../types/ribbon-3d';
import { ClothMesh3D, ClothGridConfig, ClothPhysicsConfig, ClothSimState, ClothLiveConfig, DEFAULT_CLOTH_PHYSICS, DEFAULT_CLOTH_LIVE, StitchConstraint, WindZone } from '../../scene-graph/shapes/cloth-mesh-3d';
import { buildClothGeometry, ClothGeometryResult, buildDefaultActiveCells } from '../../renderer/3d/cloth-geometry-builder';
import { ClothSimulator, DrapeProxy } from '../../renderer/3d/cloth-simulator';
import { solidifyCloth } from '../../renderer/3d/cloth-solidifier';
import { createLiveClothSimulation, LiveClothHandle } from '../../renderer/3d/live-cloth-simulation';
import { ClothPreviewRenderer, ClothPreviewOptions } from '../../renderer/3d/cloth-preview-renderer';
import { ParticleEmitter3D, ParticleEmitterConfig, ParticlePreset } from '../../scene-graph/shapes/particle-emitter-3d';
import { KitbashLibrary } from './kitbash-library';
import type { CharacterSlot, CharacterDefinition, CharacterData, KitbashPartMeta } from '../../types/kitbash-3d';
import { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';
import type { GpPoint, GpStroke3D } from '../../types/grease-pencil-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { Modifier } from '../../scene-graph/shapes/modifiers';
import { ArrayToolController, ArrayToolMode } from './array-tool-controller';
export type { DrapeProxy, LiveClothHandle };
export type { ArrayToolMode };
export type { CharacterSlot, CharacterDefinition, CharacterData, KitbashPartMeta };
export type { GpPoint, GpStroke3D };

/** Serializable snapshot of all global 3D scene settings (not per-mesh state). */
export interface GlobalScene3DSettings {
    projection:    'perspective' | 'orthographic';
    ps1:           PS1Config;
    lighting: {
        directional: { direction: [number, number, number]; color: [number, number, number]; intensity: number };
        ambient:     { color: [number, number, number]; intensity: number };
    };
    bg:            ArmatureBgOptions;
    fog:           FogConfig;
    /** IBL image data is not serialized; only intensity/enabled flag are preserved. */
    ibl:           { enabled: boolean; intensity: number };
    textureFilter: 'nearest' | 'linear';
    postProcess:   PostProcessConfig;
    shadows:       { enabled: boolean; mapSize: number; halfExtent: number; bias: number };
    snap:          SnapMode;
    /** Snap increments (optional for back-compat): grid cell size (world units, also the visible grid
     *  spacing), rotate step (radians), scale step (factor). */
    snapGridSize?:  number;
    snapRotateStep?: number;
    snapScaleStep?:  number;
    /** Visible ground grid — per-illustration (a character sheet wants one, a painted bg may not). */
    grid:          { visible: boolean; color: [number, number, number]; opacity: number };
}

// ── Anime face / eye expression system ──────────────────────────────────────────
/** One facial expression state — a single drawn eye image backed by its own paintable texture. */
export interface FaceExpression {
    id: string;
    name: string;
    /** A blink state — shown briefly at the blink interval, then reverts to the active expression. */
    isBlink: boolean;
    /** Present when the eyes were generated procedurally (not freehand-drawn); kept so the UI can
     *  re-edit them via sliders. The baked texture still persists as a PNG either way. */
    eyeParams?: EyeParams;
}
/** How often the character blinks. */
export interface FaceBlinkConfig {
    mode: 'fixed' | 'random';
    /** fixed: seconds between blinks; random: minimum seconds. */
    minSec: number;
    /** random: maximum seconds (ignored when mode==='fixed'). */
    maxSec: number;
    /** How long a blink is held, in milliseconds. */
    holdMs: number;
}
/** Serializable face-rig state (no GPU/texture refs — textures persist separately as PNGs). */
export interface FaceRigState {
    bodyMeshId: string;
    skeletonId: string;
    headJointIdx: number;
    decalMeshId: string;
    expressions: FaceExpression[];
    activeId: string | null;
    blinkId: string | null;
    blink: FaceBlinkConfig;
}
interface FaceRig extends FaceRigState {
    /** expressionId → paintable+sampleable texture (the drawn eyes). */
    textures: Map<string, RasterTextureManager>;
    /** Decal width/height (world) — used to pre-squish procedural eyes so circles stay round on the
     *  wide-but-short face plane. Derived from the head; not persisted (recomputed on load). */
    faceAspect: number;
    _blinkTimer: ReturnType<typeof setTimeout> | null;
    _holdTimer:  ReturnType<typeof setTimeout> | null;
}
const DEFAULT_BLINK: FaceBlinkConfig = { mode: 'random', minSec: 2.5, maxSec: 6.0, holdMs: 110 };

/** Procedural hair on a body: the params + the generated mesh + its gradient texture. */
interface HairRig {
    bodyMeshId: string;
    hairMeshId: string;
    params: HairParams;
    gradient: RasterTextureManager;   // root→tip gradient, sampled by the hair's uv.v
}

/** A procedural garment on a body (one per slot): params + the generated mesh + optional gradient. */
interface ClothingRig {
    bodyMeshId: string;
    slot: 'top' | 'bottom';
    clothingMeshId: string;
    params: ClothingParams;
    gradient?: RasterTextureManager;   // base→trim gradient (when params.gradient)
}

const _nanoid = () => Math.random().toString(36).slice(2, 10);

/** '#rrggbb' / '#rgb' → {r,g,b} in 0..1. */
const hexToRgb01 = (hex: string): { r: number; g: number; b: number } => {
    let h = (hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};

const rgb01ToHex = (r: number, g: number, b: number): string => {
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
};

const nearestPow2 = (n: number): number => {
    if (!isFinite(n) || n <= 0) return 1;
    return Math.pow(2, Math.round(Math.log2(n)));
};

/**
 * Decompose a column-major 4×4 matrix (gl-matrix format) into position, YXZ Euler
 * angles (radians), and uniform scale components.
 * Matches the rotation order used by shape.updateLocalMatrix(): Y → X → Z.
 */
function decomposeMatrix4(m: Float32Array): {
    x: number; y: number; z: number;
    rotX: number; rotY: number; rotZ: number;
    scaleX: number; scaleY: number; scaleZ: number;
} {
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    // Normalized rotation elements (col-major: element at row r, col c → index c*4+r)
    // col2 normalized: [m8/sz, m9/sz, m10/sz] = [sin(ry)*cx, -sx, cy*cx]
    const r12 = m[9]  / (sz || 1);   // -sin(rotX)
    const r02 = m[8]  / (sz || 1);   // sin(rotY)*cos(rotX)
    const r22 = m[10] / (sz || 1);   // cos(rotY)*cos(rotX)
    const r10 = m[1]  / (sx || 1);   // cos(rotX)*sin(rotZ)
    const r11 = m[5]  / (sy || 1);   // cos(rotX)*cos(rotZ)
    const rotX = Math.asin(Math.max(-1, Math.min(1, -r12)));
    const cx = Math.cos(rotX);
    const rotY = cx > 1e-6 ? Math.atan2(r02, r22) : 0;
    const rotZ = cx > 1e-6 ? Math.atan2(r10, r11) : Math.atan2(-m[4] / (sy || 1), m[0] / (sx || 1));
    return { x: m[12], y: m[13], z: m[14], rotX, rotY, rotZ, scaleX: sx, scaleY: sy, scaleZ: sz };
}

export interface Scene3DHierarchyNode {
    id: string;
    name: string;
    type: '3DMesh' | '3DMeshGroup' | '3DArrayGroup';
    visible: boolean;
    locked: boolean;
    collapsed?: boolean;
    children?: Scene3DHierarchyNode[];
    /** Only present on `3DArrayGroup` nodes. Total number of GPU instances (source not counted). */
    instanceCount?: number;
}

export class Scene3DManager {
    private ctx: ManagerContext;
    private _orbitController?: OrbitController;
    private _viewGizmo?: ViewGizmo;
    private _viewGizmoFrameCb?: () => boolean;
    private _orbitUpdateCallback?: () => boolean;

    // Picking + gizmo
    private _picker = new MeshPicker();
    private _gizmoRenderer?: GizmoRenderer;
    private _meshEditOverlay?: MeshEditOverlayRenderer;
    private _transformController?: TransformController3D;
    private _isMeshEditModeFn?: () => boolean;
    private _meshEditDataFn?: () => MeshEditDrawData | null;

    // Bone overlay state
    private _boneOverlaySkeletonId: string | null = null;
    private _selectedJointIndex: number | null = null;
    private _hoveredJointIndex: number | null = null;
    private _jointMouseDownCleanup?: () => void;
    // True when showBoneOverlay3D was called explicitly by the Armature panel.
    // _syncBoneOverlay (triggered by mesh selection changes) must not clear an
    // explicitly-pinned overlay — the panel owns it until showBoneOverlay3D(null).
    private _boneOverlayExplicit = false;
    // Fixed orbit center for armature mode — target stays here so orbit always
    // rotates around the mesh center regardless of accumulated pan.
    private _armatureOrbitCenter: [number, number, number] | null = null;
    // Screen-space pan accumulator in orthographic world units.
    // Added to cam.orthoOffsetX/Y each frame; stays constant during orbit so the
    // mesh remains at the same screen position while the camera rotates around it.
    private _armatureOrthoX = 0;
    private _armatureOrthoY = 0;
    // Last known illustration camera center (cx/cy) for delta-tracking.
    // When illustration pan changes, the delta is folded into _armatureOrthoX/Y.
    // Scaled by zoomScale on zoom changes to avoid double-counting.
    private _armatureIllustrationCx = 0;
    private _armatureIllustrationCy = 0;
    // Fixed orbit center for mesh edit mode — same orbit-center-lock mechanism as armature.
    private _meshEditOrbitCenter: [number, number, number] | null = null;
    private _meshEditOrthoX = 0;
    private _meshEditOrthoY = 0;
    private _meshEditIllustrationCx = 0;
    private _meshEditIllustrationCy = 0;
    // Joint drag state (drag-to-move)
    private _isDraggingJoint = false;
    private _dragJointIdx: number | null = null;
    private _dragPlanePoint = vec3.create();  // joint world pos at drag start
    private _dragPlaneNormal = vec3.create(); // camera forward at drag start
    // Tail handle drag state
    private _isDraggingTail = false;
    private _dragTailJointIdx: number | null = null;
    private _hoveredTailJointIndex: number | null = null;
    // Bone placement mode — when active, the next viewport click places a joint
    // at the ray-scene (or ray-ground) intersection instead of selecting/dragging.
    private _bonePlacementMode = false;
    private _bonePlacementSkeletonId: string | null = null;
    // Two-click root bone placement: null = head phase, non-null = tail phase (index of the pending joint).
    private _bonePlacementPendingIdx: number | null = null;
    // True when the last joint selection was via a tail sphere (vs head sphere).
    // Controls Add Bone: tail-selected → extend from tail; head-selected → branch from this joint.
    private _selectedJointIsTail = false;

    // Mesh rotation zeroed on armature entry for a clean front-facing workspace; restored on exit.
    private _armatureSavedMeshRotation: {
        meshId: string;
        rx: number; ry: number; rz: number;
    } | null = null;

    // Mesh isolation (armature / weight-paint mode: all other meshes hidden)
    private _isolatedMeshId: string | null = null;
    private _savedMeshVisibility = new Map<string, boolean>();

    // Armature tool mode — 'move' repositions joints, 'rotate' applies FK rotation
    private _armatureToolMode: 'move' | 'rotate' = 'move';

    // Joint gizmo axis-drag state (move tool)
    private _jointGizmoHoveredAxis: GizmoAxis = null;
    private _isDraggingJointAxis = false;
    private _dragJointAxisAxis: GizmoAxis = null;
    private _dragJointAxisStartPt: vec3 = vec3.create();
    private _dragJointAxisJointStart: vec3 = vec3.create();

    // FK rotate drag state (rotate tool)
    private _isRotatingJoint = false;
    private _rotatingJointIdx: number | null = null;
    private _rotatingJointAxis: 'x' | 'y' | 'z' | null = null;
    private _rotatingJointInitialQuat: [number, number, number, number] = [0, 0, 0, 1];
    private _rotatingJointAccAngle = 0; // accumulated angle in radians from drag start
    private _rotatingLastClientX = 0;
    private _rotatingLastClientY = 0;

    // IK drag state
    private _hoveredIKHandle: IKHandleHit | null = null;
    private _draggingIKHandle: IKHandleHit | null = null;
    private _ikDragPlaneNormal: vec3 = vec3.create();
    private _ikDragPlanePoint: vec3 = vec3.create();
    private _ikSolveCallback: (() => boolean) | null = null;
    private _springSolveCallback: (() => boolean) | null = null;
    private _springLastTime = 0;   // performance.now() of the last spring solve (0 = idle / fresh start)

    // Weight paint state
    private _weightPaintMeshId: string | null = null;
    private _weightPaintJointIndex: number | null = null;
    private _weightPaintSavedColors: Float32Array | null = null;
    private _weightPaintListenerCleanup?: () => void;
    private _wpBrushRadius = 0.3;
    private _wpBrushStrength = 0.2;
    private _wpTargetWeight = 1.0;
    private _wpPointerDown = false;
    private _wpBrushCircle: HTMLDivElement | null = null;
    private _wpBrushCenter: [number, number, number] | null = null;

    // GP draw mode state
    private _gpDrawActive = false;
    private _gpDrawGpId: string | null = null;
    private _gpDrawLayerId: string | null = null;
    private _gpDrawPointerDown = false;
    private _gpDrawListenerCleanup?: () => void;
    private _gpDrawColor: { r: number; g: number; b: number; a: number } = { r: 0, g: 0, b: 0, a: 1 };
    private _gpDrawBaseWidth = 0.02;
    private _gpDrawFillColor: { r: number; g: number; b: number; a: number } | null = null;
    private _gpDrawParentJoint: string | null = null;
    private _gpDrawClosed = false;
    private _gpDrawMode: 'draw' | 'erase' = 'draw';
    private _gpDrawEraseRadius = 0.1;
    private _gpDrawDepth = 0.5;
    private _gpDrawDepthMode: 'surface' | 'fixed' = 'surface';
    private _gpDrawLastDepth = 0.5;
    private _gpDrawSavedGizmoMode: GizmoMode | undefined;

    // GP drawing plane (face-select mode)
    private _gpDrawPlane: {
        point:         [number, number, number]; // face centroid + offset * normal
        normal:        [number, number, number]; // world-space face normal (unit)
        faceCenter:    [number, number, number]; // raw face centroid (no offset)
        faceRadius:    number;                   // max dist from centroid to any vertex
        meshId:        string;
        triangleIndex: number;
        offset:        number;
    } | null = null;
    private _gpHoveredFace: { meshId: string; triangleIndex: number } | null = null;
    private _gpFaceSelectActive = false;
    private _gpFaceSelectCleanup?: () => void;

    // 3D surface painting — paint directly on a mesh in the viewport; the host
    // raycasts the hit to a UV coord and forwards begin/move/end to a handler
    // (the UVPaintController) so the same texture is painted as the UV pane.
    private _surfacePaintMeshId: string | null = null;
    private _surfacePaintHandlers?: { begin: (u: number, v: number, p: number) => void; move: (u: number, v: number, p: number) => void; end: () => void; hover?: (uv: [number, number] | null) => void };
    private _surfacePaintCleanup?: () => void;
    private _surfacePaintDrawing = false;

    // Texture library (lazy-init)
    private _textureLibrary?: TextureLibrary;

    // Keyframe animation: frame-change listener unsubscribe
    private _keyframeUnsub?: () => void;

    // Animation player (optional, frame-clock driven)
    private _animPlayer?: AnimationPlayer3D;

    // NLA (Non-Linear Animation) state — keyed by track ID
    private _nlaTracks     = new Map<string, NLATrack>();
    private _nlaPlayers    = new Map<string, AnimationPlayer3D>();
    private _nlaBindPoses  = new Map<string, SkeletonPose>();  // keyed by skeletonId

    // Camera keyframe tracks (position, target, fov)
    private _cameraKeyframeTracks: Camera3DKeyframeTracks = {};

    // Undo/redo for 3D scene edits
    private _undoManager = new UndoManager3D();

    // Array Tool (Phase 4) — hover-handles + ghost preview
    private _arrayTool: ArrayToolController | null = null;
    private _arrayToolPreRenderCb: (() => boolean) | null = null;

    // Tracks which ArrayGroup3D was last selected directly (e.g. via instance picking)
    private _selectedGroupId: string | null = null;
    private _arrayGroupSyncCb: (() => boolean) | null = null;

    // Auto-sync illustration camera to pan/zoom each frame
    private _autoSyncCallback?: () => boolean;

    // Per-mesh procedural frame-link animations (keyed by mesh ID)
    private _frameLinkAnims3D = new Map<string, FrameLinkAnimation3D>();

    // Rest-pose snapshot captured at first FLA application (oscillating types only).
    // Cleared whenever FLA is set or removed so the next frame re-captures the current pose.
    private _flaRestTransforms = new Map<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();

    // Ribbon mesh data (keyed by mesh ID)
    private _ribbonData = new Map<string, RibbonData>();

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
        /** Cloth positions captured at beginClothStitchTool() — used as the baseline for each preview reset so every hover starts from the same pose. */
        savedPositions: Float32Array | null;
    }>();
    // Debounce timers for setClothConfigDebounced (keyed by mesh ID)
    private _clothConfigTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; grid: Partial<ClothGridConfig>; physics: Partial<ClothPhysicsConfig> }>();

    // HTML-in-Canvas GPU textures (keyed by mesh ID)
    private _htmlTextures = new Map<string, HtmlTexture3D>();

    // Particle emitters (keyed by emitter ID)
    private _particleEmitters = new Map<string, ParticleEmitter3D>();
    private _particleTickCb: (() => boolean) | null = null;

    // Per-frame ribbon update callback (scroll animation + camera-facing geometry)
    private _scrollRealFrames = new Map<string, number>();
    private _ribbonUpdateCb: (() => boolean) | null = null;

    // Ribbon control-point drag depths: key = `${ribbonId}:${handleIndex}`
    private _ribbonHandleDragDepth = new Map<string, number>();

    // Kitbash part catalog
    private readonly _kitbashLibrary = new KitbashLibrary();
    // Assembled characters: charId → CharacterData
    private _characterMap = new Map<string, CharacterData>();

    // Grease Pencil objects
    private _gpObjects = new Map<string, GpObject3D>();
    // Active stroke being drawn: {gpId, layerId, strokeId}
    private _gpActiveStroke: { gpId: string; layerId: string; strokeId: string } | null = null;

    constructor(ctx: ManagerContext) {
        this.ctx = ctx;
        // Sync each procedural character's skeleton object-transform from its body mesh's transform
        // every frame, so the gizmo (which moves the body mesh) carries the skeleton + bones with it.
        this.ctx.webgpuRenderer.addPreRenderCallback(() => this._syncCharacterSkeletons());
    }

    /** body meshId → last localMatrixVersion synced to its skeleton.objectTransform (cheap change check). */
    private _charSkelSyncVer = new Map<string, number>();
    /** Mirror each procedural body's transform onto its skeleton's objectTransform (matrix copy) so the
     *  skeleton + bones follow the character gizmo. Re-FKs only when the body's transform changed. */
    private _syncCharacterSkeletons(): boolean {
        let changed = false;
        for (const m of this.getAllMeshes()) {
            if (!(m instanceof SkinnedMesh3D) || !m.isProceduralBody || !m.skeleton) continue;
            const ver = m.localMatrixVersion;
            if (this._charSkelSyncVer.get(m.id) === ver) continue;
            this._charSkelSyncVer.set(m.id, ver);
            (m.skeleton.objectTransform).set(m.localMatrix as unknown as Float32Array);
            m.skeleton.computeWorldMatrices();   // re-FK with the new object transform → skinning + bones follow
            changed = true;
        }
        if (changed) this.ctx.scheduleRender();
        return false;   // keep running every frame
    }

    private get renderer3D(): Renderer3D { return this.ctx.webgpuRenderer.getRenderer3D(); }

    // ── Undo / Redo ──────────────────────────────────────────────────

    get canUndo3D(): boolean { return this._undoManager.canUndo; }
    get canRedo3D(): boolean { return this._undoManager.canRedo; }
    get undoDescription3D(): string | null { return this._undoManager.undoDescription; }
    get redoDescription3D(): string | null { return this._undoManager.redoDescription; }

    undo3D(): boolean {
        const ok = this._undoManager.undo();
        if (ok) this.ctx.scheduleRender();
        return ok;
    }

    redo3D(): boolean {
        const ok = this._undoManager.redo();
        if (ok) this.ctx.scheduleRender();
        return ok;
    }

    clearUndo3D(): void { this._undoManager.clear(); }
    pushCommand3D(cmd: import('./undo-manager-3d').Command3D): void { this._undoManager.push(cmd); }

    // ── Shadow mapping ───────────────────────────────────────────────

    enableShadows(mapSize = 1024, halfExtent = 15, bias = 0.002): void {
        this.renderer3D.enableShadows(mapSize, halfExtent, bias);
        this.ctx.scheduleRender();
    }

    disableShadows(): void {
        this.renderer3D.disableShadows();
        this.ctx.scheduleRender();
    }

    get shadowsEnabled(): boolean { return this.renderer3D.shadowsEnabled; }

    // ── Frustum culling ──────────────────────────────────────────────

    get frustumCulling(): boolean { return this.renderer3D.frustumCulling; }
    set frustumCulling(v: boolean) { this.renderer3D.frustumCulling = v; }

    // ── Synced 3D + raster playback ──────────────────────────────────

    /**
     * Start the 3D AnimationPlayer in sync with raster playback.
     * Called automatically when `animation.play()` fires.
     */
    startSyncedPlayback(): void {
        this._animPlayer?.play();
    }

    pauseSyncedPlayback(): void {
        this._animPlayer?.pause();
    }

    stopSyncedPlayback(): void {
        this._animPlayer?.stop();
    }

    // ── Camera ───────────────────────────────────────────────────────

    getCamera(): Camera3D { return this.renderer3D.getCamera(); }

    createCamera(config?: Camera3DConfig): Camera3D {
        const cam = new Camera3D(config);
        this.renderer3D.setCamera(cam);
        this.ctx.scheduleRender();
        return cam;
    }

    /** Reset camera to default position looking at origin. */
    resetCamera(): void {
        const cam = this.renderer3D.getCamera();
        cam.lookAt(0, 2, 5, 0, 0, 0);
        this.ctx.scheduleRender();
    }

    /** Switch between perspective and orthographic projection. */
    setCameraMode(mode: 'perspective' | 'orthographic'): void {
        this.renderer3D.getCamera().mode = mode;
        this.ctx.scheduleRender();
    }

    /** Set the camera field of view (degrees). */
    setFOV(fovDeg: number): void {
        this.renderer3D.getCamera().fov = fovDeg * Math.PI / 180;
        this.ctx.scheduleRender();
    }

    // ── 3D Illustration mode ─────────────────────────────────────────

    /** Last params passed to syncIllustrationCamera — used to re-sync on projection toggle. */
    private _illustrationSync: { panX: number; panY: number; zoom: number; canvasW: number; canvasH: number } | null = null;
    /** Stored projection preference — survives repeated syncIllustrationCamera calls. */
    private _illustrationProjection: 'perspective' | 'orthographic' = 'orthographic';

    /**
     * Sync the 3D camera to the 2D viewport (pan/zoom) for 3D Illustration mode.
     * Call this whenever panOffset or zoomFactor changes. Safe to call every frame.
     *
     * Coordinate convention: 2D uses Y-down (origin top-left), 3D uses Y-up.
     * The camera is placed so that a 3D mesh at (x, -y, 0) aligns with the 2D
     * world point (x, y) — users should negate Y when positioning 3D objects to
     * match 2D canvas coordinates.
     */
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

    /**
     * Switch the 3D Illustration camera between perspective and orthographic.
     * Stores the preference so subsequent syncIllustrationCamera calls don't override it.
     * Immediately re-syncs the camera using the last syncIllustrationCamera params.
     */
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
            cam.far = 100;
            cam.lookAt(cx, cy, 10, cx, cy, 0);
        } else {
            const d = orthoSize / Math.tan(cam.fov / 2);
            cam.near = Math.max(0.0001, d * 0.0001);
            cam.far = Math.max(d * 2, 100);
            cam.lookAt(cx, cy, d, cx, cy, 0);
        }

        this.ctx.scheduleRender();
    }

    /**
     * Subscribe to the render loop so the illustration camera automatically tracks
     * the current pan/zoom on every frame.  Call once on document load and the
     * camera will always be in sync — no need to call syncIllustrationCamera manually.
     *
     * Safe to call multiple times (duplicate calls are no-ops).
     */
    enableAutoSyncIllustrationCamera(): void {
        if (this._autoSyncCallback) return;
        const iService = this.ctx.interactionService;
        const renderer = this.ctx.webgpuRenderer;
        this._autoSyncCallback = () => {
            const canvas = renderer.getCanvas();
            const pan = iService.getPanOffset();
            const zoom = iService.getZoomFactor();
            this.syncIllustrationCamera(pan.x, pan.y, zoom, canvas.width, canvas.height);
            return false; // keep running every frame
        };
        renderer.addPreRenderCallback(this._autoSyncCallback);
        // Fire once immediately so any render already queued before this call
        // (e.g. from document load) gets the correct camera on its first frame.
        this._autoSyncCallback();
    }

    /** Stop automatic camera sync started by enableAutoSyncIllustrationCamera. */
    disableAutoSyncIllustrationCamera(): void {
        if (!this._autoSyncCallback) return;
        this.ctx.webgpuRenderer.removePreRenderCallback(this._autoSyncCallback);
        this._autoSyncCallback = undefined;
    }

    /**
     * Returns the world-space point that the illustration camera is looking at —
     * i.e. the center of the visible canvas area in 3D world coordinates.
     * Use this to place new meshes at the center of the canvas rather than at the
     * world origin (which maps to the top-left corner in illustration mode).
     *
     * Returns null if syncIllustrationCamera has never been called.
     */
    getIllustrationCenter3D(): [number, number, number] | null {
        if (!this._illustrationSync) return null;
        const { panX, panY, zoom, canvasH } = this._illustrationSync;
        // Same formula as _applyIllustrationCamera — the 2D world-space center.
        const cx = -panX / (canvasH * zoom);
        const cy =  panY / (canvasH * zoom);
        return [cx, cy, 0];
    }

    /**
     * Returns the recommended uniform scale for a new mesh in illustration mode.
     * In illustration mode 1 world unit = 1 canvas pixel, so a 1×1×1 mesh is
     * effectively invisible. This returns a scale that makes the mesh appear
     * roughly 10% of the visible canvas height (~100 px at 1080p, zoom 1).
     *
     * Returns 1 if the illustration camera has never been synced (perspective mode default).
     */
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

    /** Frame all meshes in the current camera view. */
    frameAllMeshes(padding = 1.25): boolean {
        const meshes = this.getAllMeshes();
        if (meshes.length === 0) return false;
        return this.frameMeshes(meshes, padding);
    }

    private getMeshCenter(meshId: string | null): [number, number, number] | null {
        if (!meshId) return null;
        const mesh = this.getMesh(meshId);
        if (!mesh) return null;
        const bounds = this.computeWorldBounds([mesh]);
        if (!bounds) return null;
        return [
            (bounds.minX + bounds.maxX) * 0.5,
            (bounds.minY + bounds.maxY) * 0.5,
            (bounds.minZ + bounds.maxZ) * 0.5,
        ];
    }

    /** Frame a single mesh by ID in the current camera view. */
    frameMesh(nodeId: string, padding = 1.25): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        return this.frameMeshes([mesh], padding);
    }

    private frameMeshes(meshes: Mesh3D[], padding: number): boolean {
        const bounds = this.computeWorldBounds(meshes);
        if (!bounds) return false;

        const cam = this.renderer3D.getCamera();
        const cx = (bounds.minX + bounds.maxX) * 0.5;
        const cy = (bounds.minY + bounds.maxY) * 0.5;
        const cz = (bounds.minZ + bounds.maxZ) * 0.5;

        const dx = bounds.maxX - bounds.minX;
        const dy = bounds.maxY - bounds.minY;
        const dz = bounds.maxZ - bounds.minZ;
        const radius = Math.max(0.001, Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5);

        const oldDir = vec3.fromValues(
            cam.position[0] - cam.target[0],
            cam.position[1] - cam.target[1],
            cam.position[2] - cam.target[2],
        );
        if (vec3.length(oldDir) < 0.0001) vec3.set(oldDir, 0, 0.4, 1);
        vec3.normalize(oldDir, oldDir);

        let dist = radius * padding;
        if (cam.mode === 'perspective') {
            dist = Math.max(radius * padding, (radius * padding) / Math.tan(Math.max(0.1, cam.fov) * 0.5));
        } else {
            const halfH = Math.max(dy * 0.5, (dx * 0.5) / Math.max(0.0001, cam.aspect));
            cam.orthoSize = halfH * padding;
            dist = Math.max(radius * 2, 2);
        }

        cam.lookAt(
            cx + oldDir[0] * dist,
            cy + oldDir[1] * dist,
            cz + oldDir[2] * dist,
            cx,
            cy,
            cz,
        );
        // Sync orbit controller spherical state so subsequent orbit/zoom doesn't
        // snap back to the pre-framing camera position.
        this._orbitController?.syncFromCamera();
        this.ctx.scheduleRender();
        return true;
    }

    private computeWorldBounds(meshes: Mesh3D[]): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const mesh of meshes) {
            const m = mesh.localMatrix;
            const v = mesh.geometry?.vertices;

            if (v && v.length >= 3) {
                // Primary path: GPU geometry flat buffer
                for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
                    const p = vec4.fromValues(v[i], v[i + 1], v[i + 2], 1);
                    const wp = vec4.transformMat4(vec4.create(), p, m as mat4);
                    minX = Math.min(minX, wp[0]); minY = Math.min(minY, wp[1]); minZ = Math.min(minZ, wp[2]);
                    maxX = Math.max(maxX, wp[0]); maxY = Math.max(maxY, wp[1]); maxZ = Math.max(maxZ, wp[2]);
                }
            } else if (mesh.editMesh?.vertices?.length) {
                // Fallback: editMesh object vertices (x/y/z properties in local space)
                for (const ev of mesh.editMesh.vertices) {
                    const p = vec4.fromValues(ev.x, ev.y, ev.z, 1);
                    const wp = vec4.transformMat4(vec4.create(), p, m as mat4);
                    minX = Math.min(minX, wp[0]); minY = Math.min(minY, wp[1]); minZ = Math.min(minZ, wp[2]);
                    maxX = Math.max(maxX, wp[0]); maxY = Math.max(maxY, wp[1]); maxZ = Math.max(maxZ, wp[2]);
                }
            }
        }

        if (!isFinite(minX) || !isFinite(minY) || !isFinite(minZ)) return null;
        return { minX, minY, minZ, maxX, maxY, maxZ };
    }

    // ── Orbit Controls ───────────────────────────────────────────────

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

    /** Show the view gizmo. Requires orbit controls to be active. No-op if already shown. */
    enableViewGizmo(): void {
        if (this._viewGizmo || !this._orbitController) return;
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;
        this._viewGizmo = new ViewGizmo(
            canvas,
            this.renderer3D.getCamera(),
            this._orbitController,
            () => this.ctx.scheduleRender(),
        );
        this._viewGizmo.draw();
        this._viewGizmoFrameCb = () => { this._viewGizmo?.draw(); return false; };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._viewGizmoFrameCb);
    }

    /** Hide the view gizmo and remove its frame callback. */
    disableViewGizmo(): void {
        this._viewGizmo?.destroy();
        this._viewGizmo = undefined;
        if (this._viewGizmoFrameCb) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._viewGizmoFrameCb);
            this._viewGizmoFrameCb = undefined;
        }
    }

    disableOrbitControls(): void {
        this.disableViewGizmo();
        if (this._orbitUpdateCallback) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._orbitUpdateCallback);
            this._orbitUpdateCallback = undefined;
        }
        if (this._ikSolveCallback) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._ikSolveCallback);
            this._ikSolveCallback = null;
        }
        if (this._springSolveCallback) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._springSolveCallback);
            this._springSolveCallback = null;
        }
        this._orbitController?.detach();
        this._orbitController = undefined;
    }

    /**
     * Enable orbit for mesh edit mode. Keeps the camera at its current position —
     * no snap to front view. Sets cam.target to the mesh center and initialises the
     * ortho-offset pan accumulator so the mesh stays at exactly its current screen
     * position after orbit activates.
     */
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
        this.ctx.scheduleRender();
    }

    /** Disable orbit and clean up mesh edit orbit state. */
    disableMeshEditOrbit(): void {
        this.ctx.interactionService.suppressBoxSelect = false;
        this._meshEditOrbitCenter = null;
        this._meshEditOrthoX = 0;
        this._meshEditOrthoY = 0;
        const cam = this.renderer3D.getCamera();
        cam.orthoOffsetX = 0;
        cam.orthoOffsetY = 0;
        this.renderer3D.setMeshEditModeActive(false);
        this.disableOrbitControls();
    }

    // ── Mesh-edit / UV focus background ────────────────────────────────────────

    /** Set the mesh-edit / UV focus-mode background style. Same options as armature
     *  (`ArmatureBgOptions`): 'wavy' | 'solid' | 'gradient' | 'dim' | 'none'. */
    setMeshEditBgMode3D(opts: import('../../types/armature-3d').ArmatureBgOptions): void {
        this.renderer3D.setMeshEditBgMode(opts);
        this.ctx.scheduleRender();
    }

    /** Current mesh-edit / UV focus-mode background style. */
    getMeshEditBgMode3D(): import('../../types/armature-3d').ArmatureBgOptions {
        return this.renderer3D.getMeshEditBgMode();
    }

    /** True when the mesh-edit/UV focus background is up AND opaque — i.e. the 2D
     *  illustration content is hidden. Used to also suppress the ephemera overlay. */
    meshEditFocusHidesContent(): boolean {
        return this.renderer3D.meshEditHidesContent();
    }

    /** Toggle orbit controls on/off. */
    toggleOrbitControls(enabled?: boolean): void {
        if (this._orbitController) {
            this._orbitController.enabled = enabled ?? !this._orbitController.enabled;
        }
    }

    getOrbitController(): OrbitController | undefined { return this._orbitController; }

    // ── Mesh Creation ────────────────────────────────────────────────

    createBox(x: number, y: number, z: number, width = 1, height = 1, depth = 1, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'box', width, height, depth, material });
    }

    createSphere(x: number, y: number, z: number, radius = 0.5, segments = 16, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'sphere', radius, widthSegments: segments, heightSegments: Math.max(2, segments * 0.75 | 0), material });
    }

    createPlane(x: number, y: number, z: number, width = 1, height = 1, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'plane', width, height, material });
    }

    createCylinder(x: number, y: number, z: number, radius = 0.5, height = 1, radialSegments = 16, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'cylinder', radius, height, radialSegments, material });
    }

    createTorus(x: number, y: number, z: number, radius = 0.5, tubeRadius = 0.2, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'torus', radius, tubeRadius, material });
    }

    createCustomMesh(x: number, y: number, z: number, geometry: MeshGeometry, material?: Partial<Material3D>): Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'custom', geometry, material });
    }

    /**
     * Create an editable polygon mesh from a 2D silhouette in the XZ plane.
     * The mesh is created with an EditMesh pre-attached — no makeEditable() needed.
     */
    createPolygonMesh(x: number, y: number, z: number, points: [number, number][], height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
        const em = EditMesh.fromPolygon(points, height);
        const geom = em.compile();
        const mesh = this.createMesh(x, y, z, { primitive: 'custom', geometry: geom, material });
        mesh.editMesh = em;
        mesh.vertexColors = geom.vertexColors ?? null;
        if (name) mesh.name = name;
        return mesh;
    }

    /**
     * Create an editable circle (regular n-gon) mesh extruded along Y.
     * Convenience wrapper around createPolygonMesh.
     */
    createCircleMesh(x: number, y: number, z: number, radius = 0.5, segments = 8, height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
        const em = EditMesh.fromCircle(radius, segments, height);
        const geom = em.compile();
        const mesh = this.createMesh(x, y, z, { primitive: 'custom', geometry: geom, material });
        mesh.editMesh = em;
        mesh.vertexColors = geom.vertexColors ?? null;
        if (name) mesh.name = name;
        return mesh;
    }

    /**
     * Parse an OBJ string and create a Mesh3D at (x, y, z).
     * Handles missing normals/UVs, quads, and N-gons automatically.
     */
    importObjMesh(x: number, y: number, z: number, objText: string, material?: Partial<Material3D>): Mesh3D {
        const geometry = parseOBJ(objText);
        return this.createMesh(x, y, z, { primitive: 'custom', geometry, material });
    }

    /**
     * Read a .obj File/Blob and create a Mesh3D at (x, y, z).
     * Suitable for drag-and-drop or file-picker input.
     */
    async importObjFile(x: number, y: number, z: number, file: File | Blob, material?: Partial<Material3D>): Promise<Mesh3D> {
        const text = await file.text();
        return this.importObjMesh(x, y, z, text, material);
    }

    /**
     * Parse a GLB ArrayBuffer and create one Mesh3D per node in the scene.
     * Node positions, rotations, and scales from the GLTF hierarchy are applied
     * relative to the given (x, y, z) origin.
     * The raw buffer is retained in the model store so the scene can be serialized.
     */
    async importGltfBuffer(
        x: number, y: number, z: number,
        buffer: ArrayBuffer,
        material?: Partial<Material3D>,
        groupName?: string,
    ): Promise<Mesh3D[]> {
        const results = await parseGLB(buffer);
        return this._createMeshesFromGltf(x, y, z, results, material, buffer, groupName);
    }

    /**
     * Read a .glb/.gltf File and create one Mesh3D per node.
     * Suitable for drag-and-drop or file-picker input.
     */
    async importGltfFile(
        x: number, y: number, z: number,
        file: File | Blob,
        material?: Partial<Material3D>,
    ): Promise<Mesh3D[]> {
        const buffer = await file.arrayBuffer();
        const name   = (file as File).name ?? '';
        const groupName = name.replace(/\.[^.]+$/, '') || '3D Group';
        if (name.endsWith('.gltf')) {
            const text    = new TextDecoder().decode(buffer);
            const results = await parseGLTF(text);
            // Pass an empty buffer for .gltf: the JSON is not a valid GLB and cannot be
            // stored in _modelStore. Geometry is serialized inline on save instead.
            return this._createMeshesFromGltf(x, y, z, results, material, new ArrayBuffer(0), groupName);
        }
        return this.importGltfBuffer(x, y, z, buffer, material, groupName);
    }

    /**
     * Parse a .glb ArrayBuffer that contains a skinned mesh (JOINTS_0 + skins).
     * Creates one Skeleton3D and one SkinnedMesh3D per skinned primitive.
     * Returns both so the caller can link them or add them to the scene.
     */
    async importSkinnedGltfBuffer(
        x: number, y: number, z: number,
        buffer: ArrayBuffer,
        material?: Partial<Material3D>,
    ): Promise<{ skeletons: Skeleton3D[]; meshes: SkinnedMesh3D[] }> {
        const results = await parseSkinnedGLB(buffer);
        return this._createSkinnedMeshesFromGltf(x, y, z, results, material, buffer);
    }

    /** Read a .glb File containing a skinned mesh. */
    async importSkinnedGltfFile(
        x: number, y: number, z: number,
        file: File | Blob,
        material?: Partial<Material3D>,
    ): Promise<{ skeletons: Skeleton3D[]; meshes: SkinnedMesh3D[] }> {
        const buffer = await file.arrayBuffer();
        const name   = (file as File).name ?? '';
        if (name.endsWith('.gltf')) {
            const text    = new TextDecoder().decode(buffer);
            const results = await parseSkinnedGLTF(text);
            // Pass empty buffer for .gltf — raw bytes are JSON text, not a valid GLB.
            return this._createSkinnedMeshesFromGltf(x, y, z, results, material, new ArrayBuffer(0));
        }
        return this.importSkinnedGltfBuffer(x, y, z, buffer, material);
    }

    private async _createSkinnedMeshesFromGltf(
        ox: number, oy: number, oz: number,
        results: import('../../renderer/3d/gltf-importer').GltfSkinnedResult[],
        baseMaterial: Partial<Material3D> | undefined,
        rawBuffer: ArrayBuffer,
    ): Promise<{ skeletons: Skeleton3D[]; meshes: SkinnedMesh3D[] }> {
        if (results.length === 0) return { skeletons: [], meshes: [] };
        const device   = this.ctx.webgpuRenderer.getDevice();
        const skeletons: Skeleton3D[] = [];
        const meshes:    SkinnedMesh3D[] = [];

        // Normalize scale: compute combined vertex bounds and auto-scale to ~20 units,
        // matching the non-skinned path so metre-scale GLBs import at a visible size.
        let geoMinX = Infinity, geoMinY = Infinity, geoMinZ = Infinity;
        let geoMaxX = -Infinity, geoMaxY = -Infinity, geoMaxZ = -Infinity;
        for (const r of results) {
            const v = r.geometry.vertices;
            for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
                if (v[i]   < geoMinX) geoMinX = v[i];   if (v[i]   > geoMaxX) geoMaxX = v[i];
                if (v[i+1] < geoMinY) geoMinY = v[i+1]; if (v[i+1] > geoMaxY) geoMaxY = v[i+1];
                if (v[i+2] < geoMinZ) geoMinZ = v[i+2]; if (v[i+2] > geoMaxZ) geoMaxZ = v[i+2];
            }
        }
        const geoSpan = Math.max(geoMaxX - geoMinX, geoMaxY - geoMinY, geoMaxZ - geoMinZ, 0.0001);
        const autoScale = 20 / geoSpan;
        const geoCX = (geoMinX + geoMaxX) / 2;
        const geoCY = (geoMinY + geoMaxY) / 2;
        const geoCZ = (geoMinZ + geoMaxZ) / 2;

        const root = this.ctx.sceneGraph.root;

        for (const r of results) {
            const skin = r.skinning;
            const jointCount = skin.jointNames.length;

            // Build Joint3D array
            const joints: Joint3D[] = [];
            for (let ji = 0; ji < jointCount; ji++) {
                const ibm = new Float32Array(skin.inverseBindMatrices.buffer,
                    skin.inverseBindMatrices.byteOffset + ji * 64, 16);
                const t = skin.jointLocalPositions.subarray(ji * 3, ji * 3 + 3);
                const q = skin.jointLocalRotations.subarray(ji * 4, ji * 4 + 4);
                const s = skin.jointLocalScales.subarray(ji * 3, ji * 3 + 3);
                joints.push({
                    index:          ji,
                    name:           skin.jointNames[ji],
                    parentIndex:    skin.jointParents[ji],
                    children:       [],
                    localPosition:  [t[0], t[1], t[2]],
                    localRotation:  [q[0], q[1], q[2], q[3]],
                    localScale:     [s[0], s[1], s[2]],
                    tailOffset:     [0, 0.3, 0],
                    worldMatrix:    new Float32Array(16),
                    inverseBindMatrix: new Float32Array(ibm),
                });
            }
            for (const j of joints) {
                if (j.parentIndex >= 0) joints[j.parentIndex].children.push(j.index);
            }

            const skelData: SkeletonData = { name: skin.skinName, joints };
            const skeleton = new Skeleton3D(skelData);
            skeleton.name = skin.skinName;
            root.addChild(skeleton);
            skeletons.push(skeleton);

            const mesh = new SkinnedMesh3D(
                this.ctx.interactionService,
                ox + (r.position[0] - geoCX) * autoScale,
                oy + (r.position[1] - geoCY) * autoScale,
                oz + (r.position[2] - geoCZ) * autoScale,
                { primitive: 'custom', geometry: r.geometry, material: baseMaterial },
            );
            mesh.name       = r.name;
            mesh.skeletonId = skeleton.id;
            mesh.skeleton   = skeleton;
            mesh.jointIndices = skin.jointIndices;
            mesh.jointWeights = skin.jointWeights;
            mesh.skinDirty    = true;
            mesh.setRotation3D(r.rotation[0], r.rotation[1], r.rotation[2]);
            mesh.setScale3D(
                Math.max(r.scale[0], 1e-6) * autoScale,
                Math.max(r.scale[1], 1e-6) * autoScale,
                Math.max(r.scale[2], 1e-6) * autoScale,
            );
            if (baseMaterial?.diffuse === undefined) {
                mesh.setDiffuseColor(r.diffuseColor[0], r.diffuseColor[1], r.diffuseColor[2], r.diffuseColor[3]);
            }
            this._applyGltfTextures(mesh, r, device);
            this._applyMorphTargets(mesh, r.morphTargets);
            mesh.gpuDirty = true;
            if (rawBuffer.byteLength > 0) this._modelStore.set(mesh.id, rawBuffer);

            root.addChild(mesh);
            meshes.push(mesh);
        }

        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(meshes[0].id);
        this.renderer3D.setSelectedMeshIds(new Set(meshes.map(m => m.id)));
        if (this._illustrationSync) this._applyIllustrationCamera();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Import skinned GLB',
            undo: () => {
                for (const m of meshes) {
                    m.diffuseTexture?.destroy();
                    m.normalMapTexture?.destroy();
                    this._modelStore.delete(m.id);
                    m.parent?.removeChild(m);
                }
                for (const s of skeletons) s.parent?.removeChild(s);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                for (const s of skeletons) root.addChild(s);
                for (const m of meshes) {
                    if (rawBuffer.byteLength > 0) this._modelStore.set(m.id, rawBuffer);
                    m.gpuDirty = true;
                    root.addChild(m);
                }
                this.ctx.emitSceneGraphChanged();
            },
        });

        return { skeletons, meshes };
    }

    private async _createMeshesFromGltf(
        ox: number, oy: number, oz: number,
        results: GltfMeshResult[],
        baseMaterial: Partial<Material3D> | undefined,
        rawBuffer: ArrayBuffer,
        groupName?: string,
    ): Promise<Mesh3D[]> {
        if (results.length === 0) return [];
        const device = this.ctx.webgpuRenderer.getDevice();

        // Pre-compute import scale: normalize baked world-space vertices to ~20 units
        // and center the model at the drop point.
        let geoMinX = Infinity, geoMinY = Infinity, geoMinZ = Infinity;
        let geoMaxX = -Infinity, geoMaxY = -Infinity, geoMaxZ = -Infinity;
        for (const r of results) {
            const v = r.geometry.vertices;
            for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
                if (v[i]   < geoMinX) geoMinX = v[i];   if (v[i]   > geoMaxX) geoMaxX = v[i];
                if (v[i+1] < geoMinY) geoMinY = v[i+1]; if (v[i+1] > geoMaxY) geoMaxY = v[i+1];
                if (v[i+2] < geoMinZ) geoMinZ = v[i+2]; if (v[i+2] > geoMaxZ) geoMaxZ = v[i+2];
            }
        }
        const geoSpan = Math.max(geoMaxX - geoMinX, geoMaxY - geoMinY, geoMaxZ - geoMinZ, 0.0001);
        const autoScale = 20 / geoSpan;
        // Center of the combined vertex bounds — pivot so the model center lands at the drop point.
        const geoCX = (geoMinX + geoMaxX) / 2;
        const geoCY = (geoMinY + geoMaxY) / 2;
        const geoCZ = (geoMinZ + geoMaxZ) / 2;

        // Single mesh: inline creation with a dedicated undo entry that cleans up textures and model store.
        if (results.length === 1) {
            const r = results[0];
            const mesh = new Mesh3D(
                this.ctx.interactionService,
                ox + (r.position[0] - geoCX) * autoScale,
                oy + (r.position[1] - geoCY) * autoScale,
                oz + (r.position[2] - geoCZ) * autoScale,
                { primitive: 'custom', geometry: r.geometry, material: baseMaterial },
            );
            mesh.name = r.name;
            mesh.setRotation3D(r.rotation[0], r.rotation[1], r.rotation[2]);
            // Clamp to avoid zero-scale degenerate matrices from GLTF exporters
            mesh.setScale3D(
                Math.max(r.scale[0], 1e-6) * autoScale,
                Math.max(r.scale[1], 1e-6) * autoScale,
                Math.max(r.scale[2], 1e-6) * autoScale,
            );
            if (baseMaterial?.diffuse === undefined) {
                mesh.setDiffuseColor(r.diffuseColor[0], r.diffuseColor[1], r.diffuseColor[2], r.diffuseColor[3]);
            }
            this._applyGltfTextures(mesh, r, device);
            this._applyMorphTargets(mesh, r.morphTargets);
            mesh.gpuDirty = true;
            mesh.glbMeshIndex = 0;
            if (rawBuffer.byteLength > 0) this._modelStore.set(mesh.id, rawBuffer);

            const root = this.ctx.sceneGraph.root;
            root.addChild(mesh);
            this.ctx.emitSceneGraphChanged();
            this.ctx.setSelectedNode(mesh.id);
            this.renderer3D.setSelectedMeshIds(new Set([mesh.id]));
            if (this._illustrationSync) this._applyIllustrationCamera();
            this.ctx.scheduleRender();

            this._undoManager.push({
                description: 'Import GLB',
                undo: () => {
                    mesh.diffuseTexture?.destroy();
                    mesh.normalMapTexture?.destroy();
                    this._modelStore.delete(mesh.id);
                    mesh.parent?.removeChild(mesh);
                    this.ctx.emitSceneGraphChanged();
                },
                redo: () => {
                    if (rawBuffer.byteLength > 0) this._modelStore.set(mesh.id, rawBuffer);
                    mesh.gpuDirty = true;
                    root.addChild(mesh);
                    this.ctx.emitSceneGraphChanged();
                },
            });

            return [mesh];
        }

        // Multiple meshes: create all under one MeshGroup3D with a single undo entry.
        const group = new MeshGroup3D(this.ctx.interactionService);
        group.name = groupName ?? '3D Group';
        const created: Mesh3D[] = [];

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const mesh = new Mesh3D(
                this.ctx.interactionService,
                ox + (r.position[0] - geoCX) * autoScale,
                oy + (r.position[1] - geoCY) * autoScale,
                oz + (r.position[2] - geoCZ) * autoScale,
                { primitive: 'custom', geometry: r.geometry, material: baseMaterial },
            );
            mesh.name = r.name;
            mesh.setRotation3D(r.rotation[0], r.rotation[1], r.rotation[2]);
            // Clamp to avoid zero-scale degenerate matrices from GLTF exporters
            mesh.setScale3D(
                Math.max(r.scale[0], 1e-6) * autoScale,
                Math.max(r.scale[1], 1e-6) * autoScale,
                Math.max(r.scale[2], 1e-6) * autoScale,
            );
            if (baseMaterial?.diffuse === undefined) {
                mesh.setDiffuseColor(r.diffuseColor[0], r.diffuseColor[1], r.diffuseColor[2], r.diffuseColor[3]);
            }
            this._applyGltfTextures(mesh, r, device);
            this._applyMorphTargets(mesh, r.morphTargets);
            mesh.gpuDirty = true;
            mesh.glbMeshIndex = i;
            if (rawBuffer.byteLength > 0) this._modelStore.set(mesh.id, rawBuffer);
            group.addChild(mesh);
            created.push(mesh);
        }

        const root = this.ctx.sceneGraph.root;
        root.addChild(group);
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(group.id);
        this.renderer3D.setSelectedMeshIds(new Set(created.map(m => m.id)));
        if (this._illustrationSync) this._applyIllustrationCamera();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Import GLB',
            undo: () => {
                for (const m of created) {
                    m.diffuseTexture?.destroy();
                    m.normalMapTexture?.destroy();
                    this._modelStore.delete(m.id);
                }
                group.parent?.removeChild(group);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                root.addChild(group);
                for (const m of created) {
                    if (rawBuffer.byteLength > 0) this._modelStore.set(m.id, rawBuffer);
                    m.gpuDirty = true;
                }
                this.ctx.emitSceneGraphChanged();
            },
        });

        return created;
    }

    private _applyGltfTextures(mesh: Mesh3D, r: GltfMeshResult, device: GPUDevice | null): void {
        if (r.diffuseImage && device) {
            const tex = device.createTexture({
                size: [r.diffuseImage.width, r.diffuseImage.height, 1],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            device.queue.copyExternalImageToTexture({ source: r.diffuseImage }, { texture: tex }, [r.diffuseImage.width, r.diffuseImage.height]);
            mesh.diffuseTexture = tex;
            mesh.material.hasTexture = true;
        }
        if (r.normalMapImage && device) {
            const tex = device.createTexture({
                size: [r.normalMapImage.width, r.normalMapImage.height, 1],
                format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            device.queue.copyExternalImageToTexture({ source: r.normalMapImage }, { texture: tex }, [r.normalMapImage.width, r.normalMapImage.height]);
            mesh.normalMapTexture = tex;
            mesh.material.hasNormalMap = true;
            if (!mesh.diffuseTexture && device) {
                const w = device.createTexture({ size: [1,1,1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
                device.queue.writeTexture({ texture: w }, new Uint8Array([255,255,255,255]), { bytesPerRow: 4 }, [1,1,1]);
                mesh.diffuseTexture = w;
                mesh.material.hasTexture = true;
            }
        }
    }

    private _applyMorphTargets(mesh: Mesh3D, targets: import('../../scene-graph/shapes/mesh-3d').BlendShape[]): void {
        if (!targets || targets.length === 0) return;
        mesh.baseVertices  = new Float32Array(mesh.geometry.vertices);
        mesh.blendShapes   = targets.slice();
        mesh.blendWeights  = new Float32Array(targets.length); // all zeros
    }

    // ── Blend shape API ────────────────────────────────────────────────────────

    addBlendShape3D(meshId: string, name: string, deltaVertices: Float32Array): number {
        const mesh = this.getMesh(meshId);
        if (!mesh) throw new Error(`Mesh ${meshId} not found`);
        if (!mesh.baseVertices) {
            mesh.baseVertices = new Float32Array(mesh.geometry.vertices);
        }
        const idx = mesh.blendShapes.length;
        mesh.blendShapes.push({ name, deltaVertices });
        const w = new Float32Array(mesh.blendShapes.length);
        w.set(mesh.blendWeights);
        mesh.blendWeights = w;
        return idx;
    }

    setBlendWeight3D(meshId: string, shapeIndex: number, weight: number): void {
        const mesh = this.getMesh(meshId);
        if (!mesh || shapeIndex >= mesh.blendShapes.length) return;
        mesh.blendWeights[shapeIndex] = Math.max(0, Math.min(1, weight));
        mesh.evaluateBlendShapes();
        if ((mesh as any).isSkinned) (mesh as any).skinDirty = true;
        this.ctx.scheduleRender();
    }

    getBlendShapes3D(meshId: string): { name: string; weight: number }[] {
        const mesh = this.getMesh(meshId);
        if (!mesh) return [];
        return mesh.blendShapes.map((s, i) => ({ name: s.name, weight: mesh.blendWeights[i] ?? 0 }));
    }

    removeBlendShape3D(meshId: string, shapeIndex: number): void {
        const mesh = this.getMesh(meshId);
        if (!mesh || shapeIndex >= mesh.blendShapes.length) return;
        mesh.blendShapes.splice(shapeIndex, 1);
        const w = new Float32Array(mesh.blendShapes.length);
        for (let i = 0, j = 0; i < mesh.blendWeights.length; i++) {
            if (i !== shapeIndex) w[j++] = mesh.blendWeights[i];
        }
        mesh.blendWeights = w;
        mesh.evaluateBlendShapes();
        if (mesh.blendShapes.length === 0) mesh.baseVertices = null;
        if ((mesh as any).isSkinned) (mesh as any).skinDirty = true;
        this.ctx.scheduleRender();
    }

    /**
     * Recreate a Mesh3D from serialized state (e.g. from OPFS restore).
     * For GLTF-imported meshes pass the raw GLB buffer; for primitives/custom
     * geometry it is optional (geometry is reconstructed from the saved vertices).
     */
    async restoreMeshState(state: any, glbBuffer?: ArrayBuffer): Promise<Mesh3D | null> {
        let mesh: Mesh3D | null = null;

        // ── ClothMesh3D ──────────────────────────────────────────────────────
        if (state.type === '3DClothMesh' && state.clothConfig) {
            const grid: ClothGridConfig = {
                cols:             state.clothConfig.cols             ?? 8,
                rows:             state.clothConfig.rows             ?? 10,
                cellSize:         state.clothConfig.cellSize         ?? 0.1,
                cornerRadius:     state.clothConfig.cornerRadius     ?? 0,
                subdivisions:     state.clothConfig.subdivisions     ?? 1,
                activeCells:      Array.from(state.clothConfig.activeCells    ?? []),
                pinnedVertices:   Array.from(state.clothConfig.pinnedVertices ?? []),
                stitches:         state.clothConfig.stitches         ? [...state.clothConfig.stitches]         : undefined,
                bendStiffnessMap: state.clothConfig.bendStiffnessMap ? Array.from(state.clothConfig.bendStiffnessMap) : undefined,
            };
            const physics: ClothPhysicsConfig = { ...DEFAULT_CLOTH_PHYSICS, ...state.physicsConfig };
            const liveConfig: ClothLiveConfig = {
                ...DEFAULT_CLOTH_LIVE,
                ...state.liveConfig,
                windZones: state.liveConfig?.windZones ? [...state.liveConfig.windZones] : undefined,
            };
            const simState: ClothSimState = {
                positions:      Array.from(state.simState?.positions      ?? []),
                isSimulated:    state.simState?.isSimulated    ?? false,
                simulationMode: state.simState?.simulationMode ?? 'none',
            };

            // Rebuild geometry from config (reconstructs constraint graph too)
            const result   = buildClothGeometry(grid);
            const savedPos = simState.isSimulated ? new Float32Array(simState.positions) : undefined;
            const geometry = _resolveClothGeometry(result, savedPos, physics);

            const clothMesh = new ClothMesh3D(
                this.ctx.interactionService,
                state.x ?? 0, state.y ?? 0, state.z ?? 0,
                geometry, grid, physics, simState, liveConfig,
            );
            clothMesh.name = state.name ?? 'Cloth';
            clothMesh.setRotation3D(state.rotationX ?? 0, state.rotationY ?? 0, state.rotation ?? 0);
            clothMesh.setScale3D(state.scaleX ?? 1, state.scaleY ?? 1, state.scaleZ ?? 1);
            if (state.material) { Object.assign(clothMesh.material, state.material); clothMesh.gpuDirty = true; }
            clothMesh.textureLibraryId   = state.textureLibraryId   ?? null;
            clothMesh.normalMapLibraryId = state.normalMapLibraryId ?? null;
            if (state.keyframeTracks) clothMesh.keyframeTracks = state.keyframeTracks;
            if (state.frameLinkAnimation3D) this.setFrameLinkAnimation3D(clothMesh.id, state.frameLinkAnimation3D);

            this._clothData.set(clothMesh.id, result);

            const parent = this.ctx.sceneGraph.root;
            parent.addChild(clothMesh);
            this.ctx.emitSceneGraphChanged();

            // Re-enable live physics if it was active when saved
            if (liveConfig.enabled) this.enableLiveCloth(clothMesh.id, liveConfig.stepsPerFrame);

            return clothMesh;
        }

        // ── SkinnedMesh3D ─────────────────────────────────────────────────────
        if (state.type === 'SkinnedMesh3D' && glbBuffer) {
            const results = await parseSkinnedGLB(glbBuffer);
            const r = results[0] ?? null;
            if (!r) return null;

            const skinnedMesh = new SkinnedMesh3D(
                this.ctx.interactionService,
                state.x ?? 0, state.y ?? 0, state.z ?? 0,
                { geometry: r.geometry, material: state.material },
            );

            // Restore saved ID so skeleton link (skeletonId) resolves correctly.
            if (state.id) (skinnedMesh as any).id = state.id;

            skinnedMesh.name       = state.name ?? 'Skinned Mesh';
            skinnedMesh.skeletonId = state.skeletonId ?? null;
            if (state.isProceduralBody)     skinnedMesh.isProceduralBody     = true;   // re-flag a procedural body
            if (state.transformViaSkeleton) skinnedMesh.transformViaSkeleton = true;   // so a moved character reloads right
            skinnedMesh.setRotation3D(state.rotationX ?? 0, state.rotationY ?? 0, state.rotation ?? 0);
            skinnedMesh.setScale3D(state.scaleX ?? 1, state.scaleY ?? 1, state.scaleZ ?? 1);
            if (state.material) { Object.assign(skinnedMesh.material, state.material); skinnedMesh.gpuDirty = true; }
            skinnedMesh.textureLibraryId   = state.textureLibraryId   ?? null;
            skinnedMesh.normalMapLibraryId = state.normalMapLibraryId ?? null;
            if (state.keyframeTracks) skinnedMesh.keyframeTracks = state.keyframeTracks;

            // Restore skinning arrays — prefer saved base64 (authoritative), fall back to parsed data.
            if (state.jointIndicesB64) {
                skinnedMesh.jointIndices = fromBase64ToUint8(state.jointIndicesB64);
            } else if (r.skinning?.jointIndices) {
                skinnedMesh.jointIndices = r.skinning.jointIndices;
            }
            if (state.jointWeightsB64) {
                skinnedMesh.jointWeights = fromBase64ToFloat32(state.jointWeightsB64);
            } else if (r.skinning?.jointWeights) {
                skinnedMesh.jointWeights = r.skinning.jointWeights;
            }
            skinnedMesh.skinDirty = true;

            if (state.glbMeshId) this._modelStore.set(skinnedMesh.id, glbBuffer);

            this.ctx.sceneGraph.root.addChild(skinnedMesh);
            this.ctx.emitSceneGraphChanged();
            skinnedMesh.stateDirty = false;
            return skinnedMesh;
        }

        if (glbBuffer) {
            if (state.config?.geometry?.vertices?.length) {
                // If the scene-graph restore already created this mesh (same id), update it
                // in place rather than creating a second copy outside its group.
                const existing = state.id ? this.getMesh(state.id) : null;
                if (existing) {
                    mesh = existing;
                } else {
                    // Geometry was serialized inline — restore the individual mesh directly
                    // without re-parsing the GLB (which would create a new auto-group).
                    const geom = {
                        vertices: Float32Array.from(state.config.geometry.vertices),
                        indices:  Uint32Array.from(state.config.geometry.indices ?? []),
                        format: '12float' as const,
                    };
                    mesh = this.createCustomMesh(state.x, state.y, state.z, geom, state.material);
                    // Preserve the serialized ID so group-hierarchy re-population can match
                    // this new mesh back to the MeshGroup3D that owned it before the clear.
                    if (mesh && state.id) mesh.setId(state.id);
                }
                if (mesh) {
                    this._modelStore.set(mesh.id, glbBuffer);
                    // Re-apply textures from the GLB. Use glbMeshIndex for O(1) lookup;
                    // fall back to name-based search for states saved before glbMeshIndex existed.
                    const device = this.ctx.webgpuRenderer.getDevice();
                    if (device) {
                        try {
                            let parsePromise = this._glbParseCache.get(glbBuffer);
                            if (!parsePromise) {
                                parsePromise = parseGLB(glbBuffer);
                                this._glbParseCache.set(glbBuffer, parsePromise);
                            }
                            const results = await parsePromise;
                            const idx = state.glbMeshIndex ?? -1;
                            const r = (idx >= 0 && idx < results.length)
                                ? results[idx]
                                : (results.find(rr => rr.name === state.name) ?? results[0]);
                            if (r) this._applyGltfTextures(mesh, r, device);
                        } catch { /* broken GLB — mesh still visible via saved geometry */ }
                    }
                }
            } else {
                const meshes = await this.importGltfBuffer(state.x, state.y, state.z, glbBuffer);
                mesh = meshes[0] ?? null;
            }
        } else if (state.config?.geometry) {
            const geom = {
                vertices: Float32Array.from(state.config.geometry.vertices ?? []),
                indices:  Uint32Array.from(state.config.geometry.indices  ?? []),
                format: '12float' as const,
            };
            mesh = this.createCustomMesh(state.x, state.y, state.z, geom, state.material);
        } else if (state.primitive && state.primitive !== 'custom') {
            switch (state.primitive) {
                case 'box':      mesh = this.createBox(state.x, state.y, state.z); break;
                case 'sphere':   mesh = this.createSphere(state.x, state.y, state.z); break;
                case 'plane':    mesh = this.createPlane(state.x, state.y, state.z); break;
                case 'cylinder': mesh = this.createCylinder(state.x, state.y, state.z); break;
                case 'torus':    mesh = this.createTorus(state.x, state.y, state.z); break;
                default: break;
            }
        }

        if (!mesh) return null;

        // Restore the original serialized ID so ArrayGroup3D.sourceId and group
        // hierarchy re-population can match this mesh back after restore.
        // The GLTF-with-inline-geometry branch already does this at its creation
        // site (line above); this covers primitive and custom-geometry paths.
        if (state.id) mesh.setId(state.id);

        mesh.name = state.name ?? mesh.name;
        mesh.setRotation3D(state.rotationX ?? 0, state.rotationY ?? 0, state.rotation ?? 0);
        mesh.setScale3D(state.scaleX ?? 1, state.scaleY ?? 1, state.scaleZ ?? 1);
        if (state.material) { Object.assign(mesh.material, state.material); mesh.gpuDirty = true; }
        // Object.assign may have overwritten hasTexture/hasNormalMap with stale saved values
        // (e.g. a degraded state where textures weren't applied on a previous restore cycle).
        // Re-derive the flags from the actual GPU texture references set by _applyGltfTextures.
        if (mesh.diffuseTexture)   mesh.material.hasTexture   = true;
        if (mesh.normalMapTexture) mesh.material.hasNormalMap = true;

        // Restore source-index so future saves can use index-based texture lookup.
        if (state.glbMeshIndex != null) mesh.glbMeshIndex = state.glbMeshIndex;

        // Restore texture library IDs so restoreTextureLibraryData() can bind GPU textures.
        mesh.textureLibraryId    = state.textureLibraryId    ?? null;
        mesh.normalMapLibraryId  = state.normalMapLibraryId  ?? null;
        if (state.keyframeTracks) mesh.keyframeTracks = state.keyframeTracks;
        if (state.frameLinkAnimation3D) this.setFrameLinkAnimation3D(mesh.id, state.frameLinkAnimation3D);

        // Restore blend shapes
        if (state.blendShapes?.length > 0) {
            const { base64ToFloat32 } = await import('../../scene-graph/shapes/mesh-3d');
            mesh.blendShapes  = (state.blendShapes as any[]).map((s: any) => ({
                name: s.name,
                deltaVertices: base64ToFloat32(s.deltaVerticesB64),
            }));
            mesh.blendWeights = state.blendWeights
                ? new Float32Array(state.blendWeights)
                : new Float32Array(mesh.blendShapes.length);
            if (state.baseVerticesB64) mesh.baseVertices = base64ToFloat32(state.baseVerticesB64);
            mesh.evaluateBlendShapes();
        }

        // Restore ribbon metadata and regenerate geometry from control points
        if (state.ribbonData) {
            const rd: RibbonData = {
                ...state.ribbonData,
                meshId: mesh.id,
                doubleSided:  state.ribbonData.doubleSided === false ? 'front' : (state.ribbonData.doubleSided === true ? 'double' : (state.ribbonData.doubleSided ?? 'double')),
                flipRearU:    state.ribbonData.flipRearU    ?? false,
                uvTileCount:  state.ribbonData.uvTileCount  ?? 1,
            };
            this._ribbonData.set(mesh.id, rd);
            let camPos: [number, number, number] = [0, 0, 3];
            try { const c = this.renderer3D.getCamera(); camPos = [c.position[0], c.position[1], c.position[2]]; } catch {}
            mesh.setGeometry(generateRibbon({
                controlPoints: rd.controlPoints.map((p: RibbonControlPoint) => [p.x, p.y, p.z] as [number, number, number]),
                width: rd.width,
                segments: rd.segments,
                uvScrollOffset: rd.uvScrollOffset,
                uvScrollOffsetV: rd.uvScrollOffsetV,
                uvEndPadding: rd.uvEndPadding,
                uvTileCount: rd.uvTileCount,
                pathMode: rd.pathMode,
                cameraPosition: camPos,
                doubleSided: rd.doubleSided,
                flipRearU: rd.flipRearU,
            }));
            if (rd.pathMode === 'camera-facing') this._ensureRibbonUpdateCb();

            // Auto-restore HTML texture from cached content
            if (rd.htmlContent && rd.htmlTextureWidth && rd.htmlTextureHeight) {
                const opts: HtmlTexture3DOptions = {};
                if (rd.htmlTextureBgColor !== undefined) opts.backgroundColor = rd.htmlTextureBgColor;
                if (rd.htmlTextureStretchToFit !== undefined) opts.stretchToFit = rd.htmlTextureStretchToFit;
                // Fire and forget — texture restore is async but mesh is already visible with geometry
                this.setHtmlTexture3D(mesh.id, rd.htmlContent, rd.htmlTextureWidth, rd.htmlTextureHeight, opts);
            }
        }

        mesh.stateDirty = false;
        this.clearSelection();
        return mesh;
    }

    // ── Auto-scale ───────────────────────────────────────────────────

    /**
     * Scale a group of meshes so their combined local-space bounding box fits
     * within `targetSize` world units. Only scales when the span is suspiciously
     * small (< 5% of targetSize) — the typical symptom of GLTF metre-vs-pixel mismatch.
     * @param meshIds IDs of meshes to scale (e.g., all meshes returned by importGltfFile)
     * @param targetSize Desired max span in world units (default 400)
     */
    autoScaleToFit(meshIds: string[], targetSize = 400): void {
        if (meshIds.length === 0) return;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const id of meshIds) {
            const mesh = this.getMesh(id);
            const v = mesh?.geometry?.vertices;
            if (!v || v.length < 3) continue;
            for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
                if (v[i]   < minX) minX = v[i];   if (v[i]   > maxX) maxX = v[i];
                if (v[i+1] < minY) minY = v[i+1]; if (v[i+1] > maxY) maxY = v[i+1];
                if (v[i+2] < minZ) minZ = v[i+2]; if (v[i+2] > maxZ) maxZ = v[i+2];
            }
        }

        if (!isFinite(minX)) return;

        const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.0001);
        if (span >= targetSize * 0.05) return; // already a reasonable size

        const scale = (targetSize * 0.5) / span;
        for (const id of meshIds) {
            const mesh = this.getMesh(id);
            if (!mesh) continue;
            mesh.setScale3D(mesh.scaleX * scale, mesh.scaleY * scale, mesh.scaleZ * scale);
        }
        this.ctx.scheduleRender();
    }

    // ── Model store (raw GLB bytes, for project save/load) ───────────

    /** Raw GLB buffer keyed by mesh ID — populated when a mesh is imported from GLTF. */
    private _modelStore = new Map<string, ArrayBuffer>();

    /** Parse cache: avoids re-parsing the same GLB ArrayBuffer N times during a restore
     *  when N child meshes all reference the same buffer. Keyed by buffer identity. */
    private _glbParseCache = new WeakMap<ArrayBuffer, Promise<GltfMeshResult[]>>();

    /** Returns all stored model buffers as { meshId → ArrayBuffer }. */
    getModelStore(): Map<string, ArrayBuffer> { return this._modelStore; }

    /** Restore a raw GLB buffer into the model store (used during project load). */
    storeModelBuffer(meshId: string, buffer: ArrayBuffer): void {
        this._modelStore.set(meshId, buffer);
    }

    /**
     * If `meshId` is not in the model store but belongs to a MeshGroup3D whose
     * sibling is in the store, returns that sibling's ID.  This lets _buildMeshState
     * assign a valid glbMeshId to every mesh in a group even after a degraded save
     * cycle where some entries were lost from _modelStore.
     */
    findGroupMemberGlbId(meshId: string): string | undefined {
        const m = this.getMesh(meshId);
        if (!m || !(m.parent instanceof MeshGroup3D)) return undefined;
        for (const child of m.parent.children) {
            const id = (child as any).id as string | undefined;
            if (id && id !== meshId && this._modelStore.has(id)) return id;
        }
        return undefined;
    }

    // ── Outline pass ─────────────────────────────────────────────────

    /** Enable the screen-space ink outline effect. */
    enableOutlines(color?: [number, number, number, number], threshold?: number): void {
        this.renderer3D.enableOutlines(color, threshold);
        this.ctx.scheduleRender();
    }

    /** Disable the screen-space ink outline effect. */
    disableOutlines(): void {
        this.renderer3D.disableOutlines();
        this.ctx.scheduleRender();
    }

    /** Set the outline colour (r, g, b, a in 0–1 range). */
    setOutlineColor(r: number, g: number, b: number, a = 1): void {
        this.renderer3D.setOutlineColor(r, g, b, a);
    }

    /** Set the outline width in physical pixels (default 2). Larger = thicker silhouette. */
    setOutlineThreshold(t: number): void {
        this.renderer3D.setOutlineThreshold(t);
    }

    get outlineEnabled(): boolean { return this.renderer3D.outlineEnabled; }

    // ── Render style ─────────────────────────────────────────────────

    /** Set the render style on a mesh ('default' | 'cel' | 'sketch' | 'ink'). */
    setRenderStyle(nodeId: string, style: RenderStyle): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        mesh.material.renderStyle = style;
        mesh.gpuDirty = true;
        mesh.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    getRenderStyle(nodeId: string): RenderStyle | null {
        return this.getMesh(nodeId)?.material.renderStyle ?? null;
    }

    private createMesh(x: number, y: number, z: number, config: Mesh3DConfig): Mesh3D {
        const mesh = new Mesh3D(this.ctx.interactionService, x, y, z, config);

        // In illustration mode 1 world unit = 1 canvas pixel (at zoom=1).
        // Auto-scale primitive meshes so they appear a reasonable size (~100px) on the canvas.
        // Custom geometry (GLTF/OBJ imports) is left at its original scale.
        if (this._illustrationSync && config.primitive !== 'custom') {
            const s = this.illustrationMeshDefaultScale();
            mesh.setScale3D(s, s, s);
        }

        const parent = this.ctx.sceneGraph.root;
        parent.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(mesh.id);
        this.renderer3D.setSelectedMeshIds(new Set([mesh.id]));

        // If the illustration camera sync params are available, re-apply the camera now.
        // This handles the case where _renderer3D hasn't been initialized yet (no pan/zoom
        // has happened this session), ensuring it's created with the correct camera
        // position rather than the default (0,0,3) which would frustum-cull canvas-placed meshes.
        if (this._illustrationSync) this._applyIllustrationCamera();

        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Create mesh',
            undo: () => {
                mesh.parent?.removeChild(mesh);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                parent.addChild(mesh);
                mesh.gpuDirty = true;
                this.ctx.emitSceneGraphChanged();
            },
        });

        return mesh;
    }

    getMesh(nodeId: string): Mesh3D | null {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        return node instanceof Mesh3D ? node : null;
    }

    getSkeleton(nodeId: string): Skeleton3D | null {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        return node instanceof Skeleton3D ? node : null;
    }

    getSkinnedMesh(nodeId: string): SkinnedMesh3D | null {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        return node instanceof SkinnedMesh3D ? node : null;
    }

    /** Get all Mesh3D nodes in the scene. */
    getAllMeshes(): Mesh3D[] {
        const meshes: Mesh3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep?.((n: any) => {
            if (n instanceof Mesh3D) meshes.push(n);
        });
        return meshes;
    }

    /** Get all Skeleton3D nodes in the scene. */
    getAllSkeletons(): Skeleton3D[] {
        const skeletons: Skeleton3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep?.((n: any) => {
            if (n instanceof Skeleton3D) skeletons.push(n);
        });
        return skeletons;
    }

    /**
     * Recreate a Skeleton3D from serialized state produced by Skeleton3D.toJSON().
     * Adds the skeleton to the scene graph root.
     */
    restoreSkeletonState(state: any): Skeleton3D {
        const skel = Skeleton3D.fromJSON(state);
        this.ctx.sceneGraph.root.addChild(skel);
        return skel;
    }

    /**
     * Re-link SkinnedMesh3D.skeleton references after a full restore.
     * Searches all skinned meshes for a matching Skeleton3D by skeletonId.
     */
    relinkSkinnedMeshSkeletons(): void {
        const skeletonMap = new Map<string, Skeleton3D>();
        for (const skel of this.getAllSkeletons()) skeletonMap.set(skel.id, skel);

        for (const mesh of this.getAllMeshes()) {
            if (!(mesh instanceof SkinnedMesh3D)) continue;
            if (mesh.skeletonId && skeletonMap.has(mesh.skeletonId)) {
                mesh.skeleton = skeletonMap.get(mesh.skeletonId)!;
            }
        }
    }

    // ── Kitbash library (Phase B) ────────────────────────────────────

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

    // ── Character assembly (Phase B) ─────────────────────────────────

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

        const skeleton = await this._createSkeletonFromResult(baseResult);
        const partMeshIds = new Map<CharacterSlot, string>();

        // 2. Create SkinnedMesh3D for base_body (already uses canonical joints).
        const baseMesh = await this._createSkinnedMeshForSlot(
            baseResult, skeleton, ox, oy, oz, def, 'base_body',
        );
        this.ctx.sceneGraph.root.addChild(baseMesh);
        this._modelStore.set(baseMesh.id, baseBuf);
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

            const mesh = await this._createSkinnedMeshForSlot(
                partResult, skeleton, ox, oy, oz, def, slot,
            );
            this.ctx.sceneGraph.root.addChild(mesh);
            this._modelStore.set(mesh.id, partBuf);
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

        this._undoManager.push({
            description: 'Create character',
            undo: () => { this._destroyCharacterNodes(charData); this._characterMap.delete(charData.id); this.ctx.emitSceneGraphChanged(); },
            redo: () => { /* re-adding is async — not supported inline; re-create via createCharacter */ },
        });

        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return charData.id;
    }

    /**
     * PROTOTYPE: generate a procedural humanoid base body (tubes around a small skeleton) and
     * drop it into the scene as a rigged SkinnedMesh3D — same path as a kitbash base_body, but
     * the mesh + skeleton + weights are generated from params instead of a GLB. See
     * docs/specs/character-creation-pipeline.md §2.1 and body-generator.ts.
     */
    async createProceduralBody3D(
        params?: Partial<import('./body-generator').BodyParams>,
        ox = 0, oy = 0, oz = 0,
    ): Promise<{ meshId: string; skeletonId: string }> {
        const { generateBodyResult, DEFAULT_BODY_PARAMS } = await import('./body-generator');
        const result = generateBodyResult(params);
        const skeleton = await this._createSkeletonFromResult(result);
        const def: CharacterDefinition = {
            id: 'proc_' + Date.now().toString(36),
            name: 'ProcBody',
            slots: { base_body: 'procedural' },
        };
        this.clearProceduralBodyPreview(); // committing — drop any live ghost
        const mesh = await this._createSkinnedMeshForSlot(result, skeleton, ox, oy, oz, def, 'base_body');
        mesh.material.doubleSided = true; // PROTOTYPE: visible regardless of tube winding
        // Tag both so the armature panel can hide "Bind Mesh" — the body is already rigged with the
        // generator's tube weights; re-binding would clobber them with distance-based auto-weights.
        mesh.isProceduralBody = true;
        mesh.transformViaSkeleton = true;   // object transform lives on the skeleton (gizmo moves the whole character)
        skeleton.isProceduralBody = true;

        // Default IK chains for both arms and legs (end joint + 3-bone chain). Created DISABLED so FK
        // and the preset poses keep driving the body by default; the armature panel enables a chain
        // to pose by dragging the hand/foot. Pole targets bias the elbows back / knees forward so the
        // limb bends the natural way.
        const jIdx = (n: string) => skeleton.data.joints.findIndex(j => j.name === n);
        const jPos = (i: number): [number, number, number] =>
            [skeleton.data.joints[i].worldMatrix[12], skeleton.data.joints[i].worldMatrix[13], skeleton.data.joints[i].worldMatrix[14]];
        for (const [endName, midName, poleZ] of [
            ['hand_L', 'lowerarm_L', -0.4], ['hand_R', 'lowerarm_R', -0.4], // elbows point back
            ['foot_L', 'lowerleg_L',  0.4], ['foot_R', 'lowerleg_R',  0.4], // knees point forward
        ] as const) {
            const end = jIdx(endName), mid = jIdx(midName);
            if (end < 0 || mid < 0) continue;
            const chainId = this.addIKChain(skeleton.id, end, 3);
            this.setIKChainEnabled(skeleton.id, chainId, false);
            const m = jPos(mid);
            this.setPoleTarget(skeleton.id, chainId, m[0], m[1], m[2] + poleZ);
        }

        // Rotation limits (anti-hyperextension hinges). Elbows hinge on Y, knees on X (confirmed by the
        // pole directions above). Lock the off-axes to a little play (no ugly twist) and clamp the hinge
        // so the limb can't bend the wrong way. Angles in DEGREES; tune in createProceduralBody3D.
        for (const [name, lim] of [
            ['lowerarm_L', { minX:-20, maxX:20, minY:-150, maxY:8,   minZ:-20, maxZ:20 }],  // elbow
            ['lowerarm_R', { minX:-20, maxX:20, minY:-8,   maxY:150, minZ:-20, maxZ:20 }],
            ['lowerleg_L', { minX:-8,  maxX:150, minY:-20, maxY:20,  minZ:-20, maxZ:20 }],   // knee
            ['lowerleg_R', { minX:-8,  maxX:150, minY:-20, maxY:20,  minZ:-20, maxZ:20 }],
        ] as const) {
            const i = jIdx(name);
            if (i < 0) continue;
            const j = skeleton.data.joints[i];
            (j.constraints ??= []).push({ type: 'limitRotation', influence: 1, ...lim });
        }

        this._bodyParams.set(mesh.id, { ...DEFAULT_BODY_PARAMS, ...(params ?? {}) });
        this._bodyArmSurface.set(mesh.id, result.armSurface);
        this.ctx.sceneGraph.root.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return { meshId: mesh.id, skeletonId: skeleton.id };
    }

    /** Per-body procedural params, so a live edit can merge a single-field change + re-fit overlays,
     *  and the sliders can re-seed after reload (serializeBodyParams). */
    private _bodyParams = new Map<string, import('./body-generator').BodyParams>();
    /** Per-body ARM SURFACE (the generator's arm rings), so a sleeve is built as the arm offset → follows
     *  the real shoulder/armpit. Cached on create/regen; recomputed on demand for loaded bodies. */
    private _bodyArmSurface = new Map<string, ArmSurface>();

    /** Current procedural params for a body (to seed the sliders), or null. */
    getBodyParams(bodyMeshId: string): import('./body-generator').BodyParams | null {
        return this._bodyParams.get(bodyMeshId) ?? null;
    }

    /**
     * Live-edit a procedural body: regenerate its geometry + skeleton IN PLACE (same mesh + skeleton
     * ids, so selection/rigs/persistence stay valid; the skeleton's objectTransform is preserved so a
     * moved character stays put), then re-fit every attached overlay (hair, garments, face decal) to
     * the new shape. Merges `params` over the body's current params, so a single slider change keeps
     * the rest. Call on each slider change (cheap — the same generator the preview uses).
     */
    async setBodyParams(bodyMeshId: string, params: Partial<import('./body-generator').BodyParams>): Promise<void> {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.isProceduralBody || !body.skeleton) return;
        const { generateBodyResult, DEFAULT_BODY_PARAMS } = await import('./body-generator');
        const merged = { ...DEFAULT_BODY_PARAMS, ...(this._bodyParams.get(bodyMeshId) ?? {}), ...params };
        const result = generateBodyResult(merged);
        // 1. Update the skeleton's rest pose in place (keeps the object + id + objectTransform → the
        //    skinned overlays stay attached and a moved character stays where it was moved to).
        this._updateSkeletonFromResult(body.skeleton, result);
        // 2. Swap the body geometry + skin data in place (keeps the mesh id → rigs/selection/persistence).
        body.setGeometry(result.geometry);
        body.jointIndices = result.skinning.jointIndices.slice();
        body.jointWeights = result.skinning.jointWeights.slice();
        body.skinDirty = true;
        body.gpuDirty  = true;
        this._bodyParams.set(bodyMeshId, merged);
        this._bodyArmSurface.set(bodyMeshId, result.armSurface);
        // 3. Re-fit the attached overlays to the new body shape.
        this._refitCharacterOverlays(bodyMeshId);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Update a skeleton's joint rest pose + inverse-bind matrices from a freshly generated body result
     *  (same joint count/names — only positions change). Preserves the skeleton object + objectTransform. */
    private _updateSkeletonFromResult(skeleton: Skeleton3D, result: import('../../renderer/3d/gltf-importer').GltfSkinnedResult): void {
        const skin = result.skinning, joints = skeleton.data.joints;
        const n = Math.min(joints.length, skin.jointNames.length);
        for (let ji = 0; ji < n; ji++) {
            const t = skin.jointLocalPositions.subarray(ji*3, ji*3+3);
            const q = skin.jointLocalRotations.subarray(ji*4, ji*4+4);
            const s = skin.jointLocalScales.subarray(ji*3, ji*3+3);
            joints[ji].localPosition = [t[0], t[1], t[2]];
            joints[ji].localRotation = [q[0], q[1], q[2], q[3]];
            joints[ji].localScale    = [s[0], s[1], s[2]];
            const ibm = new Float32Array(skin.inverseBindMatrices.buffer, skin.inverseBindMatrices.byteOffset + ji*64, 16);
            joints[ji].inverseBindMatrix = new Float32Array(ibm);
        }
        skeleton.computeWorldMatrices();   // applies objectTransform → joints + bones follow
        skeleton.matricesDirty = true;
    }

    /** Re-fit a character's overlays (hair, garments, face decal) after the body shape changed. */
    private _refitCharacterOverlays(bodyMeshId: string): void {
        const hr = this._hairRigs.get(bodyMeshId);
        if (hr) { try { this.setHairParams(bodyMeshId, hr.params); } catch (e) { console.warn('[Body] hair re-fit failed', e); } }
        for (const slot of ['top', 'bottom'] as const) {
            const cr = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
            if (cr) { try { this.setClothingParams(bodyMeshId, cr.params); } catch (e) { console.warn('[Body] clothing re-fit failed', slot, e); } }
        }
        // Face decal: rebuild against the new head bbox (keeps the per-expression textures + active one).
        const fr = this._faceRigs.get(bodyMeshId), body = this.getMesh(bodyMeshId);
        if (fr && body instanceof SkinnedMesh3D) {
            try {
                const old = this.getMesh(fr.decalMeshId); old?.parent?.removeChild(old);
                const decal = this._buildFaceDecal(body, fr.headJointIdx);
                if (decal) {
                    fr.decalMeshId = decal.id;
                    fr.faceAspect  = this._faceAspect(body, fr.headJointIdx);
                    this._applyTexture(fr, fr.activeId);
                }
            } catch (e) { console.warn('[Body] face re-fit failed', e); }
        }
    }

    /** Serialize per-body procedural params (so the sliders can re-seed after reload). */
    serializeBodyParams(): { bodyMeshId: string; params: import('./body-generator').BodyParams }[] {
        return [...this._bodyParams.entries()].map(([bodyMeshId, params]) => ({ bodyMeshId, params }));
    }
    /** Restore per-body params on load — the body geometry is already restored as a node, so this just
     *  repopulates the map so a later live edit merges correctly. */
    restoreBodyParams(states: { bodyMeshId: string; params: import('./body-generator').BodyParams }[] | undefined): void {
        if (!states?.length) return;
        for (const st of states) this._bodyParams.set(st.bodyMeshId, st.params);
    }

    // ── Anime face / eye expression system ──────────────────────────────────────
    // A "face decal" — a flat quad skinned 100% to the head joint (so it follows head poses) — shows
    // the active expression's drawn eyes. Each expression is its own paintable RasterTextureManager
    // (transparent background; the textured shader discards a<0.01 so only the eyes show). A blink is
    // just another expression flashed at an interval. See docs/ui/character-creator.md.
    private _faceRigs = new Map<string, FaceRig>();

    /** Get-or-create the face rig for a body mesh; builds the eye decal on first use. Internal. */
    private _ensureRig(bodyMeshId: string): FaceRig | null {
        let rig = this._faceRigs.get(bodyMeshId);
        if (rig) return rig;
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return null;
        const headJointIdx = body.skeleton.data.joints.findIndex(j => j.name === 'head');
        if (headJointIdx < 0) return null;
        const decal = this._buildFaceDecal(body, headJointIdx);
        if (!decal) return null;
        rig = {
            bodyMeshId, skeletonId: body.skeleton.id, headJointIdx, decalMeshId: decal.id,
            expressions: [], textures: new Map(), activeId: null, blinkId: null,
            blink: { ...DEFAULT_BLINK }, faceAspect: this._faceAspect(body, headJointIdx),
            _blinkTimer: null, _holdTimer: null,
        };
        this._faceRigs.set(bodyMeshId, rig);
        return rig;
    }

    /** Public: ensure a body has a face rig (decal). Returns true on success. */
    ensureFace3D(bodyMeshId: string): boolean { return !!this._ensureRig(bodyMeshId); }

    /** Bounding box of the head region (verts weighted mostly to the head joint), in rest/body space. */
    private _headRegionBBox(body: SkinnedMesh3D, headIdx: number): { min: [number,number,number]; max: [number,number,number] } | null {
        const g = body.geometry;
        if (!g || g.vertices.length === 0) return null;
        const v = g.vertices, ji = body.jointIndices, jw = body.jointWeights;
        const n = v.length / 12;
        let mnx=Infinity,mny=Infinity,mnz=Infinity, mxx=-Infinity,mxy=-Infinity,mxz=-Infinity, found=false;
        for (let i = 0; i < n; i++) {
            let w = 0;
            for (let k = 0; k < 4; k++) if (ji[i*4+k] === headIdx) w += jw[i*4+k];
            if (w < 0.5) continue;
            const x=v[i*12], y=v[i*12+1], z=v[i*12+2];
            if (x<mnx)mnx=x; if (y<mny)mny=y; if (z<mnz)mnz=z;
            if (x>mxx)mxx=x; if (y>mxy)mxy=y; if (z>mxz)mxz=z;
            found = true;
        }
        return found ? { min:[mnx,mny,mnz], max:[mxx,mxy,mxz] } : null;
    }

    /** Face-decal width/height (world) — must match the _buildFaceDecal hw/hh ratio. Used to
     *  pre-squish procedural eyes so a round iris renders round on the wide-but-short plane. */
    private _faceAspect(body: SkinnedMesh3D, headIdx: number): number {
        const bb = this._headRegionBBox(body, headIdx);
        if (!bb) return 1;
        const w = (bb.max[0] - bb.min[0]) * 0.95;   // decal width  (see _buildFaceDecal: hX*0.95)
        const h = (bb.max[1] - bb.min[1]) * 0.42;   // decal height (see _buildFaceDecal: hY*0.42)
        return h > 1e-4 ? w / h : 1;
    }

    /** Build the eye decal: a flat quad over the upper face, skinned to the head joint, UNLIT (albedo 0
     *  + emissive 1 → the drawn eyes show at full color), transparent where unpainted. */
    private _buildFaceDecal(body: SkinnedMesh3D, headIdx: number): SkinnedMesh3D | null {
        const bb = this._headRegionBBox(body, headIdx);
        if (!bb) return null;
        const g = body.geometry;
        if (!g) return null;
        const cx = (bb.min[0]+bb.max[0])*0.5;
        const hX = bb.max[0]-bb.min[0], hY = bb.max[1]-bb.min[1], hZ = bb.max[2]-bb.min[2];
        const cy = bb.min[1] + hY*0.55;                      // eye line ~55% up the head (lowered toward the nose for cuter, lower-set features)
        const hcy = (bb.min[1]+bb.max[1])*0.5;               // head vertical centre (for outward normals)
        const cz = (bb.min[2]+bb.max[2])*0.5;                // head centre depth → front-vert filter + outward normals
        const hw = hX*0.95*0.5, hh = hY*0.42*0.5;

        // CONFORM the decal to the face: instead of ONE flat quad pinned at the nose tip, build a grid whose
        // every vertex sits a hair in FRONT of the LOCAL head surface. On the rounded head the surface recedes
        // at the sides, so a flat plane floated the eyes off the face — this hugs it at every angle. UVs stay a
        // flat 0..1 grid, so the front-on draw / procedural-eye workflow (and _faceAspect) is unchanged.
        const vsrc = g.vertices, ji0 = body.jointIndices, jw0 = body.jointWeights, nv = vsrc.length / 12;
        const fX: number[] = [], fY: number[] = [], fZ: number[] = [];
        for (let i = 0; i < nv; i++) {
            let w = 0; for (let k = 0; k < 4; k++) if (ji0[i*4+k] === headIdx) w += jw0[i*4+k];
            if (w < 0.5 || vsrc[i*12+2] <= cz) continue;     // head-weighted FRONT-hemisphere verts (the face)
            fX.push(vsrc[i*12]); fY.push(vsrc[i*12+1]); fZ.push(vsrc[i*12+2]);
        }
        const offset = Math.max(hZ*0.02, 0.001);             // a hair in FRONT of the local surface — tight (closer/flusher) but still clears it so the opaque face can't occlude
        const surfZ = (x: number, y: number): number => {    // LOCAL fit: blend only the 4 nearest front verts (a global
            const ds: { d: number; z: number }[] = [];       // average pulled the decal behind the eye-area surface → hidden)
            for (let i = 0; i < fZ.length; i++) { const dx = fX[i]-x, dy = fY[i]-y; ds.push({ d: dx*dx + dy*dy, z: fZ[i] }); }
            ds.sort((a, b) => a.d - b.d);
            let sw = 0, swz = 0;
            for (let i = 0; i < Math.min(4, ds.length); i++) { const w = 1 / (ds[i].d + 1e-6); sw += w; swz += w * ds[i].z; }
            return sw > 0 ? swz/sw : bb.max[2];
        };
        const NC = 9, NR = 5, out: number[] = [];
        for (let row = 0; row < NR; row++) for (let col = 0; col < NC; col++) {
            const u = col/(NC-1), v = row/(NR-1);            // u: −X→+X · v: top→bottom (matches the old quad)
            const x = cx - hw + u*2*hw, y = cy + hh - v*2*hh;
            const z = surfZ(x, y) + offset;
            const nx = x-cx, ny = y-hcy, nz = z-cz, nl = Math.hypot(nx,ny,nz)||1;   // outward-from-centre normal
            out.push(x, y, z, nx/nl, ny/nl, nz/nl, u, v, 1, 0, 0, 1);
        }
        const idx: number[] = [];
        for (let row = 0; row < NR-1; row++) for (let col = 0; col < NC-1; col++) {
            const a = row*NC+col, b = a+1, c = a+NC, d = c+1;
            idx.push(a, c, d, a, d, b);
        }
        const geometry: MeshGeometry = { vertices: new Float32Array(out), indices: new Uint32Array(idx), format: '12float' };
        const decal = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry });
        decal.name        = 'FaceEyes';
        decal.isFaceDecal = true;
        decal.transformViaSkeleton = true;   // follows the character object transform via the skeleton
        decal.skeletonId  = body.skeletonId;
        decal.skeleton    = body.skeleton;
        const nVerts = NC*NR;                                            // skin arrays MUST match the grid vert count
        const ji = new Uint8Array(nVerts*4), jw = new Float32Array(nVerts*4);
        for (let i = 0; i < nVerts; i++) { ji[i*4] = headIdx; jw[i*4] = 1; }   // every vert 100% on the head joint
        decal.jointIndices = ji;
        decal.jointWeights = jw;
        decal.skinDirty    = true;
        decal.setDiffuseColor(0, 0, 0, 1);                   // albedo 0 → unlit; alpha 1 → texel alpha drives the cutout
        decal.material.emissive    = { r: 1, g: 1, b: 1, a: 1 };
        decal.material.doubleSided = true;
        decal.visible = false;                               // shown once an expression with a texture is active
        this.ctx.sceneGraph.root.addChild(decal);
        this.ctx.emitSceneGraphChanged();
        return decal;
    }

    /** Lazily create an expression's paintable texture, cleared TRANSPARENT (so only drawn eyes show). */
    private _ensureExpressionTexture(rig: FaceRig, exprId: string, size = 1024): RasterTextureManager | null {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return null;
        let mgr = rig.textures.get(exprId);
        const isNew = !mgr;
        if (!mgr) { mgr = new RasterTextureManager(device); rig.textures.set(exprId, mgr); }
        const cur = mgr.getTextureSize();
        const tex = mgr.ensureTexture(cur.w || size, cur.h || size);
        if (isNew) {
            const enc = device.createCommandEncoder();
            enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), clearValue: { r:0,g:0,b:0,a:0 }, loadOp:'clear', storeOp:'store' }] }).end();
            device.queue.submit([enc.finish()]);
        }
        return mgr;
    }

    /** Point the decal's diffuse at an expression's texture (or hide it when there's none). */
    private _applyTexture(rig: FaceRig, exprId: string | null): void {
        const decal = this.getMesh(rig.decalMeshId);
        if (!decal) return;
        const tex = exprId ? (rig.textures.get(exprId)?.getTexture() ?? null) : null;
        decal.diffuseTexture     = tex;
        decal.material.hasTexture = !!tex;
        decal.visible            = !!tex;
        decal.gpuDirty           = true;
        this.ctx.scheduleRender();
    }

    createFaceExpression(bodyMeshId: string, name?: string): string | null {
        const rig = this._ensureRig(bodyMeshId);
        if (!rig) return null;
        const id = 'expr_' + _nanoid();
        const isFirst = rig.expressions.length === 0;
        rig.expressions.push({ id, name: name || `Expression ${rig.expressions.length + 1}`, isBlink: false });
        this._ensureExpressionTexture(rig, id);
        if (isFirst) { rig.activeId = id; this._applyTexture(rig, id); }
        this.ctx.scheduleRender();
        return id;
    }

    deleteFaceExpression(bodyMeshId: string, exprId: string): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return;
        rig.expressions = rig.expressions.filter(e => e.id !== exprId);
        rig.textures.delete(exprId);
        if (rig.blinkId === exprId) { rig.blinkId = null; this._restartBlink(rig); }
        if (rig.activeId === exprId) {
            rig.activeId = rig.expressions.find(e => !e.isBlink)?.id ?? rig.expressions[0]?.id ?? null;
            this._applyTexture(rig, rig.activeId);
        }
        this.ctx.scheduleRender();
    }

    setActiveFaceExpression(bodyMeshId: string, exprId: string): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig || !rig.expressions.some(e => e.id === exprId)) return;
        rig.activeId = exprId;
        this._applyTexture(rig, exprId);
    }

    renameFaceExpression(bodyMeshId: string, exprId: string, name: string): void {
        const e = this._faceRigs.get(bodyMeshId)?.expressions.find(x => x.id === exprId);
        if (e) e.name = name;
    }

    /** Flag which expression is the blink frame (or null to disable blinking). */
    setFaceBlinkExpression(bodyMeshId: string, exprId: string | null): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return;
        for (const e of rig.expressions) e.isBlink = (e.id === exprId);
        rig.blinkId = exprId && rig.expressions.some(e => e.id === exprId) ? exprId : null;
        if (rig.blinkId) this._ensureExpressionTexture(rig, rig.blinkId);
        this._restartBlink(rig);
    }

    setFaceBlinkConfig(bodyMeshId: string, cfg: Partial<FaceBlinkConfig>): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return;
        rig.blink = { ...rig.blink, ...cfg };
        this._restartBlink(rig);
    }

    getFaceExpressions(bodyMeshId: string): { expressions: FaceExpression[]; activeId: string | null; blinkId: string | null; blink: FaceBlinkConfig } | null {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig) return null;
        return { expressions: rig.expressions.map(e => ({ ...e })), activeId: rig.activeId, blinkId: rig.blinkId, blink: { ...rig.blink } };
    }

    getFaceExpressionTextureManager(bodyMeshId: string, exprId: string): RasterTextureManager | null {
        const rig = this._ensureRig(bodyMeshId);
        if (!rig) return null;
        return this._ensureExpressionTexture(rig, exprId);   // ensure it exists (e.g. editing a fresh state)
    }

    /**
     * Render procedural eyes (eye-generator) into an expression's texture via a 2D canvas.
     * `aspect` = decal width/height (eyes are pre-squished so circles stay round). When
     * `params.pixelResolution` is set, eyes are drawn small and upscaled nearest-neighbour for a
     * chunky low-res (PS1/dollcore) look.
     */
    private _renderEyeParamsToTexture(mgr: RasterTextureManager, params: EyeParams, aspect = 1): void {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return;
        const cur = mgr.getTextureSize();
        const W = cur.w || 1024, H = cur.h || 1024;
        const tex = mgr.ensureTexture(W, H);

        const big = document.createElement('canvas');
        big.width = W; big.height = H;
        const bctx = big.getContext('2d');
        if (!bctx) return;

        const px = params.pixelResolution > 0 ? Math.max(16, Math.min(Math.round(params.pixelResolution), Math.min(W, H))) : 0;
        if (px > 0) {
            // Render at low res, then upscale with nearest-neighbour → chunky retro pixels.
            const small = document.createElement('canvas');
            small.width = px; small.height = Math.max(16, Math.round(px * H / W));
            const sctx = small.getContext('2d');
            if (!sctx) return;
            renderEyes(sctx, params, small.width, small.height, aspect);
            bctx.imageSmoothingEnabled = false;
            bctx.clearRect(0, 0, W, H);
            bctx.drawImage(small, 0, 0, small.width, small.height, 0, 0, W, H);
        } else {
            renderEyes(bctx, params, W, H, aspect);
        }
        device.queue.copyExternalImageToTexture({ source: big, flipY: false }, { texture: tex }, [W, H]);
    }

    /** Default procedural-eye params (the "anime girl" preset) for seeding a slider panel. */
    getDefaultEyeParams(): EyeParams { return defaultEyeParams(); }

    /**
     * Fill an expression's eyes from procedural params — the no-drawing path. Stores the params on
     * the expression (so the UI can re-edit via sliders; the baked texture still persists as a PNG)
     * and refreshes the live face. Creates the expression's texture if needed. Call on every slider
     * change for a live preview.
     */
    setFaceExpressionProcedural(bodyMeshId: string, exprId: string, params: EyeParams): void {
        const rig = this._ensureRig(bodyMeshId);
        if (!rig) return;
        const expr = rig.expressions.find(e => e.id === exprId);
        if (!expr) return;
        const mgr = this._ensureExpressionTexture(rig, exprId);
        if (!mgr) return;
        this._renderEyeParamsToTexture(mgr, params, rig.faceAspect);
        expr.eyeParams = params;
        if (rig.activeId === null) rig.activeId = exprId;
        this._applyTexture(rig, rig.activeId);   // refresh decal (gpuDirty + visible); shows live
        this.ctx.scheduleRender();
    }

    /** An expression's procedural params, or null if it was freehand-drawn. */
    getFaceExpressionParams(bodyMeshId: string, exprId: string): EyeParams | null {
        const rig = this._faceRigs.get(bodyMeshId);
        return rig?.expressions.find(e => e.id === exprId)?.eyeParams ?? null;
    }

    /**
     * Point the eyes in a direction — live "look at" for the active procedural expression. x/y are
     * −1..1 (x: +right, y: +down); the lid clips the iris as it nears an edge. Cheap (re-renders the
     * small eye canvas), so it can be driven on cursor/target change. No-op if the active expression
     * is freehand-drawn (baked strokes can't move). The gaze sticks on that expression's params.
     */
    setFaceGaze(bodyMeshId: string, x: number, y: number): void {
        const rig = this._faceRigs.get(bodyMeshId);
        if (!rig || !rig.activeId) return;
        const expr = rig.expressions.find(e => e.id === rig.activeId);
        if (!expr?.eyeParams) return;
        expr.eyeParams.gazeX = Math.max(-1, Math.min(1, x));
        expr.eyeParams.gazeY = Math.max(-1, Math.min(1, y));
        const mgr = this._ensureExpressionTexture(rig, expr.id);
        if (mgr) this._renderEyeParamsToTexture(mgr, expr.eyeParams, rig.faceAspect);
        this._applyTexture(rig, rig.activeId);
        this.ctx.scheduleRender();
    }

    getFaceDecalMeshId(bodyMeshId: string): string | null {
        return this._faceRigs.get(bodyMeshId)?.decalMeshId ?? null;
    }

    /**
     * Aim the orbit camera at the character's face — dead-front, framed to the head — so the 3D
     * view immediately shows the eyes (called when entering eye-draw mode). Frames the REST-pose
     * head (eye editing is normally done in a neutral pose); the user can orbit/zoom afterward.
     * No-op without an orbit controller or a 'head' joint.
     */
    frameFace3D(bodyMeshId: string): boolean {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D)) return false;
        const ctrl = this._orbitController;
        if (!ctrl) return false;
        const headIdx = this._faceRigs.get(bodyMeshId)?.headJointIdx
            ?? body.skeleton?.data.joints.findIndex(j => j.name === 'head') ?? -1;
        if (headIdx < 0) return false;
        const bb = this._headRegionBBox(body, headIdx);
        if (!bb) return false;
        const cam = this.renderer3D.getCamera();
        // Head centre + half-extent in world space (procedural bodies sit at the origin with
        // identity rotation/scale, so local vertex coords + body translation = world).
        const cx = (bb.min[0] + bb.max[0]) * 0.5 + body.x;
        const cy = (bb.min[1] + bb.max[1]) * 0.5 + body.y;
        const cz = (bb.min[2] + bb.max[2]) * 0.5 + body.z;
        const half = Math.max(bb.max[1] - bb.min[1], bb.max[0] - bb.min[0]) * 0.5 * 1.5; // head + margin
        cam.setTarget(cx, cy, cz);
        if (cam.mode === 'orthographic') {
            cam.orthoSize = Math.max(0.05, half);
            ctrl.radius = Math.max(ctrl.radius, half * 4);        // sane standoff (ortho scale = orthoSize)
        } else {
            ctrl.radius = Math.max(0.05, half / Math.tan(Math.max(0.05, cam.fov) * 0.5));
        }
        ctrl.setSpherical(0, 0.06);   // azimuth 0 = front (+Z, the face); a hair above the eye line
        this.ctx.scheduleRender();
        return true;
    }

    // ── Blink driver (setTimeout — no per-frame cost) ──
    private _cancelBlink(rig: FaceRig): void {
        if (rig._blinkTimer) { clearTimeout(rig._blinkTimer); rig._blinkTimer = null; }
        if (rig._holdTimer)  { clearTimeout(rig._holdTimer);  rig._holdTimer  = null; }
    }
    private _restartBlink(rig: FaceRig): void {
        this._cancelBlink(rig);
        if (!rig.blinkId || !rig.textures.has(rig.blinkId)) return;
        const b = rig.blink;
        const wait = b.mode === 'fixed' ? b.minSec : b.minSec + Math.random() * Math.max(0, b.maxSec - b.minSec);
        rig._blinkTimer = setTimeout(() => this._fireBlink(rig), Math.max(200, wait * 1000));
    }
    private _fireBlink(rig: FaceRig): void {
        rig._blinkTimer = null;
        if (!rig.blinkId) return;
        this._applyTexture(rig, rig.blinkId);                // show the blink frame
        rig._holdTimer = setTimeout(() => {
            rig._holdTimer = null;
            this._applyTexture(rig, rig.activeId);           // revert to the active expression
            this._restartBlink(rig);                         // schedule the next blink
        }, Math.max(40, rig.blink.holdMs));
    }

    // ── Face-rig persistence ──
    /** Serialize the face rigs' metadata (textures persist separately as PNGs). */
    serializeFaceRigs(): FaceRigState[] {
        const out: FaceRigState[] = [];
        for (const rig of this._faceRigs.values()) {
            out.push({
                bodyMeshId: rig.bodyMeshId, skeletonId: rig.skeletonId, headJointIdx: rig.headJointIdx,
                decalMeshId: rig.decalMeshId, expressions: rig.expressions.map(e => ({ ...e })),
                activeId: rig.activeId, blinkId: rig.blinkId, blink: { ...rig.blink },
            });
        }
        return out;
    }
    /** Each expression's texture manager (for PNG export on save). Key = `${bodyMeshId}:${exprId}`. */
    getFaceTextureExports(): { key: string; mgr: RasterTextureManager }[] {
        const out: { key: string; mgr: RasterTextureManager }[] = [];
        for (const rig of this._faceRigs.values())
            for (const [exprId, mgr] of rig.textures) out.push({ key: `${rig.bodyMeshId}:${exprId}`, mgr });
        return out;
    }
    /** Rebuild face rigs on load: re-create each decal + expression texture (from PNG blobs keyed
     *  `${bodyMeshId}:${exprId}`), re-apply the active expression, and restart blinking. */
    async restoreFaceRigs(states: FaceRigState[] | undefined, faceBlobs: Map<string, ArrayBuffer>): Promise<void> {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device || !states?.length) return;
        for (const st of states) {
            const body = this.getMesh(st.bodyMeshId);
            if (!(body instanceof SkinnedMesh3D) || !body.skeleton) continue;
            const decal = this._buildFaceDecal(body, st.headJointIdx);
            if (!decal) continue;
            const rig: FaceRig = {
                bodyMeshId: st.bodyMeshId, skeletonId: body.skeleton.id, headJointIdx: st.headJointIdx,
                decalMeshId: decal.id, expressions: st.expressions.map(e => ({ ...e })), textures: new Map(),
                activeId: st.activeId, blinkId: st.blinkId, blink: { ...st.blink },
                faceAspect: this._faceAspect(body, st.headJointIdx), _blinkTimer: null, _holdTimer: null,
            };
            for (const e of rig.expressions) {
                const buf = faceBlobs.get(`${st.bodyMeshId}:${e.id}`);
                const mgr = new RasterTextureManager(device);
                rig.textures.set(e.id, mgr);
                if (buf && buf.byteLength) {
                    try {
                        const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
                        const tex = mgr.ensureTexture(bmp.width, bmp.height);
                        device.queue.copyExternalImageToTexture({ source: bmp, flipY: false }, { texture: tex }, [bmp.width, bmp.height]);
                    } catch (err) { console.warn('[Face] restore texture failed', e.id, err); }
                } else if (e.eyeParams) {
                    this._renderEyeParamsToTexture(mgr, e.eyeParams, rig.faceAspect);   // procedural → regen from params
                } else {
                    this._ensureExpressionTexture(rig, e.id);          // no blob → blank transparent
                }
            }
            this._faceRigs.set(st.bodyMeshId, rig);
            this._applyTexture(rig, rig.activeId);
            this._restartBlink(rig);
        }
        this.ctx.scheduleRender();
    }

    // ── Procedural hair ──────────────────────────────────────────────────────────
    // Chunky low-poly hair (cap + bangs + side locks + tails) skinned 100% to the head joint (follows
    // poses, like the eye decal), shaded by a root→tip gradient texture (uv.v). Params are the source
    // of truth → rebuilt on load. See docs/specs/hair-generation.md.
    /** Set a body's skin tone (hex, e.g. '#e8b89a') — live. Persists via the body mesh's own material
     *  (the body is a normal saved node, so no extra rig is needed). */
    setSkinTone(bodyMeshId: string, hex: string): void {
        const body = this.getMesh(bodyMeshId);
        if (!body) return;
        const c = hexToRgb01(hex);
        body.setDiffuseColor(c.r, c.g, c.b, 1);
        body.gpuDirty = true;
        this.ctx.scheduleRender();
    }
    /** A body's current skin tone as hex ('#rrggbb'), or null if the mesh is missing. */
    getSkinTone(bodyMeshId: string): string | null {
        const d = this.getMesh(bodyMeshId)?.material?.diffuse;
        return d ? rgb01ToHex(d.r, d.g, d.b) : null;
    }

    private _hairRigs = new Map<string, HairRig>();

    /** The default "anime girl" hairstyle params (Twintails) to seed a slider panel. */
    getDefaultHairParams(): HairParams { return { ...DEFAULT_HAIR_PARAMS }; }

    /** A body's current hair params, or null if it has no hair. */
    getHairParams(bodyMeshId: string): HairParams | null {
        return this._hairRigs.get(bodyMeshId)?.params ?? null;
    }

    /** The hair mesh id for a body (for render-style / texture upload), or null if it has no hair. */
    getHairMeshId(bodyMeshId: string): string | null {
        return this._hairRigs.get(bodyMeshId)?.hairMeshId ?? null;
    }
    /** The eyes (face-decal) mesh id for a body, or null if it has no face rig yet. */
    getEyesMeshId(bodyMeshId: string): string | null {
        return this._faceRigs.get(bodyMeshId)?.decalMeshId ?? null;
    }

    /** Re-apply a part's GENERATED look after a user texture override is cleared, so it reverts to its
     *  procedural colour/expression instead of going blank. Handles garments, hair, the eye decal, and
     *  the body (which keeps its flat skin-tone colour once the texture is dropped). */
    reapplyPartColor(meshId: string): void {
        const device = this.ctx.webgpuRenderer.getDevice();
        const mesh = this.getMesh(meshId);
        if (!device || !mesh) return;
        for (const r of this._clothingRigs.values()) if (r.clothingMeshId === meshId) {
            if (mesh instanceof SkinnedMesh3D) r.gradient = this._applyClothingColor(mesh, r.params, r.gradient, device);
            mesh.gpuDirty = true; this.ctx.scheduleRender(); return;
        }
        for (const r of this._hairRigs.values()) if (r.hairMeshId === meshId) {
            const tex = this._renderHairGradient(r.gradient, r.params);
            if (tex) { mesh.diffuseTexture = tex; mesh.material.hasTexture = true; }
            else     { mesh.diffuseTexture = null; mesh.material.hasTexture = false; }
            mesh.gpuDirty = true; this.ctx.scheduleRender(); return;
        }
        for (const r of this._faceRigs.values()) if (r.decalMeshId === meshId) {
            this._applyTexture(r, r.activeId);   // eyes → revert to the active expression
            this.ctx.scheduleRender(); return;
        }
        // Body / other: drop the texture; the flat diffuse colour (e.g. skin tone) remains.
        mesh.diffuseTexture = null; mesh.material.hasTexture = false; mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    /** Build or update a body's procedural hair from params — live (call on each slider change). */
    setHairParams(bodyMeshId: string, params: HairParams): void {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const headIdx = body.skeleton.data.joints.findIndex(j => j.name === 'head');
        if (headIdx < 0) return;
        const bb = this._headRegionBBox(body, headIdx);
        if (!bb) return;
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return;
        const head: HeadFrame = {
            cx: (bb.min[0]+bb.max[0])*0.5, cy: (bb.min[1]+bb.max[1])*0.5, cz: (bb.min[2]+bb.max[2])*0.5,
            rx: (bb.max[0]-bb.min[0])*0.5, ry: (bb.max[1]-bb.min[1])*0.5, rz: (bb.max[2]-bb.min[2])*0.5,
        };
        // Pass the body's rest geometry so the hair shrink-wraps out of it: the cap conforms to the real
        // (non-ellipsoid) head and the tails drape over the shoulders/back instead of clipping through.
        const result = generateHair(head, params, body.geometry?.vertices);
        const skel = body.skeleton;

        // Tear down the PREVIOUS hair's spring rig before rebuilding: drop the trailing spring-tail joints
        // (safe — highest indices, body joints unaffected) and clear this body's spring chains.
        const prevBase = skel.data.joints.findIndex(j => j.name.startsWith('springTail_'));
        if (prevBase >= 0) skel.truncateJoints(prevBase);
        skel.data.springChains = [];
        resetSpringState(skel);

        const rig = this._hairRigs.get(bodyMeshId);
        if (rig) { const old = this.getMesh(rig.hairMeshId); old?.parent?.removeChild(old); }   // rebuild fresh (cheap)
        const gradient = rig?.gradient ?? new RasterTextureManager(device);

        const hair = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry: result.geometry });
        hair.name = 'Hair'; hair.isHair = true; hair.visible = true; hair.transformViaSkeleton = true;
        hair.skeletonId = body.skeletonId; hair.skeleton = skel;
        // Build the skin: cap/bangs/sidelocks stay 100% on the head; each TAIL skins (graduated root→tip) to
        // its own NEW spring-bone chain so it swings dynamically + collides off the body.
        const { ji, jw } = this._buildHairSpringRig(skel, headIdx, head, result);
        this._ensureBodySpringColliders(skel, headIdx, head);
        hair.jointIndices = ji; hair.jointWeights = jw; hair.skinDirty = true;
        hair.material.doubleSided = true;
        hair.setDiffuseColor(1, 1, 1, 1);                                 // white albedo → gradient shows lit
        const tex = this._renderHairGradient(gradient, params);
        if (tex) { hair.diffuseTexture = tex; hair.material.hasTexture = true; }
        hair.gpuDirty = true;
        this.ctx.sceneGraph.root.addChild(hair);
        this.ctx.emitSceneGraphChanged();

        this._hairRigs.set(bodyMeshId, { bodyMeshId, hairMeshId: hair.id, params, gradient });
        this.ctx.scheduleRender();
    }

    /** Build the hair skin: non-tail verts 100% on the head joint; each tail's verts skinned (2-bone, graduated
     *  by uv.v root→tip) to a NEW spring-bone chain appended to the skeleton (root parented to the head). Pushes
     *  one SpringChain per tail. Returns the joint-index/weight arrays for the hair mesh. */
    private _buildHairSpringRig(skel: Skeleton3D, headIdx: number, head: HeadFrame, result: ReturnType<typeof generateHair>): { ji: Uint8Array; jw: Float32Array } {
        const nVerts = result.geometry.vertices.length / 12;
        const ji = new Uint8Array(nVerts * 4), jw = new Float32Array(nVerts * 4);
        for (let i = 0; i < nVerts; i++) { ji[i*4] = headIdx; jw[i*4] = 1; }   // default: 100% head
        if (result.tailBones.length === 0) return { ji, jw };

        // Head REST world (from its inverse-bind) → chain-local maths independent of the current pose. All tail
        // joints inherit the head's bind rotation Rh, so each gets identity localRotation + a pure-translation
        // localPosition, and the chain reproduces the draped tail at rest (skinMatrix = identity).
        const headRest = mat4.invert(mat4.create(), skel.data.joints[headIdx].inverseBindMatrix as unknown as mat4);
        const Rh = mat4.getRotation(quat.create(), headRest);
        const RhInv = quat.invert(quat.create(), Rh);
        const Hp = vec3.fromValues(headRest[12], headRest[13], headRest[14]);

        const tailChains: number[][] = [];
        for (let t = 0; t < result.tailBones.length; t++) {
            const P = result.tailBones[t];
            const chain: number[] = [];
            let parentIdx = headIdx;
            let prev = Hp;
            for (let b = 0; b < P.length; b++) {
                const Pi = vec3.fromValues(P[b][0], P[b][1], P[b][2]);
                const localPos = vec3.transformQuat(vec3.create(), vec3.subtract(vec3.create(), Pi, prev), RhInv);
                const idx = skel.addJoint(parentIdx, [localPos[0], localPos[1], localPos[2]], `springTail_${t}_${b}`);
                const restW = mat4.fromRotationTranslation(mat4.create(), Rh, Pi);   // bind world = compose(Rh, Pᵢ)
                mat4.invert(skel.data.joints[idx].inverseBindMatrix as unknown as mat4, restW);
                chain.push(idx);
                parentIdx = idx; prev = Pi;
            }
            tailChains.push(chain);
            (skel.data.springChains ??= []).push({
                id: crypto.randomUUID(),
                jointIndices: chain,
                stiffness: 0.6, drag: 0.55, gravity: 0.004, gravityDir: [0, -1, 0],
                hitRadius: head.rx * 0.18, enabled: true,
            });
        }
        skel.computeWorldMatrices();   // refresh skinMatrices with the new inverse-binds

        // Weight each tail vertex to its 2 bracketing chain bones by uv.v (root→tip).
        for (let i = 0; i < nVerts; i++) {
            const t = result.tailVertId[i];
            if (t < 0 || t >= tailChains.length) continue;
            const v = Math.max(0, Math.min(1, result.geometry.vertices[i*12 + 7]));
            const f = v * (TAIL_BONES - 1);
            const b0 = Math.min(TAIL_BONES - 1, Math.floor(f)), b1 = Math.min(TAIL_BONES - 1, b0 + 1);
            const w1 = f - b0, ch = tailChains[t];
            ji[i*4] = ch[b0]; jw[i*4] = 1 - w1;
            ji[i*4+1] = ch[b1]; jw[i*4+1] = w1;
        }
        return { ji, jw };
    }

    /** (Re)build the body's default spring colliders the hair tails bounce off — a head sphere + chest and hips
     *  spheres (a rough torso). Radii are relative to the head size; tune / upgrade to body-fit capsules later. */
    private _ensureBodySpringColliders(skel: Skeleton3D, headIdx: number, head: HeadFrame): void {
        const colliders: SpringCollider[] = [];
        const headInvBind = skel.data.joints[headIdx].inverseBindMatrix as unknown as mat4;
        const c = vec3.transformMat4(vec3.create(), vec3.fromValues(head.cx, head.cy, head.cz), headInvBind);   // head centre → head-local
        colliders.push({ jointIdx: headIdx, offset: [c[0], c[1], c[2]], radius: Math.max(head.rx, head.rz) * 1.02 });
        const find = (name: string): number => skel.data.joints.findIndex(j => j.name === name);
        const chest = find('chest'); if (chest >= 0) colliders.push({ jointIdx: chest, offset: [0, 0, 0], radius: head.rx * 1.7 });
        const hips  = find('hips');  if (hips  >= 0) colliders.push({ jointIdx: hips,  offset: [0, 0, 0], radius: head.rx * 1.5 });
        skel.data.springColliders = colliders;
    }

    /** Remove a body's hair. */
    removeHair(bodyMeshId: string): void {
        const rig = this._hairRigs.get(bodyMeshId);
        if (!rig) return;
        const m = this.getMesh(rig.hairMeshId);
        m?.parent?.removeChild(m);
        // Tear down the spring rig: drop the trailing tail joints + this body's spring chains/colliders.
        const body = this.getMesh(bodyMeshId);
        if (body instanceof SkinnedMesh3D && body.skeleton) {
            const skel = body.skeleton;
            const base = skel.data.joints.findIndex(j => j.name.startsWith('springTail_'));
            if (base >= 0) skel.truncateJoints(base);
            skel.data.springChains = [];
            skel.data.springColliders = [];
            resetSpringState(skel);
        }
        this._hairRigs.delete(bodyMeshId);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Render the root→tip gradient into the hair texture (vertical; sampled by the hair's uv.v). */
    private _renderHairGradient(mgr: RasterTextureManager, p: HairParams): GPUTexture | null {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return null;
        const W = 16, H = 256;
        const tex = mgr.ensureTexture(W, H);
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) return null;
        const g = ctx2d.createLinearGradient(0, 0, 0, H);
        const tip = p.gradient ? p.tipColor : p.rootColor;
        g.addColorStop(0, p.rootColor);
        g.addColorStop(Math.max(0, Math.min(1, 1 - p.tipFade)), p.rootColor);
        g.addColorStop(1, tip);
        ctx2d.fillStyle = g; ctx2d.fillRect(0, 0, W, H);
        device.queue.copyExternalImageToTexture({ source: canvas, flipY: false }, { texture: tex }, [W, H]);
        return tex;
    }

    // ── Procedural clothing (top + bottom) ───────────────────────────────────────
    // Low-poly garments skinned to the BODY's skeleton with joint-blend weights (deform with poses).
    // Params are the source of truth → rebuilt on load. See docs/specs/clothing-generation.md.
    private _clothingRigs = new Map<string, ClothingRig>();   // key = `${bodyMeshId}:${slot}`

    /** Default params for a slot (top = pink Tee, bottom = Skirt). */
    getDefaultClothingParams(slot: 'top' | 'bottom'): ClothingParams {
        return slot === 'top' ? defaultTopParams() : defaultBottomParams();
    }

    /** Named presets for a slot (e.g. Top: Tee/Crop/Tank/Long Sleeve; Bottom: Skirt/Mini/Shorts/Pants). */
    getClothingPresetNames(slot: 'top' | 'bottom'): string[] { return clothingPresetNames(slot); }
    /** A named preset bundle to load into the sliders. */
    getClothingPreset(slot: 'top' | 'bottom', name: string): ClothingParams { return clothingPreset(slot, name); }

    /** A body's garment params for a slot, or null if none. */
    getClothingParams(bodyMeshId: string, slot: 'top' | 'bottom'): ClothingParams | null {
        return this._clothingRigs.get(`${bodyMeshId}:${slot}`)?.params ?? null;
    }

    /** Build or update a body's garment for one slot from params — live (call per slider change). */
    setClothingParams(bodyMeshId: string, params: ClothingParams): void {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return;
        const fit = this._buildBodyFit(body);
        if (!fit) return;
        // Migrate/clamp sleeveLength to the continuous 0..1 scale (old saves stored 'none'|'short'|'long'),
        // so the stored + returned params are always a number for Frogmarks's slider.
        if (params.slot === 'top') {
            const raw = (params as TopParams).sleeveLength as number | string;
            const n = normSleeveLength(raw);
            if (raw !== n) params = { ...(params as TopParams), sleeveLength: n };
        }
        const result = params.slot === 'top' ? generateTop(fit, params) : generateBottom(fit, params);

        const key = `${bodyMeshId}:${params.slot}`;
        const rig = this._clothingRigs.get(key);
        if (rig) { const old = this.getMesh(rig.clothingMeshId); old?.parent?.removeChild(old); }   // rebuild fresh

        const mesh = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry: result.geometry });
        mesh.name = params.slot === 'top' ? 'Top' : 'Bottom'; mesh.isClothing = true; mesh.visible = true; mesh.transformViaSkeleton = true;
        mesh.skeletonId = body.skeletonId; mesh.skeleton = body.skeleton;
        mesh.jointIndices = result.jointIndices; mesh.jointWeights = result.jointWeights; mesh.skinDirty = true;
        mesh.material.doubleSided = true;
        const gradient = this._applyClothingColor(mesh, params, rig?.gradient, device);
        mesh.gpuDirty = true;
        this.ctx.sceneGraph.root.addChild(mesh);
        this.ctx.emitSceneGraphChanged();

        this._clothingRigs.set(key, { bodyMeshId, slot: params.slot, clothingMeshId: mesh.id, params, gradient });
        this.ctx.scheduleRender();
    }

    /** Remove a body's garment for one slot. */
    removeClothing(bodyMeshId: string, slot: 'top' | 'bottom'): void {
        const rig = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
        if (!rig) return;
        const m = this.getMesh(rig.clothingMeshId);
        m?.parent?.removeChild(m);
        this._clothingRigs.delete(`${bodyMeshId}:${slot}`);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Serialize the clothing rigs' params (the meshes regenerate from these on load). */
    serializeClothingRigs(): { bodyMeshId: string; slot: 'top' | 'bottom'; params: ClothingParams }[] {
        return [...this._clothingRigs.values()].map(r => ({ bodyMeshId: r.bodyMeshId, slot: r.slot, params: r.params }));
    }
    /** Rebuild garments on load (body + skeleton must already be restored). */
    restoreClothingRigs(states: { bodyMeshId: string; slot: 'top' | 'bottom'; params: ClothingParams }[] | undefined): void {
        if (!states?.length) return;
        for (const st of states) {
            try { this.setClothingParams(st.bodyMeshId, st.params); }
            catch (e) { console.warn('[Clothing] restore failed', st.slot, e); }
        }
    }

    /** If `meshId` is a garment, its STABLE rig key `${bodyMeshId}:${slot}` — used to persist a painted
     *  garment texture (the garment's own mesh id changes every regenerate, so it can't be the key). */
    clothingRigKeyForMesh(meshId: string): string | null {
        for (const r of this._clothingRigs.values()) if (r.clothingMeshId === meshId) return `${r.bodyMeshId}:${r.slot}`;
        return null;
    }
    /** The current garment mesh id for a (body, slot), or null — to re-apply a restored paint texture. */
    getClothingMeshId(bodyMeshId: string, slot: 'top' | 'bottom'): string | null {
        return this._clothingRigs.get(`${bodyMeshId}:${slot}`)?.clothingMeshId ?? null;
    }

    /** Procedural hair params per body (the gradient texture is rebuilt from params on load, so the
     *  hair mesh itself is NOT persisted as a node — it regenerates, exactly like the garments). */
    serializeHairRigs(): { bodyMeshId: string; params: HairParams }[] {
        return [...this._hairRigs.values()].map(r => ({ bodyMeshId: r.bodyMeshId, params: r.params }));
    }
    /** Rebuild hair on load (body + skeleton must already be restored). */
    restoreHairRigs(states: { bodyMeshId: string; params: HairParams }[] | undefined): void {
        if (!states?.length) return;
        for (const st of states) {
            try { this.setHairParams(st.bodyMeshId, st.params); }
            catch (e) { console.warn('[Hair] restore failed', e); }
        }
    }

    /**
     * Bake a body's garment (a slot) to GLB and register it as a kitbash part so it can be swapped
     * onto any character. v1 = a session-local object URL (the GLB bytes aren't yet written to disk —
     * full library persistence is a follow-up). Returns the new part id, or null.
     */
    bakeClothingToPart(bodyMeshId: string, slot: 'top' | 'bottom', name: string): string | null {
        const rig = this._clothingRigs.get(`${bodyMeshId}:${slot}`);
        if (!rig) return null;
        const mesh = this.getMesh(rig.clothingMeshId);
        const body = this.getMesh(bodyMeshId);
        if (!mesh || !(body instanceof SkinnedMesh3D) || !body.skeleton) return null;
        const result = exportSceneToGlb([mesh], [body.skeleton]);
        return this._registerBakedPart('part_' + _nanoid(), slot, name || (slot === 'top' ? 'Top' : 'Bottom'), result.blob);
    }

    /** In-memory store of baked parts (meta + GLB blob) so they can be persisted with the document. */
    private _bakedParts = new Map<string, { meta: KitbashPartMeta; blob: Blob }>();

    /** Register a baked GLB blob as a kitbash part AND remember its bytes so it survives reload. */
    private _registerBakedPart(id: string, slot: CharacterSlot, name: string, blob: Blob): string {
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

    /**
     * Bake a body's procedural hair to GLB and register it as a kitbash 'hair' part so it can be
     * swapped onto any character. Same session-local caveat as bakeClothingToPart (the GLB bytes are
     * an object URL, not yet on disk). Returns the new part id, or null.
     */
    bakeHairToPart(bodyMeshId: string, name: string): string | null {
        const rig = this._hairRigs.get(bodyMeshId);
        if (!rig) return null;
        const mesh = this.getMesh(rig.hairMeshId);
        const body = this.getMesh(bodyMeshId);
        if (!mesh || !(body instanceof SkinnedMesh3D) || !body.skeleton) return null;
        const result = exportSceneToGlb([mesh], [body.skeleton]);
        return this._registerBakedPart('part_' + _nanoid(), 'hair', name || 'Hair', result.blob);
    }

    /** Resolve the body frame for fitting: each joint's rest-pose world position + sampled radius. */
    private _buildBodyFit(body: SkinnedMesh3D): BodyFit | null {
        const skel = body.skeleton, g = body.geometry, ji = body.jointIndices, jw = body.jointWeights;
        if (!skel || !g || !ji || !jw) return null;
        // Rest-pose joint world position = translation of inverse(inverseBindMatrix).
        const idxPos = new Map<number, [number, number, number]>();
        const byName = new Map<string, number>();
        const inv = mat4.create();
        for (const j of skel.data.joints) {
            mat4.invert(inv, j.inverseBindMatrix as unknown as mat4);
            idxPos.set(j.index, [inv[12], inv[13], inv[14]]);
            byName.set(j.name, j.index);
        }
        // Bone direction (toward parent) → perpendicular distance gives the true tube radius.
        const dirByIdx = new Map<number, [number, number, number]>();
        for (const j of skel.data.joints) {
            const me = idxPos.get(j.index)!;
            const par = j.parentIndex >= 0 ? idxPos.get(j.parentIndex) : null;
            let d: [number, number, number] = par ? [me[0]-par[0], me[1]-par[1], me[2]-par[2]] : [0, 1, 0];
            const l = Math.hypot(d[0], d[1], d[2]) || 1; d = [d[0]/l, d[1]/l, d[2]/l];
            dirByIdx.set(j.index, d);
        }
        const dists = new Map<number, number[]>();
        // Per-joint DIRECTIONAL extent: the max body distance in each of GARMENT_RING angular sectors
        // (world XZ) so a torso ring can enclose the body in every direction (no clip) yet still hug it.
        const sectorMax = new Map<number, number[]>();
        // Clean arm radii for sleeves: perp extent bucketed by each vert's DOMINANT arm joint only, so
        // the torso/deltoid junction can't inflate the sleeve cap.
        const armNames = ['shoulder_L', 'shoulder_R', 'lowerarm_L', 'lowerarm_R', 'hand_L', 'hand_R'];
        const armJointIdx = new Set<number>();
        for (const nm of armNames) { const ix = byName.get(nm); if (ix !== undefined) armJointIdx.add(ix); }
        const armBuckets = new Map<number, number[]>();
        const n = g.vertices.length / 12;
        for (let i = 0; i < n; i++) {
            const px = g.vertices[i*12], py = g.vertices[i*12+1], pz = g.vertices[i*12+2];
            let domK = 0, domW = -1;
            for (let k = 0; k < 4; k++) { const wv = jw[i*4+k]; if (wv > domW) { domW = wv; domK = k; } }
            for (let k = 0; k < 4; k++) {
                if (jw[i*4+k] < 0.4) continue;
                const jIdx = ji[i*4+k], jp = idxPos.get(jIdx), d = dirByIdx.get(jIdx);
                if (!jp || !d) continue;
                const rx = px-jp[0], ry = py-jp[1], rz = pz-jp[2];
                const along = rx*d[0] + ry*d[1] + rz*d[2];
                const perp = Math.hypot(rx - d[0]*along, ry - d[1]*along, rz - d[2]*along);
                let arr = dists.get(jIdx); if (!arr) { arr = []; dists.set(jIdx, arr); } arr.push(perp);
                // Directional (XZ) extent → the sector centred on the matching ring vertex.
                const oxz = Math.hypot(rx, rz);
                if (oxz > 1e-5) {
                    let sm = sectorMax.get(jIdx); if (!sm) { sm = new Array(GARMENT_RING).fill(0); sectorMax.set(jIdx, sm); }
                    const sec = ((Math.round(Math.atan2(rz, rx) / (2*Math.PI) * GARMENT_RING) % GARMENT_RING) + GARMENT_RING) % GARMENT_RING;
                    if (oxz > sm[sec]) sm[sec] = oxz;
                }
                // Arm radius: only from verts this arm joint dominates (excludes the torso).
                if (k === domK && armJointIdx.has(jIdx)) {
                    let ab = armBuckets.get(jIdx); if (!ab) { ab = []; armBuckets.set(jIdx, ab); } ab.push(perp);
                }
            }
        }
        const pct = (arr: number[] | undefined, q: number, fallback: number): number => {
            if (!arr || !arr.length) return fallback;
            arr.sort((a, b) => a - b);
            return arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] || fallback;
        };
        const radiusOf = (idx: number): number => pct(dists.get(idx), 0.9, 0.05);   // ~max (was 0.7) so the garment encloses the body
        // Circumscribe factor: an N-gon ring at radius r only reaches r·cos(π/N) at the chord midpoint;
        // inflate so the flat chords (not just the vertices) clear the body.
        const OCT = 1 / Math.cos(Math.PI / GARMENT_RING);
        const dirRadiiOf = (idx: number): number[] => {
            const sm = sectorMax.get(idx), scalar = radiusOf(idx);
            const out = new Array<number>(GARMENT_RING);
            for (let k = 0; k < GARMENT_RING; k++) out[k] = ((sm && sm[k] > 0) ? sm[k] : scalar) * OCT;
            return out;
        };
        const joints: Record<string, JointFit | undefined> = {};
        for (const [name, idx] of byName) joints[name] = { idx, pos: idxPos.get(idx)!, radius: radiusOf(idx), radii: dirRadiiOf(idx) };
        // Per-side arm radii (near-max of the clean buckets) for the sleeves; fall back to elbow-relative.
        const arms: { L?: ArmFit; R?: ArmFit } = {};
        for (const s of ['L', 'R'] as const) {
            const shI = byName.get('shoulder_' + s), loI = byName.get('lowerarm_' + s), haI = byName.get('hand_' + s);
            if (shI === undefined || loI === undefined) continue;
            const elbow = radiusOf(loI);
            arms[s] = {
                // 70th pct (not 95th) → the TYPICAL arm radius, not the widest socket/elbow outliers, so
                // sleeves hug instead of floating. Wrist tapers from the elbow (NOT the hand bucket, which
                // is the wide palm/fingers → ballooned forearm sleeves). The shrink-wrap pass conforms any
                // residual; the buildSleeves clamp still caps the deltoid.
                capR:   pct(armBuckets.get(shI), 0.70, elbow * 1.2),
                elbowR: pct(armBuckets.get(loI), 0.70, elbow),
                wristR: elbow * 0.72,
            };
        }
        // The body mesh itself → the generator's final shrink-wrap + weight-transfer fit pass.
        // Arm surface = the generator's actual arm rings → the sleeve is built as these OFFSET outward, so
        // it follows the real shoulder/armpit. Cached on create/regen; recompute for loaded bodies (sync).
        let armSurface = this._bodyArmSurface.get(body.id);
        if (!armSurface) {
            const bp = this._bodyParams.get(body.id);
            if (bp) { armSurface = generateBodyResult(bp).armSurface; this._bodyArmSurface.set(body.id, armSurface); }
        }
        return { joints, arms, body: { verts: g.vertices, ji, jw }, armSurface };
    }

    /** Flat base colour, or a base→trim vertical gradient texture (uv.v) when params.gradient. */
    private _applyClothingColor(mesh: SkinnedMesh3D, params: ClothingParams, existing: RasterTextureManager | undefined, device: GPUDevice): RasterTextureManager | undefined {
        const base = hexToRgb01(params.baseColor);
        // A garment's uv.v runs 0→1 from one open edge to the other, so a crisp trim band at BOTH ends
        // lands trim on every opening at once: top = hem + collar; sleeves = (hidden shoulder) + cuff;
        // legs = (hidden waist) + ankle cuff. `gradient` instead does the old soft base→trim fade.
        const hasTrim = params.trimWidth > 0.001 && !!params.trimColor && params.trimColor !== params.baseColor;
        if (!params.gradient && !hasTrim) {
            mesh.diffuseTexture = null; mesh.material.hasTexture = false;
            mesh.setDiffuseColor(base.r, base.g, base.b, 1);
            return undefined;
        }
        const mgr = existing ?? new RasterTextureManager(device);
        const W = 16, H = 128;
        const tex = mgr.ensureTexture(W, H);
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const c2d = canvas.getContext('2d');
        if (c2d) {
            this._drawGarmentColorCanvas(c2d, W, H, params);
            device.queue.copyExternalImageToTexture({ source: canvas, flipY: false }, { texture: tex }, [W, H]);
            mesh.diffuseTexture = tex; mesh.material.hasTexture = true;
            mesh.setDiffuseColor(1, 1, 1, 1);
        }
        return mgr;
    }

    /** Draw a garment's flat base + crisp trim band (or base→trim gradient) into a 2D canvas. Shared by
     *  the live colour texture AND the paint-canvas seed, so they stay identical. v=0/1 = the openings. */
    private _drawGarmentColorCanvas(c2d: CanvasRenderingContext2D, W: number, H: number, params: ClothingParams): void {
        if (params.gradient) {
            const grad = c2d.createLinearGradient(0, 0, 0, H);
            grad.addColorStop(0, params.baseColor);
            grad.addColorStop(Math.max(0, 1 - params.trimWidth), params.baseColor);
            grad.addColorStop(1, params.trimColor);
            c2d.fillStyle = grad; c2d.fillRect(0, 0, W, H);
        } else {
            c2d.fillStyle = params.baseColor; c2d.fillRect(0, 0, W, H);
            const hasTrim = params.trimWidth > 0.001 && !!params.trimColor && params.trimColor !== params.baseColor;
            if (hasTrim) {
                const bandPx = Math.max(1, Math.round(H * Math.min(0.45, params.trimWidth)));
                c2d.fillStyle = params.trimColor;
                c2d.fillRect(0, 0, W, bandPx);            // v=0 edge (hem / cuff)
                c2d.fillRect(0, H - bandPx, W, bandPx);   // v=1 edge (collar / cuff)
            }
        }
    }

    /** Seed a garment's paint canvas with its CURRENT base+trim colour, so entering UV paint starts from
     *  the garment's look (not blank white) and the user paints on top. Returns false if not a garment. */
    seedGarmentPaintTexture(meshId: string, mgr: RasterTextureManager): boolean {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return false;
        let params: ClothingParams | undefined;
        for (const r of this._clothingRigs.values()) if (r.clothingMeshId === meshId) { params = r.params; break; }
        if (!params) return false;
        const tex = mgr.getTexture();
        if (!tex) return false;
        const sz = mgr.getTextureSize();
        const W = Math.max(1, sz.w), H = Math.max(1, sz.h);
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const c2d = canvas.getContext('2d');
        if (!c2d) return false;
        this._drawGarmentColorCanvas(c2d, W, H, params);
        device.queue.copyExternalImageToTexture({ source: canvas, flipY: false }, { texture: tex }, [W, H]);
        return true;
    }

    /**
     * Live GHOST preview of a procedural body — call on every param/slider change to show a
     * translucent hologram that updates instantly, BEFORE committing with createProceduralBody3D.
     * Reuses GhostPreviewRenderer (no scene node, no undo/selection churn). Rest-pose geometry
     * (no skinning needed for a preview). Clear with clearProceduralBodyPreview().
     */
    async previewProceduralBody3D(params?: Partial<import('./body-generator').BodyParams>): Promise<void> {
        const { generateBodyResult } = await import('./body-generator');
        const geom = generateBodyResult(params).geometry;
        this.renderer3D.setGhostPreviewData({
            vertices: geom.vertices,
            indices: geom.indices,
            instances: [{ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }],
            alpha: 0.55,
        });
        this.ctx.scheduleRender();
    }

    /** Hide the procedural-body ghost preview. */
    clearProceduralBodyPreview(): void {
        this.renderer3D.setGhostPreviewData(null);
        this.ctx.scheduleRender();
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
                this._modelStore.delete(oldMeshId);
            }
            charData.partMeshIds.delete(slot);
        }

        // Load and attach the new part.
        const partBuf     = await this._fetchGlbBuffer(partMeta.glbUrl);
        const partResults = await parseSkinnedGLB(partBuf);
        const partResult  = partResults[0];
        if (!partResult) { console.warn(`KitbashAssembler: GLB for ${partId} has no skinned mesh`); return; }

        this._remapJointIndices(partResult, skeleton);
        const mesh = await this._createSkinnedMeshForSlot(
            partResult, skeleton,
            charData.definition.slots[slot] !== undefined ? 0 : 0, 0, 0,
            charData.definition, slot,
        );
        this.ctx.sceneGraph.root.addChild(mesh);
        this._modelStore.set(mesh.id, partBuf);

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

    // ── Private character assembly helpers ────────────────────────────

    private async _fetchGlbBuffer(url: string): Promise<ArrayBuffer> {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`KitbashAssembler: failed to fetch ${url} (${res.status})`);
        return res.arrayBuffer();
    }

    private async _createSkeletonFromResult(
        result: import('../../renderer/3d/gltf-importer').GltfSkinnedResult,
    ): Promise<Skeleton3D> {
        const skin = result.skinning;
        const jointCount = skin.jointNames.length;
        const joints: Joint3D[] = [];
        for (let ji = 0; ji < jointCount; ji++) {
            const ibm = new Float32Array(
                skin.inverseBindMatrices.buffer,
                skin.inverseBindMatrices.byteOffset + ji * 64,
                16,
            );
            const t = skin.jointLocalPositions.subarray(ji * 3, ji * 3 + 3);
            const q = skin.jointLocalRotations.subarray(ji * 4, ji * 4 + 4);
            const s = skin.jointLocalScales.subarray(ji * 3, ji * 3 + 3);
            joints.push({
                index:            ji,
                name:             skin.jointNames[ji],
                parentIndex:      skin.jointParents[ji],
                children:         [],
                localPosition:    [t[0], t[1], t[2]],
                localRotation:    [q[0], q[1], q[2], q[3]],
                localScale:       [s[0], s[1], s[2]],
                tailOffset:       [0, 0.3, 0],
                worldMatrix:      new Float32Array(16),
                inverseBindMatrix: new Float32Array(ibm),
            });
        }
        for (const j of joints) {
            if (j.parentIndex >= 0) joints[j.parentIndex].children.push(j.index);
        }
        const skelData: SkeletonData = { name: skin.skinName, joints };
        const skeleton = new Skeleton3D(skelData);
        skeleton.name  = skin.skinName;
        this.ctx.sceneGraph.root.addChild(skeleton);
        return skeleton;
    }

    private async _createSkinnedMeshForSlot(
        result: import('../../renderer/3d/gltf-importer').GltfSkinnedResult,
        skeleton: Skeleton3D,
        ox: number, oy: number, oz: number,
        def: CharacterDefinition,
        slot: CharacterSlot,
    ): Promise<SkinnedMesh3D> {
        const device = this.ctx.webgpuRenderer.getDevice();
        const mesh   = new SkinnedMesh3D(
            this.ctx.interactionService,
            ox + result.position[0],
            oy + result.position[1],
            oz + result.position[2],
            { primitive: 'custom', geometry: result.geometry },
        );
        mesh.name         = `${def.name}_${slot}`;
        mesh.skeletonId   = skeleton.id;
        mesh.skeleton     = skeleton;
        mesh.jointIndices = result.skinning.jointIndices.slice();
        mesh.jointWeights = result.skinning.jointWeights.slice();
        mesh.skinDirty    = true;
        mesh.setRotation3D(result.rotation[0], result.rotation[1], result.rotation[2]);
        mesh.setScale3D(result.scale[0], result.scale[1], result.scale[2]);
        mesh.setDiffuseColor(
            result.diffuseColor[0], result.diffuseColor[1],
            result.diffuseColor[2], result.diffuseColor[3],
        );
        if (result.diffuseImage && device) {
            const tex = device.createTexture({
                size:   [result.diffuseImage.width, result.diffuseImage.height, 1],
                format: 'rgba8unorm',
                usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            });
            device.queue.copyExternalImageToTexture(
                { source: result.diffuseImage },
                { texture: tex },
                [result.diffuseImage.width, result.diffuseImage.height],
            );
            mesh.diffuseTexture      = tex;
            mesh.material.hasTexture = true;
        }
        return mesh;
    }

    /**
     * Remap a part mesh's JOINTS_0 indices from its local joint array to the
     * canonical skeleton's joint array, matching by joint name.
     */
    private _remapJointIndices(
        partResult: import('../../renderer/3d/gltf-importer').GltfSkinnedResult,
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
            if (m) { m.parent?.removeChild(m); this._modelStore.delete(meshId); }
        }
        const skel = this.getSkeleton(charData.skeletonId);
        if (skel) skel.parent?.removeChild(skel);
    }

    // ── Grease Pencil 3D (Phase C) ────────────────────────────────────

    /** Create a new GpObject3D in the scene and return its ID. */
    createGpObject(name = 'GP Object', skeletonId?: string): string {
        const gpObj = new GpObject3D(this.ctx.interactionService);
        gpObj.name       = name;
        gpObj.skeletonId = skeletonId;
        gpObj.addLayer('Layer 1');
        this.ctx.sceneGraph.root.addChild(gpObj);
        this._gpObjects.set(gpObj.id, gpObj);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return gpObj.id;
    }

    /** Remove a GpObject3D from the scene. */
    removeGpObject(gpId: string): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.parent?.removeChild(gpObj);
        this._gpObjects.delete(gpId);
        if (this._gpActiveStroke?.gpId === gpId) this._gpActiveStroke = null;
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    getGpObject(gpId: string): GpObject3D | null {
        return this._gpObjects.get(gpId) ?? null;
    }

    getAllGpObjects(): GpObject3D[] {
        return [...this._gpObjects.values()];
    }

    /** Add a layer to a GpObject3D. Returns the new layer ID. */
    addGpLayer(gpId: string, name = 'Layer'): string {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return '';
        const layerId = gpObj.addLayer(name);
        this.ctx.scheduleRender();
        return layerId;
    }

    /** Remove a layer from a GpObject3D. */
    removeGpLayer(gpId: string, layerId: string): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.removeLayer(layerId);
        this.ctx.scheduleRender();
    }

    /**
     * Begin a new stroke on a layer. Returns the strokeId.
     * Call addGpPoint() repeatedly, then endGpStroke().
     */
    beginGpStroke(
        gpId: string,
        layerId: string,
        color: { r: number; g: number; b: number; a: number },
        baseWidth: number,
        options?: { fillColor?: { r: number; g: number; b: number; a: number }; parentJoint?: string; closed?: boolean; frame?: number },
    ): string {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return '';

        // If a stroke is already open, close it first.
        if (this._gpActiveStroke) this.endGpStroke();

        const strokeId = gpObj.addStroke(layerId, {
            points:     [],
            color,
            baseWidth,
            fillColor:   options?.fillColor,
            parentJoint: options?.parentJoint,
            closed:      options?.closed ?? false,
        });

        // For keyframe strokes, add to keyframe list instead.
        if (options?.frame !== undefined) {
            gpObj.setKeyframe(layerId, options.frame);
        }

        this._gpActiveStroke = { gpId, layerId, strokeId };
        return strokeId;
    }

    /** Add a point to the currently active GP stroke. */
    addGpPoint(x: number, y: number, z: number, pressure = 1, opacity = 1): void {
        if (!this._gpActiveStroke) return;
        const { gpId, layerId, strokeId } = this._gpActiveStroke;
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        const layer = gpObj.getLayer(layerId);
        if (!layer) return;
        const stroke = layer.strokes.find(s => s.id === strokeId);
        if (!stroke) return;
        stroke.points.push({ x, y, z, pressure, opacity });
        this.ctx.scheduleRender();
    }

    /** Finalize the active GP stroke. Strokes with < 2 points are discarded. */
    endGpStroke(): void {
        if (!this._gpActiveStroke) return;
        const { gpId, layerId, strokeId } = this._gpActiveStroke;
        this._gpActiveStroke = null;
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        const layer = gpObj.getLayer(layerId);
        if (!layer) return;
        const stroke = layer.strokes.find(s => s.id === strokeId);
        if (stroke && stroke.points.length < 2) {
            gpObj.removeStroke(layerId, strokeId);
        }
        this.ctx.scheduleRender();
    }

    /**
     * Erase GP strokes within `radius` world units of `worldPos` on a layer.
     * Pass `frame` to erase from a keyframe instead of base strokes.
     */
    eraseGpStrokes(gpId: string, layerId: string, worldPos: [number, number, number], radius: number, frame?: number): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.eraseStrokes(layerId, worldPos, radius, frame);
        this.ctx.scheduleRender();
    }

    /** Snapshot the current base strokes of a layer as a keyframe. */
    setGpKeyframe(gpId: string, layerId: string, frame: number): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.setKeyframe(layerId, frame);
    }

    /** Remove the keyframe snapshot at frame N for a layer. */
    clearGpKeyframe(gpId: string, layerId: string, frame: number): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.clearKeyframe(layerId, frame);
    }

    /** Set draw order for a GP object within the GP pass. 0 = default; negative = background. */
    setGpRenderOrder(gpId: string, order: number): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.renderOrder = order;
        this.ctx.scheduleRender();
    }

    /** List all GP objects as plain descriptors (safe to pass to Frogmarks). */
    getAllGpObjectDescriptors(): { id: string; name: string; skeletonId?: string }[] {
        return [...this._gpObjects.values()].map(g => ({
            id: g.id,
            name: g.name,
            ...(g.skeletonId ? { skeletonId: g.skeletonId } : {}),
        }));
    }

    /** List all layers for a GP object. */
    getGpLayers(gpId: string): { id: string; name: string; visible: boolean; opacity: number }[] {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return [];
        return gpObj.layers.map(l => ({ id: l.id, name: l.name, visible: l.visible, opacity: l.opacity }));
    }

    /** Show or hide a GP layer. */
    setGpLayerVisible(gpId: string, layerId: string, visible: boolean): void {
        const layer = this._gpObjects.get(gpId)?.getLayer(layerId);
        if (!layer) return;
        layer.visible = visible;
        this.ctx.scheduleRender();
    }

    /** Set the opacity of a GP layer (0–1). */
    setGpLayerOpacity(gpId: string, layerId: string, opacity: number): void {
        const layer = this._gpObjects.get(gpId)?.getLayer(layerId);
        if (!layer) return;
        layer.opacity = Math.max(0, Math.min(1, opacity));
        this.ctx.scheduleRender();
    }

    /** Rename a GP object. */
    renameGpObject(gpId: string, name: string): void {
        const gpObj = this._gpObjects.get(gpId);
        if (!gpObj) return;
        gpObj.name = name;
        this.ctx.emitSceneGraphChanged();
    }

    /** Rename a layer within a GP object. */
    renameGpLayer(gpId: string, layerId: string, name: string): void {
        const layer = this._gpObjects.get(gpId)?.getLayer(layerId);
        if (!layer) return;
        layer.name = name;
        this.ctx.emitSceneGraphChanged();
    }

    // ── GP draw mode ──────────────────────────────────────────────────

    /**
     * Enter GP draw (or erase) mode. Canvas pointer events are hooked automatically.
     * On pointerdown the engine begins a stroke; on pointermove it adds world-space
     * points (snapping to mesh surfaces when available); on pointerup it finalises.
     *
     * @param gpId      Target GP object ID.
     * @param layerId   Target layer ID within that GP object.
     * @param opts      Stroke settings — all optional, override via setGpDrawSettings().
     */
    // ── GP face-select mode ───────────────────────────────────────────

    /** Enter face-select mode: hover shows face highlight, click locks drawing plane. */
    enterGpFaceSelectMode(): void {
        this.exitGpFaceSelectMode();
        this._gpFaceSelectActive = true;
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;

        const onMove = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            const hit = this.pickFromClient3D(e.clientX, e.clientY, rect);
            const prev = this._gpHoveredFace;
            this._gpHoveredFace = hit ? { meshId: hit.meshId, triangleIndex: hit.triangleIndex } : null;
            if (prev?.triangleIndex !== this._gpHoveredFace?.triangleIndex ||
                prev?.meshId       !== this._gpHoveredFace?.meshId) {
                this._pushGpOverlay();
                this.ctx.scheduleRender();
            }
        };

        const onClick = (e: PointerEvent) => {
            if (e.button !== 0) return;
            const rect = canvas.getBoundingClientRect();
            const hit = this.pickFromClient3D(e.clientX, e.clientY, rect);
            if (!hit) {
                this._gpDrawPlane = null;
                this._pushGpOverlay();
                this.ctx.scheduleRender();
                return;
            }
            const [px, py, pz] = hit.hitPoint;
            const [nx, ny, nz] = hit.faceNormal;
            // Compute face radius: max distance from centroid to any triangle vertex.
            const mesh = this.getMesh(hit.meshId);
            let faceRadius = 0.1;
            if (mesh?.geometry) {
                const geom = mesh.geometry;
                const stride = 12; // FLOATS_PER_VERT
                const idx3 = hit.triangleIndex * 3;
                for (let k = 0; k < 3; k++) {
                    const vi = geom.indices[idx3 + k] * stride;
                    // Transform vertex to world space
                    const lx = geom.vertices[vi], ly = geom.vertices[vi+1], lz = geom.vertices[vi+2];
                    const m = mesh.localMatrix as Float32Array;
                    const wx = m[0]*lx + m[4]*ly + m[8]*lz  + m[12];
                    const wy = m[1]*lx + m[5]*ly + m[9]*lz  + m[13];
                    const wz = m[2]*lx + m[6]*ly + m[10]*lz + m[14];
                    const dx = wx - px, dy = wy - py, dz = wz - pz;
                    faceRadius = Math.max(faceRadius, Math.sqrt(dx*dx + dy*dy + dz*dz));
                }
            }
            // Default offset scales with the face so strokes clear the surface on
            // meshes of any size — a fixed 0.003 z-fought / hid behind the surface on
            // larger meshes. Reuse the user's tuned offset if a plane was already locked.
            const offset = this._gpDrawPlane?.offset ?? Math.max(0.012, faceRadius * 0.08);
            this._gpDrawPlane = {
                faceCenter:    [px, py, pz],
                point:         [px + nx * offset, py + ny * offset, pz + nz * offset],
                normal:        [nx, ny, nz],
                meshId:        hit.meshId,
                triangleIndex: hit.triangleIndex,
                faceRadius,
                offset,
            };
            this._pushGpOverlay();
            this.ctx.scheduleRender();
        };

        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerdown', onClick, { capture: true });
        this._gpFaceSelectCleanup = () => {
            canvas.removeEventListener('pointermove', onMove);
            canvas.removeEventListener('pointerdown', onClick, { capture: true } as any);
        };
    }

    /** Exit face-select mode (does NOT clear the locked plane). */
    exitGpFaceSelectMode(): void {
        if (!this._gpFaceSelectActive) return;
        this._gpFaceSelectCleanup?.();
        this._gpFaceSelectCleanup = undefined;
        this._gpFaceSelectActive = false;
        this._gpHoveredFace = null;
        this._pushGpOverlay();
    }

    /** Update the offset on the currently locked plane and re-project the draw point. */
    setGpDrawPlaneOffset(offset: number): void {
        if (!this._gpDrawPlane) return;
        const p = this._gpDrawPlane;
        p.offset = offset;
        const [cx, cy, cz] = p.faceCenter;
        const [nx, ny, nz] = p.normal;
        p.point = [cx + nx * offset, cy + ny * offset, cz + nz * offset];
        this._pushGpOverlay();
        this.ctx.scheduleRender();
    }

    /** Clear the locked drawing plane. */
    clearGpDrawPlane(): void {
        this._gpDrawPlane = null;
        this._pushGpOverlay();
        this.ctx.scheduleRender();
    }

    /** Read back the current drawing plane (for UI). */
    getGpDrawPlane(): { meshId: string; triangleIndex: number; offset: number } | null {
        if (!this._gpDrawPlane) return null;
        return {
            meshId:        this._gpDrawPlane.meshId,
            triangleIndex: this._gpDrawPlane.triangleIndex,
            offset:        this._gpDrawPlane.offset,
        };
    }

    /** Push current hovered-face + draw-plane data to the WebGPU renderer for overlay drawing. */
    private _pushGpOverlay(): void {
        const renderer = this.ctx.webgpuRenderer as any;
        if (typeof renderer.setGpDrawOverlay !== 'function') return;

        // Hovered face: compute 3 world-space triangle vertices
        let hoveredTri: [number, number, number, number, number, number, number, number, number] | null = null;
        if (this._gpHoveredFace) {
            const mesh = this.getMesh(this._gpHoveredFace.meshId);
            if (mesh?.geometry) {
                const geom = mesh.geometry;
                const stride = 12;
                const idx3 = this._gpHoveredFace.triangleIndex * 3;
                const m = mesh.localMatrix as Float32Array;
                const verts: number[] = [];
                for (let k = 0; k < 3; k++) {
                    const vi = geom.indices[idx3 + k] * stride;
                    const lx = geom.vertices[vi], ly = geom.vertices[vi+1], lz = geom.vertices[vi+2];
                    verts.push(
                        m[0]*lx + m[4]*ly + m[8]*lz  + m[12],
                        m[1]*lx + m[5]*ly + m[9]*lz  + m[13],
                        m[2]*lx + m[6]*ly + m[10]*lz + m[14],
                    );
                }
                hoveredTri = verts as any;
            }
        }

        // Draw plane: 4 quad corners aligned with the plane
        let planeQuad: {
            corners: [[number,number,number],[number,number,number],[number,number,number],[number,number,number]];
            fillColor:   [number, number, number, number];
            borderColor: [number, number, number, number];
        } | null = null;
        if (this._gpDrawPlane) {
            const p = this._gpDrawPlane;
            const [nx, ny, nz] = p.normal;
            // Build two orthonormal basis vectors in the plane
            const upX = Math.abs(ny) < 0.9 ? 0 : 1;
            const upY = Math.abs(ny) < 0.9 ? 1 : 0;
            const upZ = 0;
            // U = normalize(cross(normal, up))
            let ux = ny*upZ - nz*upY, uy = nz*upX - nx*upZ, uz = nx*upY - ny*upX;
            const ul = Math.sqrt(ux*ux + uy*uy + uz*uz) || 1;
            ux /= ul; uy /= ul; uz /= ul;
            // V = cross(normal, U)
            const vx = ny*uz - nz*uy, vy = nz*ux - nx*uz, vz = nx*uy - ny*ux;
            const ext = p.faceRadius * 1.5;
            const [cx, cy, cz] = p.point;
            const c = this._gpDrawColor;
            planeQuad = {
                corners: [
                    [cx + ext*ux + ext*vx, cy + ext*uy + ext*vy, cz + ext*uz + ext*vz],
                    [cx - ext*ux + ext*vx, cy - ext*uy + ext*vy, cz - ext*uz + ext*vz],
                    [cx - ext*ux - ext*vx, cy - ext*uy - ext*vy, cz - ext*uz - ext*vz],
                    [cx + ext*ux - ext*vx, cy + ext*uy - ext*vy, cz + ext*uz - ext*vz],
                ],
                fillColor:   [c.r, c.g, c.b, 0.28],
                borderColor: [c.r, c.g, c.b, 0.90],
            };
        }

        renderer.setGpDrawOverlay({ hoveredTri, planeQuad });
    }

    // ── GP draw mode ──────────────────────────────────────────────────

    enterGpDrawMode(
        gpId: string,
        layerId: string,
        opts?: {
            mode?: 'draw' | 'erase';
            color?: { r: number; g: number; b: number; a: number };
            baseWidth?: number;
            fillColor?: { r: number; g: number; b: number; a: number } | null;
            parentJoint?: string | null;
            closed?: boolean;
            eraseRadius?: number;
            depth?: number;
            depthMode?: 'surface' | 'fixed';
        },
    ): void {
        this.exitGpDrawMode();
        // Never let face-select and draw input be live at once — both register
        // capture-phase pointerdown listeners, so a single click would re-pick the
        // plane AND start a stroke. Exiting here makes the modes mutually exclusive
        // regardless of caller ordering.
        this.exitGpFaceSelectMode();
        if (!this._gpObjects.get(gpId)) return;
        this._gpDrawGpId = gpId;
        this._gpDrawLayerId = layerId;
        this._gpDrawActive = true;
        if (opts) this._applyGpDrawOpts(opts);
        // Suppress transform gizmo and box-select so left-drag is free for drawing.
        this._gpDrawSavedGizmoMode = this._transformController?.mode ?? 'move';
        this.setGizmoMode(null);
        this.ctx.interactionService.suppressBoxSelect = true;
        this._setupGpDrawListeners();
    }

    /** Exit GP draw mode and clean up canvas listeners. */
    exitGpDrawMode(): void {
        if (!this._gpDrawActive) return;
        // Finalise any open stroke.
        if (this._gpDrawPointerDown) {
            this.endGpStroke();
            this._gpDrawPointerDown = false;
        }
        this._gpDrawListenerCleanup?.();
        this._gpDrawListenerCleanup = undefined;
        this._gpDrawActive = false;
        this._gpDrawGpId = null;
        this._gpDrawLayerId = null;
        // Restore gizmo and interaction state saved on entry.
        if (this._gpDrawSavedGizmoMode !== undefined) {
            this.setGizmoMode(this._gpDrawSavedGizmoMode);
            this._gpDrawSavedGizmoMode = undefined;
        }
        this.ctx.interactionService.suppressBoxSelect = false;
    }

    /** Whether GP draw mode is currently active. */
    isGpDrawModeActive(): boolean { return this._gpDrawActive; }

    /** Whether GP face-select mode is currently active. */
    isGpFaceSelectActive(): boolean { return this._gpFaceSelectActive; }

    // ── 3D surface painting ───────────────────────────────────────────────────

    /**
     * Map a 3D-canvas pixel to a UV [0,1] coordinate on `mesh` by raycasting and
     * interpolating the hit triangle's vertex UVs with the pick's barycentric
     * weights. Returns null when the ray misses the mesh or it has no UVs.
     */
    private _screenToMeshUV(px: number, py: number, w: number, h: number, mesh: Mesh3D): { u: number; v: number } | null {
        const geom = mesh.geometry;
        if (!geom?.vertices || !geom.indices) return null;
        const camera = this.renderer3D.getCamera();
        const hit = this._picker.pickMesh(px, py, w, h, camera, [mesh]);
        if (!hit || hit.mesh.id !== mesh.id) return null;
        const stride = 12; // FLOATS_PER_VERT; UV at offset 6,7
        const tri3 = hit.triangleIndex * 3;
        const i0 = geom.indices[tri3 + 0], i1 = geom.indices[tri3 + 1], i2 = geom.indices[tri3 + 2];
        const u0 = geom.vertices[i0 * stride + 6], v0 = geom.vertices[i0 * stride + 7];
        const u1 = geom.vertices[i1 * stride + 6], v1 = geom.vertices[i1 * stride + 7];
        const u2 = geom.vertices[i2 * stride + 6], v2 = geom.vertices[i2 * stride + 7];
        const w0 = 1 - hit.baryU - hit.baryV; // weight of indices[tri3+0]
        return {
            u: w0 * u0 + hit.baryU * u1 + hit.baryV * u2,
            v: w0 * v0 + hit.baryU * v1 + hit.baryV * v2,
        };
    }

    /**
     * Enter 3D surface-paint input for `meshId`: left-drag on the mesh in the
     * viewport raycasts to a UV coord and calls `handlers` (the UVPaintController's
     * stroke API). Alt-drag (orbit) and middle/right (pan) pass through. The host
     * (ShapeManager) calls this alongside the UV-pane paint controller so a stroke
     * on either view paints the same texture.
     */
    enterSurfacePaintInput(meshId: string, handlers: { begin: (u: number, v: number, p: number) => void; move: (u: number, v: number, p: number) => void; end: () => void; hover?: (uv: [number, number] | null) => void }): void {
        this.exitSurfacePaintInput();
        this._surfacePaintMeshId = meshId;
        this._surfacePaintHandlers = handlers;

        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;

        const uvAt = (e: PointerEvent): { u: number; v: number } | null => {
            const mesh = this.getMesh(meshId);
            if (!mesh) return null;
            const rect = canvas.getBoundingClientRect();
            const px = (e.clientX - rect.left) * (canvas.width / rect.width);
            const py = (e.clientY - rect.top) * (canvas.height / rect.height);
            return this._screenToMeshUV(px, py, canvas.width, canvas.height, mesh);
        };

        const onDown = (e: PointerEvent) => {
            if (e.button !== 0 || e.altKey || !this._surfacePaintHandlers) return; // alt = orbit
            const uv = uvAt(e);
            if (!uv) return; // missed the mesh → let it through (orbit / select / pan)
            e.stopImmediatePropagation();
            e.preventDefault();
            canvas.setPointerCapture(e.pointerId);
            this._surfacePaintDrawing = true;
            this._surfacePaintHandlers.begin(uv.u, uv.v, e.pressure || 1);
        };
        const onMove = (e: PointerEvent) => {
            const h = this._surfacePaintHandlers;
            if (!h) return;
            const uv = uvAt(e);
            if (this._surfacePaintDrawing) {
                e.stopImmediatePropagation();
                if (uv) h.move(uv.u, uv.v, e.pressure || 1); // off-mesh → skip, keep stroke alive
            }
            // Always update the link cursor (ring on the UV pane), drawing or hovering.
            h.hover?.(uv ? [uv.u, uv.v] : null);
        };
        const onUp = (e: PointerEvent) => {
            if (!this._surfacePaintDrawing) return;
            this._surfacePaintDrawing = false;
            canvas.releasePointerCapture(e.pointerId);
            this._surfacePaintHandlers?.end();
        };
        const onLeave = () => this._surfacePaintHandlers?.hover?.(null);

        canvas.addEventListener('pointerdown',  onDown,  { capture: true });
        canvas.addEventListener('pointermove',  onMove,  { capture: true });
        canvas.addEventListener('pointerup',    onUp,    { capture: true });
        canvas.addEventListener('pointerleave', onLeave);
        this._surfacePaintCleanup = () => {
            canvas.removeEventListener('pointerdown',  onDown,  { capture: true } as any);
            canvas.removeEventListener('pointermove',  onMove,  { capture: true } as any);
            canvas.removeEventListener('pointerup',    onUp,    { capture: true } as any);
            canvas.removeEventListener('pointerleave', onLeave);
        };
    }

    /** Exit 3D surface-paint input. */
    exitSurfacePaintInput(): void {
        if (this._surfacePaintDrawing) { this._surfacePaintHandlers?.end(); this._surfacePaintDrawing = false; }
        this._surfacePaintCleanup?.();
        this._surfacePaintCleanup = undefined;
        this._surfacePaintHandlers = undefined;
        this._surfacePaintMeshId = null;
    }

    /**
     * Update draw settings while GP draw mode is active (e.g. on slider change).
     * Safe to call before entering draw mode too — values persist until changed.
     */
    setGpDrawSettings(opts: {
        mode?: 'draw' | 'erase';
        color?: { r: number; g: number; b: number; a: number };
        baseWidth?: number;
        fillColor?: { r: number; g: number; b: number; a: number } | null;
        parentJoint?: string | null;
        closed?: boolean;
        eraseRadius?: number;
        depth?: number;
        depthMode?: 'surface' | 'fixed';
    }): void {
        this._applyGpDrawOpts(opts);
    }

    private static readonly _GP_DRAW_OPT_KEYS = new Set([
        'mode', 'color', 'baseWidth', 'fillColor', 'parentJoint',
        'closed', 'eraseRadius', 'depth', 'depthMode',
    ]);

    private _applyGpDrawOpts(opts: {
        mode?: 'draw' | 'erase';
        color?: { r: number; g: number; b: number; a: number };
        baseWidth?: number;
        fillColor?: { r: number; g: number; b: number; a: number } | null;
        parentJoint?: string | null;
        closed?: boolean;
        eraseRadius?: number;
        depth?: number;
        depthMode?: 'surface' | 'fixed';
    }): void {
        for (const k of Object.keys(opts)) {
            if (!Scene3DManager._GP_DRAW_OPT_KEYS.has(k)) {
                console.warn(`[GP] Unknown draw option key: "${k}" — did you mean one of: ${[...Scene3DManager._GP_DRAW_OPT_KEYS].join(', ')}?`);
            }
        }
        if (opts.mode            !== undefined) this._gpDrawMode = opts.mode;
        if (opts.color           !== undefined) this._gpDrawColor = opts.color;
        if (opts.baseWidth       !== undefined) this._gpDrawBaseWidth = opts.baseWidth;
        if (opts.fillColor       !== undefined) this._gpDrawFillColor = opts.fillColor;
        if (opts.parentJoint     !== undefined) this._gpDrawParentJoint = opts.parentJoint;
        if (opts.closed          !== undefined) this._gpDrawClosed = opts.closed;
        if (opts.eraseRadius     !== undefined) this._gpDrawEraseRadius = opts.eraseRadius;
        if (opts.depth           !== undefined) this._gpDrawDepth = opts.depth;
        if (opts.depthMode       !== undefined) this._gpDrawDepthMode = opts.depthMode;
    }

    private _gpDrawUnproject(e: PointerEvent, canvas: HTMLCanvasElement): [number, number, number] {
        const rect = canvas.getBoundingClientRect();
        const sx = (e.clientX - rect.left) * (canvas.width  / rect.width);
        const sy = (e.clientY - rect.top)  * (canvas.height / rect.height);

        // When a drawing plane is locked, project via ray-plane intersection.
        if (this._gpDrawPlane) {
            const plane = this._gpDrawPlane;
            const camera = this.renderer3D.getCamera();
            const { origin, dir } = this._picker.castRay(sx, sy, canvas.width, canvas.height, camera);
            const [nx, ny, nz] = plane.normal;
            const denom = dir[0]*nx + dir[1]*ny + dir[2]*nz;
            if (Math.abs(denom) > 1e-6) {
                const t = ((plane.point[0] - origin[0])*nx +
                           (plane.point[1] - origin[1])*ny +
                           (plane.point[2] - origin[2])*nz) / denom;
                if (t > 0) {
                    return [
                        origin[0] + dir[0] * t,
                        origin[1] + dir[1] * t,
                        origin[2] + dir[2] * t,
                    ];
                }
            }
        }

        // Fallback (no plane): mid-depth unproject.
        const w = this.unprojectScreenToWorld3D(sx, sy, 0.5, canvas.width, canvas.height);
        return [w.x, w.y, w.z];
    }

    private _setupGpDrawListeners(): void {
        this._gpDrawListenerCleanup?.();
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;
        canvas.style.cursor = 'crosshair';

        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0 || !this._gpDrawActive) return;
            e.stopImmediatePropagation();
            e.preventDefault();
            canvas.setPointerCapture(e.pointerId);
            this._gpDrawPointerDown = true;

            if (this._gpDrawMode === 'draw') {
                const gpId    = this._gpDrawGpId!;
                const layerId = this._gpDrawLayerId!;
                this.beginGpStroke(gpId, layerId, this._gpDrawColor, this._gpDrawBaseWidth, {
                    fillColor:   this._gpDrawFillColor ?? undefined,
                    parentJoint: this._gpDrawParentJoint ?? undefined,
                    closed:      this._gpDrawClosed,
                });
                const pt = this._gpDrawUnproject(e, canvas);
                this.addGpPoint(pt[0], pt[1], pt[2], e.pressure || 1, 1);
            } else {
                // Erase mode: erase on down too.
                const pt = this._gpDrawUnproject(e, canvas);
                this.eraseGpStrokes(this._gpDrawGpId!, this._gpDrawLayerId!, pt, this._gpDrawEraseRadius);
            }
        };

        const onPointerMove = (e: PointerEvent) => {
            if (!this._gpDrawPointerDown || !this._gpDrawActive) return;
            e.stopImmediatePropagation();
            if (this._gpDrawMode === 'draw') {
                const pt = this._gpDrawUnproject(e, canvas);
                this.addGpPoint(pt[0], pt[1], pt[2], e.pressure || 1, 1);
            } else {
                const pt = this._gpDrawUnproject(e, canvas);
                this.eraseGpStrokes(this._gpDrawGpId!, this._gpDrawLayerId!, pt, this._gpDrawEraseRadius);
            }
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!this._gpDrawPointerDown) return;
            this._gpDrawPointerDown = false;
            canvas.releasePointerCapture(e.pointerId);
            if (this._gpDrawMode === 'draw') this.endGpStroke();
        };

        const onPointerLeave = () => {
            if (this._gpDrawPointerDown) {
                this._gpDrawPointerDown = false;
                if (this._gpDrawMode === 'draw') this.endGpStroke();
            }
        };

        canvas.addEventListener('pointerdown',  onPointerDown,  { capture: true });
        canvas.addEventListener('pointermove',  onPointerMove,  { capture: true });
        canvas.addEventListener('pointerup',    onPointerUp,    { capture: true });
        canvas.addEventListener('pointerleave', onPointerLeave);

        this._gpDrawListenerCleanup = () => {
            canvas.removeEventListener('pointerdown',  onPointerDown,  { capture: true } as any);
            canvas.removeEventListener('pointermove',  onPointerMove,  { capture: true } as any);
            canvas.removeEventListener('pointerup',    onPointerUp,    { capture: true } as any);
            canvas.removeEventListener('pointerleave', onPointerLeave);
            canvas.style.cursor = '';
        };
    }

    // ── GP serialization ──────────────────────────────────────────────

    getScene3DGpStates(): any[] {
        return [...this._gpObjects.values()].map(g => g.toJSON());
    }

    restoreGpStates(states: any[]): void {
        this._gpObjects.clear();
        // Remove any existing GpObject3D nodes from the scene graph.
        const existing: GpObject3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep(n => { if (n instanceof GpObject3D) existing.push(n); });
        for (const n of existing) n.parent?.removeChild(n);

        for (const s of states) {
            const gpObj = GpObject3D.fromJSON(s, this.ctx.interactionService);
            this.ctx.sceneGraph.root.addChild(gpObj);
            this._gpObjects.set(gpObj.id, gpObj);
        }
    }

    // ── Bone overlay — activation ────────────────────────────────────
    //
    // Call showBoneOverlay3D(skelId) whenever the Armature panel selects a
    // skeleton.  This works for both bare Skeleton3D nodes (during authoring,
    // before binding) and SkinnedMesh3D (after binding — _syncBoneOverlay
    // handles that path automatically on mesh selection).

    /**
     * Activate the bone overlay for a skeleton by ID.
     * Pass null to hide the overlay.
     * Optionally pass `meshId` to auto-center the camera on that mesh when entering.
     * Frogmarks should call this whenever the active skeleton in the Armature
     * panel changes, and on panel close.
     */
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

    // ── Armature focus mode helpers ──────────────────────────────────────────

    /**
     * Set the visual style for the armature focus mode background.
     * Default is 'wavy' (blue + cream animated wave pattern).
     * Call any time — takes effect on the next frame.
     */
    setArmatureBgMode3D(opts: import('../../types/armature-3d').ArmatureBgOptions): void {
        this.renderer3D.setArmatureBgMode(opts);
        this.ctx.scheduleRender();
    }

    /**
     * Activate the armature focus background immediately — even before a skeleton exists.
     * Frogmarks calls this as soon as the Armature panel opens (on the mesh settings panel
     * 'Armature' button click), before the user has added any bones.
     * If `meshId` is provided the camera frames that mesh right away.
     * The background is deactivated automatically by showBoneOverlay3D(null).
     */
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

    /**
     * Fit the camera to the given mesh so it fills the viewport during armature editing.
     * Reuses the same framing logic as frameMesh. Call after showBoneOverlay3D.
     * The camera position is restored when showBoneOverlay3D(null) is called.
     */
    centerCameraOnMesh3D(meshId: string): void {
        // 40% padding so bone handles have breathing room.
        if (this.frameMesh(meshId, 1.4)) return;
        // frameMesh returned false: the id didn't resolve to a Mesh3D, or the mesh
        // has no vertices to bound. Don't leave the Focus button feeling dead —
        // log why it missed and fall back to framing whatever meshes exist.
        const mesh = this.getMesh(meshId);
        console.warn(
            `[Armature] centerCameraOnMesh3D: could not frame mesh "${meshId}" ` +
            (mesh ? '(mesh found but has no boundable geometry)' : '(no Mesh3D node with that id)') +
            ' — framing all meshes instead.',
        );
        this.frameAllMeshes(1.4);
    }

    /** Save and zero a mesh's Euler rotation for the armature workspace. No-op if already saved. */
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

    /**
     * Hide all meshes except the given one — or, if it belongs to a procedural character, except the
     * WHOLE character (body + eye decal + hair + garments, which are separate sibling meshes sharing
     * one skeleton). Without the character expansion, entering armature mode would hide every part
     * except the one passed in, so the character appears to vanish (leaving only bones). Saves each
     * hidden mesh's previous visibility so clearMeshIsolation3D() can restore it exactly.
     */
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

    /** Restore mesh visibility saved by isolateMesh3D. No-op if not isolated. */
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

    /** The mesh ID currently isolated (visible alone), or null. */
    get isolatedMeshId3D(): string | null { return this._isolatedMeshId; }

    // ── Joint picking ────────────────────────────────────────────────

    /** The index of the currently selected joint in the active bone overlay, or null. */
    getSelectedJointIndex(): number | null { return this._selectedJointIndex; }

    /** True if the current joint selection was made by clicking a tail sphere (vs a head sphere).
     *  Determines Add Bone semantics: tail → extend chain; head → branch from this point. */
    getSelectedJointIsTail(): boolean { return this._selectedJointIsTail; }

    /** The ID of the skeleton whose bone overlay is currently active, or null. */
    getBoneOverlaySkeletonId(): string | null { return this._boneOverlaySkeletonId; }

    /** Switch the active armature tool ('move' repositions joints; 'rotate' applies FK rotation). */
    setArmatureToolMode(mode: 'move' | 'rotate'): void {
        this._armatureToolMode = mode;
        this.renderer3D.setArmatureToolMode(mode);
        // Clear any in-progress gizmo hover so the new tool type renders immediately.
        this._jointGizmoHoveredAxis = null;
        this.renderer3D.setJointGizmoHoveredAxis(null);
        this.ctx.scheduleRender();
    }

    getArmatureToolMode(): 'move' | 'rotate' { return this._armatureToolMode; }

    /** Get the current local rotation quaternion [x,y,z,w] for a joint. */
    getJointRotation(skeletonId: string, jointIndex: number): [number,number,number,number] | null {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return null;
        const j = skel.data.joints[jointIndex];
        if (!j) return null;
        return [...j.localRotation] as [number,number,number,number];
    }

    /** Reset a single joint's local rotation to the identity quaternion [0,0,0,1]. */
    resetJointRotation(skeletonId: string, jointIndex: number): void {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return;
        skel.setJointRotation(jointIndex, [0, 0, 0, 1]);
        this.ctx.scheduleRender();
    }

    /** Reset all joints in a skeleton to identity rotation. */
    resetAllJointRotations(skeletonId: string): void {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return;
        for (const j of skel.data.joints) {
            j.localRotation = [0, 0, 0, 1];
        }
        skel.computeWorldMatrices();
        this.ctx.scheduleRender();
    }

    /**
     * Apply a named preset pose (T-pose / A-pose / Relaxed / Wave) to a procedural-body skeleton.
     * Resets all joints to identity, then sets the pose's per-joint rotations BY NAME (so it works
     * on any skeleton whose joints match the generator's names). See BODY_POSES in body-generator.ts.
     */
    async applyBodyPose3D(skeletonId: string, poseName: string): Promise<boolean> {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return false;
        const { BODY_POSES } = await import('./body-generator');
        const pose = BODY_POSES[poseName];
        if (!pose) return false;
        for (const j of skel.data.joints) j.localRotation = [0, 0, 0, 1];
        const idxByName = new Map(skel.data.joints.map((j, i) => [j.name, i]));
        for (const { joint, q } of pose) {
            const i = idxByName.get(joint);
            if (i !== undefined) skel.data.joints[i].localRotation = [...q];
        }
        skel.computeWorldMatrices();
        this.ctx.scheduleRender();
        return true;
    }

    /** List the available preset-pose names (for a UI dropdown). */
    async getBodyPoseNames3D(): Promise<string[]> {
        const { BODY_POSES } = await import('./body-generator');
        return Object.keys(BODY_POSES);
    }

    /**
     * Programmatically select a joint in the active bone overlay.
     * Emits sceneGraphChanged so the Armature panel can sync its selection state.
     */
    selectJoint(jointIndex: number | null): void {
        this._selectedJointIndex = jointIndex;
        this._selectedJointIsTail = false; // programmatic selection defaults to head semantics
        this.renderer3D.setSelectedJoint(jointIndex);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Clear the active joint selection without clearing the bone overlay. */
    clearJointSelection(): void { this.selectJoint(null); }

    // ── Extrude bone (deprecated) ─────────────────────────────────────

    /**
     * @deprecated Exact duplicate of {@link enterBonePlacementMode3D}. The
     * "Extrude" button did the same thing as "Extend Chain / Branch Here": both
     * just enter bone-placement mode, and the click handler ({@link onMouseDown})
     * decides extend-vs-branch-vs-root purely from the current joint selection
     * (joint selected → single-click child bone; nothing selected → two-click
     * root). There is no separate "extrude" behaviour. Kept as a thin alias so a
     * lingering caller doesn't break; delete once no UI references it.
     */
    extrudeJoint3D(skeletonId: string): void {
        this.enterBonePlacementMode3D(skeletonId);
    }

    // ── Bone placement mode ───────────────────────────────────────────
    //
    // While active, the next viewport click places a joint at the ray-scene
    // intersection rather than selecting or dragging.  Used for:
    //   - Placing the first root bone (called by Frogmarks before panel opens)
    //   - Placing subsequent bones with click-to-position UX
    //
    // Frogmarks flow:
    //   1. enterBonePlacementMode3D(skelId) + show "Click to place joint" hint
    //   2. User clicks → joint placed → sceneGraphChanged fires → panel refreshes
    //   3. isBonePlacementModeActive3D() returns false after placement

    /**
     * Enter bone placement mode for a skeleton.
     * The next viewport click will place a joint (parented to the currently
     * selected joint, or as a root if nothing is selected) at the ray-scene
     * intersection.  Falls back to a camera-facing plane at distance 2 if
     * nothing is hit.
     */
    enterBonePlacementMode3D(skeletonId: string): void {
        this._bonePlacementMode = true;
        this._bonePlacementSkeletonId = skeletonId;
        // Hide the joint translation gizmo while drawing so the user can focus on
        // placing the bone (notably the head, between the two root-bone clicks).
        this.renderer3D.setBonePlacementActive(true);
        this.ctx.scheduleRender();
    }

    /** Cancel bone placement mode without placing a joint. */
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

    /** True while waiting for the user to click a placement point. */
    isBonePlacementModeActive3D(): boolean {
        return this._bonePlacementMode;
    }

    // ── Joint screen positions (for label overlay) ────────────────────

    /**
     * Project all joints of a skeleton into 2D screen coordinates.
     * Frogmarks can use this each frame (on a requestAnimationFrame loop or
     * after scheduleRender) to position name-label elements over the canvas.
     *
     * Returns an empty array if the skeleton is not found or has no joints.
     */
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

    // ── Mesh Grouping ───────────────────────────────────────────────

    createMeshGroup(name = '3D Group'): MeshGroup3D {
        const g = new MeshGroup3D(this.ctx.interactionService);
        g.name = name;
        const parent = this.ctx.sceneGraph.root;
        parent.addChild(g);
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(g.id);
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Create group',
            undo: () => {
                g.parent?.removeChild(g);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                parent.addChild(g);
                this.ctx.emitSceneGraphChanged();
            },
        });

        return g;
    }

    /** Delete a mesh group (and un-parent its children to root). Pushes an undo command. */
    deleteMeshGroup(groupId: string): boolean {
        const group = this.getMeshGroup(groupId);
        if (!group) return false;

        // ArrayGroup3D: delete all bucket siblings in one atomic undo entry.
        if (group instanceof ArrayGroup3D) {
            return this._deleteArrayGroupBucket(group);
        }

        const savedParent = group.parent ?? this.ctx.sceneGraph.root;
        const children = [...group.children];

        // Lift children to root before removing the group
        for (const child of children) {
            group.removeChild(child);
            this.ctx.sceneGraph.root.addChild(child);
        }
        group.parent?.removeChild(group);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Delete group',
            undo: () => {
                // Re-adopt children and re-add group
                for (const child of children) {
                    child.parent?.removeChild(child);
                    group.addChild(child);
                }
                savedParent.addChild(group);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                for (const child of children) {
                    group.removeChild(child);
                    this.ctx.sceneGraph.root.addChild(child);
                }
                group.parent?.removeChild(group);
                this.ctx.emitSceneGraphChanged();
            },
        });

        return true;
    }

    private _deleteArrayGroupBucket(representative: ArrayGroup3D): boolean {
        const root = this.ctx.sceneGraph.root;

        // Collect all ArrayGroup3Ds in the same (parentGroup, direction) bucket.
        const source = this.getMesh(representative.sourceId);
        const parentGroup = source?.parent;
        let toDelete: ArrayGroup3D[];

        if (parentGroup instanceof MeshGroup3D && !(parentGroup instanceof ArrayGroup3D)) {
            const siblingIds = new Set(
                parentGroup.children
                    .filter((c): c is Mesh3D => c instanceof Mesh3D)
                    .map(c => c.id),
            );
            const dirKey = this._arrayDirectionKey(representative.arrayParams);
            toDelete = (root.children as ArrayGroup3D[]).filter(
                (n): n is ArrayGroup3D =>
                    n instanceof ArrayGroup3D &&
                    siblingIds.has(n.sourceId) &&
                    this._arrayDirectionKey(n.arrayParams) === dirKey,
            );
        } else {
            toDelete = [representative];
        }

        for (const g of toDelete) g.parent?.removeChild(g);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Delete array',
            undo: () => {
                for (const g of toDelete) root.addChild(g);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                for (const g of toDelete) g.parent?.removeChild(g);
                this.ctx.emitSceneGraphChanged();
            },
        });

        return true;
    }

    getMeshGroup(groupId: string): MeshGroup3D | null {
        const n = this.ctx.sceneGraph.findNodeById(groupId);
        return n instanceof MeshGroup3D ? n : null;
    }

    getMeshGroups(): MeshGroup3D[] {
        const groups: MeshGroup3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep?.((n: any) => {
            if (n instanceof MeshGroup3D) groups.push(n);
        });
        return groups;
    }

    /**
     * When clicking a mesh inside a MeshGroup3D, bubble selection up to the group:
     * expand the provided IDs to all Mesh3D siblings in the same group and return
     * the group's ID for outliner sync. Falls through unchanged for non-group meshes.
     */
    private _expandGroupSelection(ids: Set<string>): { meshIds: Set<string>; groupId: string | null } {
        if (ids.size === 0) {
            this._selectedGroupId = null;
            return { meshIds: ids, groupId: null };
        }

        // Direct ArrayGroup3D selection — from GPU instance picking via pickAdditional.
        if (ids.size === 1) {
            const [id] = ids;
            const node = this.ctx.sceneGraph.findNodeById(id);
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

    addMeshToGroup(meshId: string, groupId: string): boolean {
        const mesh = this.getMesh(meshId);
        const group = this.getMeshGroup(groupId);
        if (!mesh || !group) return false;

        mesh.parent?.removeChild(mesh);
        group.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return true;
    }

    removeMeshFromGroup(meshId: string): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh || !mesh.parent || mesh.parent === this.ctx.sceneGraph.root) return false;
        mesh.parent.removeChild(mesh);
        this.ctx.sceneGraph.root.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return true;
    }

    // ── Array Tool ───────────────────────────────────────────────────

    isArrayGroup3D(nodeId: string): boolean {
        return this.ctx.sceneGraph.findNodeById(nodeId) instanceof ArrayGroup3D;
    }

    getArrayParams3D(groupId: string): ArrayParams | null {
        const n = this.ctx.sceneGraph.findNodeById(groupId);
        return n instanceof ArrayGroup3D ? n.arrayParams : null;
    }

    getArraySourceId(groupId: string): string | null {
        const n = this.ctx.sceneGraph.findNodeById(groupId);
        return n instanceof ArrayGroup3D ? n.sourceId : null;
    }

    /** Return the IDs of all ArrayGroup3D nodes that use `sourceId` as their source mesh. */
    getArrayGroupsForSource(sourceId: string): string[] {
        return (this.ctx.sceneGraph.root.children as unknown[])
            .filter((n): n is ArrayGroup3D => n instanceof ArrayGroup3D && n.sourceId === sourceId)
            .map(g => g.id);
    }

    /** Set a per-instance override for one slot in an array group. Pushes an undo entry. */
    setInstanceOverride(groupId: string, instanceIndex: number, override: InstanceOverride): void {
        const group = this._getArrayGroup(groupId);
        if (!group) return;
        if (!group.instanceOverrides) group.instanceOverrides = new Map();
        const prev = group.instanceOverrides.get(instanceIndex);
        const next = { ...override };
        group.instanceOverrides.set(instanceIndex, next);
        this.renderer3D.markInstancesDirty();
        this.ctx.scheduleRender();
        this._undoManager.push({
            description: 'Set instance override',
            undo: () => {
                const g = this._getArrayGroup(groupId);
                if (!g) return;
                if (prev === undefined) g.instanceOverrides?.delete(instanceIndex);
                else { if (!g.instanceOverrides) g.instanceOverrides = new Map(); g.instanceOverrides.set(instanceIndex, prev); }
                this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
            },
            redo: () => {
                const g = this._getArrayGroup(groupId);
                if (!g) return;
                if (!g.instanceOverrides) g.instanceOverrides = new Map();
                g.instanceOverrides.set(instanceIndex, next);
                this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
            },
        });
    }

    /** Remove a per-instance override, restoring the instance to source defaults. Pushes an undo entry. */
    clearInstanceOverride(groupId: string, instanceIndex: number): void {
        const group = this._getArrayGroup(groupId);
        if (!group?.instanceOverrides?.has(instanceIndex)) return;
        const prev = group.instanceOverrides.get(instanceIndex)!;
        group.instanceOverrides.delete(instanceIndex);
        this.renderer3D.markInstancesDirty();
        this.ctx.scheduleRender();
        this._undoManager.push({
            description: 'Clear instance override',
            undo: () => {
                const g = this._getArrayGroup(groupId);
                if (!g) return;
                if (!g.instanceOverrides) g.instanceOverrides = new Map();
                g.instanceOverrides.set(instanceIndex, prev);
                this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender();
            },
            redo: () => {
                const g = this._getArrayGroup(groupId);
                if (g) { g.instanceOverrides?.delete(instanceIndex); this.renderer3D.markInstancesDirty(); this.ctx.scheduleRender(); }
            },
        });
    }

    /** Return all instance overrides for an array group as a plain array for UI consumption. */
    getInstanceOverrides(groupId: string): Array<{ index: number; override: InstanceOverride }> {
        const group = this._getArrayGroup(groupId);
        if (!group?.instanceOverrides) return [];
        return [...group.instanceOverrides.entries()].map(([index, override]) => ({ index, override }));
    }

    private _getArrayGroup(groupId: string): ArrayGroup3D | null {
        const n = this.ctx.sceneGraph.findNodeById(groupId);
        return n instanceof ArrayGroup3D ? n : null;
    }

    // ── Geometry Modifier Stack ────────────────────────────────────────────────
    // These operate on Mesh3D.modifiers (CPU geometry transforms applied before GPU upload).
    // Distinct from the EditMesh modifier stack (meshEdit.addMirrorModifier etc.) which only
    // works on edit-mode meshes and modifies the EditMesh topology in place.

    /** Append a geometry modifier to any Mesh3D's modifier stack. Pushes undo. */
    addGeomModifier(meshId: string, mod: Modifier): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        mesh.modifiers.push(mod);
        mesh.invalidateModifierCache();
        this.ctx.scheduleRender();
        const idx = mesh.modifiers.length - 1;
        this._undoManager.push({
            description: 'Add geometry modifier',
            undo: () => { mesh.modifiers.splice(idx, 1); mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
            redo: () => { mesh.modifiers.push(mod); mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
        });
    }

    /** Remove the geometry modifier at `index` from the mesh's stack. Pushes undo. */
    removeGeomModifier(meshId: string, index: number): void {
        const mesh = this.getMesh(meshId);
        if (!mesh || index < 0 || index >= mesh.modifiers.length) return;
        const removed = mesh.modifiers[index];
        mesh.modifiers.splice(index, 1);
        mesh.invalidateModifierCache();
        this.ctx.scheduleRender();
        this._undoManager.push({
            description: 'Remove geometry modifier',
            undo: () => { mesh.modifiers.splice(index, 0, removed); mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
            redo: () => { mesh.modifiers.splice(index, 1); mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
        });
    }

    /** Merge `partial` fields into the geometry modifier at `index`. Pushes undo. */
    updateGeomModifier(meshId: string, index: number, partial: Partial<Modifier>): void {
        const mesh = this.getMesh(meshId);
        if (!mesh || index < 0 || index >= mesh.modifiers.length) return;
        const before = { ...mesh.modifiers[index] };
        Object.assign(mesh.modifiers[index], partial);
        mesh.invalidateModifierCache();
        this.ctx.scheduleRender();
        const after = { ...mesh.modifiers[index] };
        this._undoManager.push({
            description: 'Update geometry modifier',
            undo: () => { mesh.modifiers[index] = before as Modifier; mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
            redo: () => { mesh.modifiers[index] = after as Modifier; mesh.invalidateModifierCache(); this.ctx.scheduleRender(); },
        });
    }

    /** Return a snapshot of the mesh's geometry modifier stack. */
    getGeomModifiers(meshId: string): Modifier[] {
        const mesh = this.getMesh(meshId);
        return mesh ? [...mesh.modifiers] : [];
    }

    /**
     * Returns all ArrayGroup3D nodes whose source meshes are siblings in the same
     * MeshGroup3D as the source of the given ArrayGroup3D. When the source is not
     * inside a MeshGroup3D, returns just the one group (the common single-mesh case).
     *
     * When a sibling source has multiple arrays (different directions), only the array
     * whose direction matches the reference group's direction is included. This prevents
     * a spacing drag from corrupting arrays created in other directions on the same source.
     */
    private _getGroupSiblingArrays(groupId: string): ArrayGroup3D[] {
        const group = this._getArrayGroup(groupId);
        if (!group) return [];
        const source = this.getMesh(group.sourceId);
        if (!source || !(source.parent instanceof MeshGroup3D) || source.parent instanceof ArrayGroup3D) {
            return [group];
        }
        const siblingIds = new Set(
            source.parent.children.filter((c): c is Mesh3D => c instanceof Mesh3D).map(c => c.id)
        );

        // Collect candidates grouped by source mesh ID.
        const bySrc = new Map<string, ArrayGroup3D[]>();
        for (const node of this.ctx.sceneGraph.root.children) {
            if (!(node instanceof ArrayGroup3D) || !siblingIds.has(node.sourceId)) continue;
            let list = bySrc.get(node.sourceId);
            if (!list) { list = []; bySrc.set(node.sourceId, list); }
            list.push(node);
        }

        // For each sibling source pick the array that matches the reference group's direction.
        // When only one array exists for that source the match is trivial (no filtering needed).
        const refDir = this._arrayDirectionKey(group.arrayParams);
        const result: ArrayGroup3D[] = [];
        for (const candidates of bySrc.values()) {
            if (candidates.length === 1) {
                result.push(candidates[0]);
            } else {
                const match = candidates.find(c => this._arrayDirectionKey(c.arrayParams) === refDir);
                if (match) result.push(match);
            }
        }
        return result;
    }

    /** Canonical direction key for an array's primary spacing vector (used for same-direction matching). */
    private _arrayDirectionKey(params: ArrayParams): string {
        if (params.mode === 'radial') return `radial:${params.axis}`;
        if (params.mode === 'grid')   return `grid:${this._dominantAxis(params.spacingX)}`;
        return `linear:${this._dominantAxis(params.spacing)}`;
    }

    /** Returns the dominant-axis token (+x/-x/+y/-y/+z/-z) for a 3-vector. */
    private _dominantAxis(v: [number, number, number]): string {
        const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
        if (ax >= ay && ax >= az) return v[0] >= 0 ? '+x' : '-x';
        if (ay >= ax && ay >= az) return v[1] >= 0 ? '+y' : '-y';
        return v[2] >= 0 ? '+z' : '-z';
    }

    // ── Array group live sync ─────────────────────────────────────────────────

    private _ensureArrayGroupSync(): void {
        if (this._arrayGroupSyncCb) return;
        // Register a pre-render callback that passes current array groups to the renderer
        // each frame so it can compute GPU instance transforms without Mesh3D copy objects.
        this._arrayGroupSyncCb = () => {
            const groups: ArrayGroup3D[] = [];
            for (const node of this.ctx.sceneGraph.root.children) {
                if (node instanceof ArrayGroup3D) groups.push(node as ArrayGroup3D);
            }

            // When the transform gizmo is in local orientation mode, build a basis map so
            // radial instances orbit the source's own axis instead of the world axis.
            let localBases: Map<string, LocalBasis3> | undefined;
            if (this._transformController?.orientationMode === 'local') {
                for (const group of groups) {
                    if (group.arrayParams.mode !== 'radial') continue;
                    const source = this.getMesh(group.sourceId);
                    if (!source) continue;
                    const m = source.localMatrix as Float32Array;
                    const c0 = Math.hypot(m[0], m[1], m[2]) || 1;
                    const c1 = Math.hypot(m[4], m[5], m[6]) || 1;
                    const c2 = Math.hypot(m[8], m[9], m[10]) || 1;
                    if (!localBases) localBases = new Map();
                    localBases.set(group.id, {
                        x: [m[0] / c0, m[1] / c0, m[2] / c0],
                        y: [m[4] / c1, m[5] / c1, m[6] / c1],
                        z: [m[8] / c2, m[9] / c2, m[10] / c2],
                    });
                }
            }

            this.renderer3D.setArrayGroups(groups, localBases);

            // Source-link feedback: when a source mesh is selected, faintly highlight its instances.
            const selIds = this.renderer3D.getSelectedMeshIds();
            let sourceId: string | null = null;
            if (selIds.size === 1) {
                const [id] = selIds;
                if (groups.some(g => g.sourceId === id)) sourceId = id;
            }
            this.renderer3D.setSelectedSourceId(sourceId);

            return false;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._arrayGroupSyncCb);
    }

    /**
     * Create a linear array from an existing mesh.
     * The source mesh stays in place; only generated copies are added to the ArrayGroup3D.
     */
    createLinearArray3D(
        sourceId: string,
        count = 3,
        spacing?: [number, number, number],
    ): ArrayGroup3D {
        const source = this.getMesh(sourceId);
        if (!source) throw new Error(`createLinearArray3D: mesh ${sourceId} not found`);

        let defaultSpacing: [number, number, number] = [2, 0, 0];
        const worldCorners = source.obbCorners;
        if (worldCorners) {
            let minX = Infinity, maxX = -Infinity;
            for (const [wx] of worldCorners) {
                if (wx < minX) minX = wx;
                if (wx > maxX) maxX = wx;
            }
            defaultSpacing = [Math.max(0.5, (maxX - minX) * 1.1), 0, 0];
        }
        const actualSpacing = spacing ?? defaultSpacing;

        const params: LinearArrayParams = { mode: 'linear', countX: count, spacing: actualSpacing };
        const group = new ArrayGroup3D(this.ctx.interactionService, sourceId, params);

        const root = this.ctx.sceneGraph.root;
        root.addChild(group);

        this.renderer3D.setSelectedMeshIds(new Set([source.id]));
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(group.id);
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Create array',
            undo: () => {
                root.removeChild(group);
                this.renderer3D.setSelectedMeshIds(new Set([source.id]));
                this.ctx.setSelectedNode(source.id);
                this.renderer3D.setArrayGizmoData(null);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                root.addChild(group);
                this.renderer3D.setSelectedMeshIds(new Set([source.id]));
                this.ctx.setSelectedNode(group.id);
                this.ctx.emitSceneGraphChanged();
            },
        });

        this._ensureArrayGroupSync();
        return group;
    }

    /**
     * Create a grid (NxM) array from an existing mesh.
     * The source stays in place; only generated copies belong to the ArrayGroup3D.
     */
    createGridArray3D(
        sourceId: string,
        countX = 2,
        spacingX?: [number, number, number],
        countY = 2,
        spacingY?: [number, number, number],
        diagonalOnly = false,
    ): ArrayGroup3D {
        const source = this.getMesh(sourceId);
        if (!source) throw new Error(`createGridArray3D: mesh ${sourceId} not found`);

        let defX: [number, number, number] = [2, 0, 0];
        let defY: [number, number, number] = [0, 0, 2];
        const corners = source.obbCorners;
        if (corners) {
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (const [wx, , wz] of corners) {
                if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
                if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
            }
            defX = [Math.max(0.5, (maxX - minX) * 1.1), 0, 0];
            defY = [0, 0, Math.max(0.5, (maxZ - minZ) * 1.1)];
        }
        const actualSpacingX = spacingX ?? defX;
        const actualSpacingY = spacingY ?? defY;

        const params: GridArrayParams = { mode: 'grid', countX, spacingX: actualSpacingX, countY, spacingY: actualSpacingY, diagonalOnly };
        const group = new ArrayGroup3D(this.ctx.interactionService, sourceId, params);

        const root = this.ctx.sceneGraph.root;
        root.addChild(group);

        this.renderer3D.setSelectedMeshIds(new Set([source.id]));
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(group.id);
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Create grid array',
            undo: () => {
                root.removeChild(group);
                this.renderer3D.setSelectedMeshIds(new Set([source.id]));
                this.ctx.setSelectedNode(source.id);
                this.renderer3D.setArrayGizmoData(null);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                root.addChild(group);
                this.renderer3D.setSelectedMeshIds(new Set([source.id]));
                this.ctx.setSelectedNode(group.id);
                this.ctx.emitSceneGraphChanged();
            },
        });

        this._ensureArrayGroupSync();
        return group;
    }

    /**
     * Create a radial array from an existing mesh.
     * The source stays at its current position; `count` ring copies are placed around it.
     */
    createRadialArray3D(
        sourceId: string,
        count = 6,
        radius?: number,
        axis: 'x' | 'y' | 'z' = 'y',
        arcDeg = 360,
    ): ArrayGroup3D {
        const source = this.getMesh(sourceId);
        if (!source) throw new Error(`createRadialArray3D: mesh ${sourceId} not found`);

        let actualRadius = radius ?? 3;
        if (radius === undefined) {
            const corners = source.obbCorners;
            if (corners) {
                let maxR = 0;
                for (const [wx, wy, wz] of corners) {
                    const d = Math.sqrt(wx*wx + wy*wy + wz*wz);
                    if (d > maxR) maxR = d;
                }
                actualRadius = Math.max(1, maxR * 1.5);
            }
        }

        // Ring is centered at the source's current position.
        const center: [number, number, number] = [source.x, source.y, source.z];

        const params: RadialArrayParams = { mode: 'radial', count, radius: actualRadius, axis, arcDeg, center };
        const group = new ArrayGroup3D(this.ctx.interactionService, sourceId, params);

        const root = this.ctx.sceneGraph.root;
        root.addChild(group);

        this.renderer3D.setSelectedMeshIds(new Set([source.id]));
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(group.id);
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Create radial array',
            undo: () => {
                root.removeChild(group);
                this.renderer3D.setSelectedMeshIds(new Set([source.id]));
                this.ctx.setSelectedNode(source.id);
                this.renderer3D.setArrayGizmoData(null);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                root.addChild(group);
                this.renderer3D.setSelectedMeshIds(new Set([source.id]));
                this.ctx.setSelectedNode(group.id);
                this.ctx.emitSceneGraphChanged();
            },
        });

        this._ensureArrayGroupSync();
        return group;
    }

    /**
     * Live-update array parameters during gizmo drag or panel change.
     * Rebuilds copy positions and schedules a render — no undo step.
     */
    updateArrayParams3D(groupId: string, params: Partial<ArrayParams>): void {
        const group = this._getArrayGroup(groupId);
        if (!group) return;
        Object.assign(group.arrayParams, params);
        // Renderer recomputes instance transforms from updated params on next frame.
        this.renderer3D.markInstancesDirty();
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /**
     * Convert an ArrayGroup3D to a plain MeshGroup3D with independent geometry per copy.
     * Creates new Mesh3D objects from the computed instance positions (GPU instancing model —
     * no Mesh3D copies exist until bake). Pushes an undo command.
     */
    bakeArray3D(groupId: string): MeshGroup3D | null {
        const group = this._getArrayGroup(groupId);
        if (!group) return null;

        const source = this.getMesh(group.sourceId);
        if (!source) return null;

        const srcParent   = (source.parent ?? this.ctx.sceneGraph.root) as any;
        const groupParent = (group.parent  ?? this.ctx.sceneGraph.root) as any;
        const srcGeom     = source.geometry;

        // Clone source into a new independent Mesh3D at the given world position.
        const makeCopy = (wx: number, wy: number, wz: number): Mesh3D => {
            // Spread the full primitive config so params like radius, segments, etc. are preserved.
            const cfg: Mesh3DConfig = { ...(source as any)._meshConfig };
            if (source.meshPrimitive === 'custom' && srcGeom) {
                cfg.geometry = {
                    vertices: new Float32Array(srcGeom.vertices),
                    indices:  new Uint32Array(srcGeom.indices),
                    format:   srcGeom.format,
                };
            } else {
                delete cfg.geometry;
            }
            const copy = new Mesh3D(this.ctx.interactionService, wx, wy, wz, cfg);
            copy.setRotation3D(source.rotationX, source.rotationY, source.rotation);
            copy.setScale3D(source.scaleX, source.scaleY, source.scaleZ);
            copy.setMaterial({ ...source.material });
            copy._name = source.name;
            return copy;
        };

        // Source copy (at source position) + N instance copies — all independent.
        const sourceCopy = makeCopy(source.x, source.y, source.z);

        // Determine instance world transforms: object offset (accumulated matrix) or standard translation.
        const objectOffsetId = group.arrayParams.mode === 'linear' ? group.arrayParams.objectOffsetId : undefined;
        const offsetMesh = objectOffsetId ? this.getMesh(objectOffsetId) : null;
        let instanceCopies: Mesh3D[];

        if (offsetMesh) {
            const srcMat = source.localMatrix as Float32Array;
            const invSrc = mat4.invert(mat4.create(), srcMat as any) as Float32Array;
            const D = mat4.multiply(mat4.create(), offsetMesh.localMatrix as any, invSrc as any) as Float32Array;
            const accum = new Float32Array(srcMat);
            const N = getArrayInstanceCount(group.arrayParams);
            instanceCopies = [];
            for (let i = 0; i < N; i++) {
                mat4.multiply(accum as any, D as any, accum as any);
                const t = decomposeMatrix4(accum);
                const copy = makeCopy(t.x, t.y, t.z);
                copy.rotationX = t.rotX;
                copy.rotationY = t.rotY;
                copy.rotation  = t.rotZ;
                copy.scaleX    = t.scaleX;
                copy.scaleY    = t.scaleY;
                copy.scaleZ    = t.scaleZ;
                instanceCopies.push(copy);
            }
        } else {
            instanceCopies = computeArrayOffsets(group.arrayParams, [source.x, source.y, source.z])
                .map(([dx, dy, dz]) => makeCopy(source.x + dx, source.y + dy, source.z + dz));
        }

        const allCopies = [sourceCopy, ...instanceCopies];

        // Only remove the source mesh if no other ArrayGroup3D still references it.
        // Removing it when siblings exist would break all other repeats off the same source.
        const siblingsExist = this.ctx.sceneGraph.root.children.some(
            n => n instanceof ArrayGroup3D && n.id !== group.id && (n as ArrayGroup3D).sourceId === source.id,
        );
        const removeSource = !siblingsExist;

        const plainGroup = new MeshGroup3D(this.ctx.interactionService);
        plainGroup._name = group.name;
        for (const copy of allCopies) plainGroup.addChild(copy);

        // Remove the ArrayGroup3D; replace with the baked group.
        groupParent.removeChild(group);
        if (removeSource) srcParent.removeChild(source);
        groupParent.addChild(plainGroup);

        this.renderer3D.setSelectedMeshIds(new Set(allCopies.map(c => c.id)));
        this.renderer3D.setArrayGizmoData(null);
        this._selectedGroupId = null;
        this.ctx.setSelectedNode(plainGroup.id);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Bake array',
            undo: () => {
                for (const c of [...plainGroup.children]) plainGroup.removeChild(c);
                groupParent.removeChild(plainGroup);
                groupParent.addChild(group);
                if (removeSource) srcParent.addChild(source);
                this.renderer3D.setSelectedMeshIds(new Set([source.id]));
                this.ctx.setSelectedNode(group.id);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                for (const copy of allCopies) plainGroup.addChild(copy);
                groupParent.removeChild(group);
                if (removeSource) srcParent.removeChild(source);
                groupParent.addChild(plainGroup);
                this.renderer3D.setArrayGizmoData(null);
                this._selectedGroupId = null;
                this.ctx.setSelectedNode(plainGroup.id);
                this.ctx.emitSceneGraphChanged();
            },
        });

        return plainGroup;
    }

    /**
     * Bake an ArrayGroup3D into a single unified Mesh3D by:
     *  1. Transforming all copy geometries to world space.
     *  2. Optionally inserting oriented bridge boxes in inter-copy gaps (gapFill flag on LinearArrayParams).
     *  3. Welding near-coincident vertices within `weldThreshold` world units (default 0.001).
     *
     * The resulting mesh sits at the world origin (all positions already folded into vertex data).
     * Pushes an undoable command.
     */
    bakeArrayMerged3D(groupId: string): Mesh3D | null {
        const group = this._getArrayGroup(groupId);
        if (!group) return null;

        const source = this.getMesh(group.sourceId);
        if (!source) return null;

        const srcGeom = source.geometry;
        if (!srcGeom?.vertices.length) return null;

        const params = group.arrayParams;
        const linParams = params.mode === 'linear' ? params as LinearArrayParams : null;
        const weldThresh = linParams?.weldThreshold ?? 0.001;
        const doGapFill  = (linParams?.gapFill ?? false) && !linParams?.objectOffsetId;

        // ── Build one world matrix per copy (source first, then instances) ──────────────
        const allMats: Float32Array[] = [new Float32Array(source.localMatrix as any)];

        const objectOffsetId = linParams?.objectOffsetId;
        const offsetMesh     = objectOffsetId ? this.getMesh(objectOffsetId) : null;

        if (offsetMesh) {
            const srcMat = source.localMatrix as Float32Array;
            const invSrc = mat4.invert(mat4.create(), srcMat as any) as Float32Array;
            const D      = mat4.multiply(mat4.create(), offsetMesh.localMatrix as any, invSrc as any) as Float32Array;
            const accum  = new Float32Array(srcMat);
            const N      = getArrayInstanceCount(params);
            for (let i = 0; i < N; i++) {
                mat4.multiply(accum as any, D as any, accum as any);
                allMats.push(new Float32Array(accum));
            }
        } else {
            for (const [dx, dy, dz] of computeArrayOffsets(params, [source.x, source.y, source.z])) {
                const m = mat4.clone(source.localMatrix as any) as Float32Array;
                m[12] += dx; m[13] += dy; m[14] += dz;
                allMats.push(m);
            }
        }

        // ── Merge all copy geometries into flat arrays ─────────────────────────────────
        const mergedVerts: number[] = [];
        const mergedIdx:   number[] = [];
        for (const mat of allMats) {
            _mergeTransformedGeom(srcGeom.vertices, srcGeom.indices, mat, mergedVerts, mergedIdx);
        }

        // ── Gap fill: oriented bridge box between each pair of consecutive copies ──────
        if (doGapFill && allMats.length >= 2) {
            // Compute spacing direction and extent from the first two copy centers.
            const dx = allMats[1][12] - allMats[0][12];
            const dy = allMats[1][13] - allMats[0][13];
            const dz = allMats[1][14] - allMats[0][14];
            const spLen = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (spLen > 1e-6) {
                const dNorm: [number,number,number] = [dx/spLen, dy/spLen, dz/spLen];

                // World-space extent of source along dNorm.
                const srcMat = allMats[0];
                let minD = Infinity, maxD = -Infinity;
                let minU = Infinity, maxU = -Infinity;
                let minV = Infinity, maxV = -Infinity;

                // Gram-Schmidt: perpendicular axes u, v
                const ref: [number,number,number] = Math.abs(dNorm[0]) < 0.9 ? [1,0,0] : [0,1,0];
                const uDir = _normVec3(_crossVec3(dNorm, ref));
                const vDir = _normVec3(_crossVec3(dNorm, uDir));

                const sv = srcGeom.vertices;
                for (let vi = 0; vi < sv.length; vi += FLOATS_PER_VERT) {
                    const px = sv[vi], py = sv[vi+1], pz = sv[vi+2];
                    const wx = srcMat[0]*px + srcMat[4]*py + srcMat[8]*pz;
                    const wy = srcMat[1]*px + srcMat[5]*py + srcMat[9]*pz;
                    const wz = srcMat[2]*px + srcMat[6]*py + srcMat[10]*pz;
                    const dotD = wx*dNorm[0] + wy*dNorm[1] + wz*dNorm[2];
                    const dotU = wx*uDir[0]  + wy*uDir[1]  + wz*uDir[2];
                    const dotV = wx*vDir[0]  + wy*vDir[1]  + wz*vDir[2];
                    if (dotD < minD) minD = dotD; if (dotD > maxD) maxD = dotD;
                    if (dotU < minU) minU = dotU; if (dotU > maxU) maxU = dotU;
                    if (dotV < minV) minV = dotV; if (dotV > maxV) maxV = dotV;
                }

                const extentD = maxD - minD;
                const gap     = spLen - extentD;
                const extU    = maxU - minU;
                const extV    = maxV - minV;

                if (gap > 1e-6 && extU > 1e-6 && extV > 1e-6) {
                    for (let i = 0; i < allMats.length - 1; i++) {
                        // Bridge center = front face of copy i + half-gap forward.
                        const frontFaceOffset = maxD + gap * 0.5;
                        const bcx = allMats[i][12] + frontFaceOffset * dNorm[0];
                        const bcy = allMats[i][13] + frontFaceOffset * dNorm[1];
                        const bcz = allMats[i][14] + frontFaceOffset * dNorm[2];
                        _appendOrientedBox(bcx, bcy, bcz, dNorm, uDir, vDir, gap, extU, extV, mergedVerts, mergedIdx);
                    }
                }
            }
        }

        // ── Weld ──────────────────────────────────────────────────────────────────────
        const welded = _weldGeometry(mergedVerts, mergedIdx, weldThresh);

        // ── Build merged Mesh3D at world origin (vertices are already in world space) ──
        const groupParent = (group.parent  ?? this.ctx.sceneGraph.root) as any;
        const srcParent   = (source.parent ?? this.ctx.sceneGraph.root) as any;

        const siblingsExist = this.ctx.sceneGraph.root.children.some(
            n => n instanceof ArrayGroup3D && n.id !== group.id && (n as ArrayGroup3D).sourceId === source.id,
        );
        const removeSource = !siblingsExist;

        const merged = new Mesh3D(this.ctx.interactionService, 0, 0, 0, {
            primitive: 'custom',
            geometry: { ...welded, format: '12float' },
        });
        merged.setMaterial({ ...source.material });
        merged._name = group.name + ' (merged)';

        groupParent.removeChild(group);
        if (removeSource) srcParent.removeChild(source);
        groupParent.addChild(merged);

        this.renderer3D.setArrayGizmoData(null);
        this._selectedGroupId = null;
        this.ctx.setSelectedNode(merged.id);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Bake array (merged)',
            undo: () => {
                groupParent.removeChild(merged);
                groupParent.addChild(group);
                if (removeSource) srcParent.addChild(source);
                this.renderer3D.setSelectedMeshIds(new Set([source.id]));
                this.ctx.setSelectedNode(group.id);
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                groupParent.removeChild(group);
                if (removeSource) srcParent.removeChild(source);
                groupParent.addChild(merged);
                this.renderer3D.setArrayGizmoData(null);
                this._selectedGroupId = null;
                this.ctx.setSelectedNode(merged.id);
                this.ctx.emitSceneGraphChanged();
            },
        });

        return merged;
    }

    /**
     * Delete a mesh by node ID. Pushes an undo command.
     *
     * Memory note: the undo closure keeps the Mesh3D object (and its GPU vertex/index
     * buffers) alive until the command is evicted from the undo stack. This is
     * intentional — it enables undo without re-uploading geometry — but bounds GPU
     * memory retention to at most UndoManager3D.maxDepth (50) deleted meshes.
     */
    deleteMesh(nodeId: string): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        const savedParent = mesh.parent ?? this.ctx.sceneGraph.root;
        mesh.parent?.removeChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Delete mesh',
            undo: () => {
                savedParent.addChild(mesh);
                mesh.gpuDirty = true;
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                mesh.parent?.removeChild(mesh);
                this.ctx.emitSceneGraphChanged();
            },
        });

        return true;
    }

    /**
     * Duplicate a mesh, placing the copy offset slightly from the original.
     * Copies geometry reference, material, transform, texture IDs, and keyframe tracks.
     * The new mesh is selected and pushed onto the undo stack.
     */
    duplicateMesh(nodeId: string): Mesh3D | null {
        const src = this.getMesh(nodeId);
        if (!src) return null;

        const copy = new Mesh3D(this.ctx.interactionService, src.x, src.y, src.z, {
            primitive: 'custom',
            geometry:  src.geometry,
            material:  { ...src.material },
        });
        copy.name = src.name + ' copy';
        // Offset so the duplicate doesn't sit exactly on top of the original
        copy.x += 0.5;
        copy.rotationX = src.rotationX;
        copy.rotationY = src.rotationY;
        copy.rotation  = src.rotation;
        copy.scaleX = src.scaleX;
        copy.scaleY = src.scaleY;
        copy.scaleZ = src.scaleZ;

        // Share texture library references (GPU textures are re-fetched by renderer)
        copy.textureLibraryId    = src.textureLibraryId;
        copy.normalMapLibraryId  = src.normalMapLibraryId;
        copy.diffuseTexture      = src.diffuseTexture;
        copy.normalMapTexture    = src.normalMapTexture;

        // Deep copy keyframe tracks and submeshes so they are independent
        copy.keyframeTracks = JSON.parse(JSON.stringify(src.keyframeTracks));
        copy.submeshes = JSON.parse(JSON.stringify(src.submeshes));

        const parent = src.parent ?? this.ctx.sceneGraph.root;
        parent.addChild(copy);
        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(copy.id);
        this.renderer3D.setSelectedMeshIds(new Set([copy.id]));
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Duplicate mesh',
            undo: () => {
                copy.parent?.removeChild(copy);
                this.ctx.setSelectedNode(src.id);
                this.renderer3D.setSelectedMeshIds(new Set([src.id]));
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                parent.addChild(copy);
                copy.gpuDirty = true;
                this.ctx.setSelectedNode(copy.id);
                this.renderer3D.setSelectedMeshIds(new Set([copy.id]));
                this.ctx.emitSceneGraphChanged();
            },
        });

        return copy;
    }

    // ── Submesh (multi-material) CRUD ────────────────────────────────

    getSubmeshes(meshId: string): Submesh3D[] {
        return this.getMesh(meshId)?.submeshes ?? [];
    }

    setSubmesh(meshId: string, slotIndex: number, partial: Partial<Submesh3D>): void {
        const mesh = this.getMesh(meshId);
        if (!mesh || slotIndex < 0 || slotIndex >= mesh.submeshes.length) return;
        Object.assign(mesh.submeshes[slotIndex], partial);
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    appendSubmesh(meshId: string, submesh: Submesh3D): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        mesh.submeshes.push({ ...submesh });
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    removeSubmesh(meshId: string, slotIndex: number): void {
        const mesh = this.getMesh(meshId);
        if (!mesh || slotIndex < 0 || slotIndex >= mesh.submeshes.length) return;
        mesh.submeshes.splice(slotIndex, 1);
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    clearSubmeshes(meshId: string): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        mesh.submeshes = [];
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
    }

    // ── Mesh Properties ──────────────────────────────────────────────

    setPosition(nodeId: string, x: number, y: number, z: number): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setPosition3D(x, y, z); this.ctx.scheduleRender(); return; }
        const group = this.getMeshGroup(nodeId);
        if (group) {
            const dx = x - group.groupPos3D[0];
            const dy = y - group.groupPos3D[1];
            const dz = z - group.groupPos3D[2];
            for (const child of group.children) {
                if (child instanceof Mesh3D) { child.x += dx; child.y += dy; child.z += dz; }
            }
            group.groupPos3D = [x, y, z];
            this.ctx.scheduleRender();
        }
    }

    setRotation(nodeId: string, rx: number, ry: number, rz: number): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setRotation3D(rx, ry, rz); this.ctx.scheduleRender(); return; }
        const group = this.getMeshGroup(nodeId);
        if (group) {
            const drx = rx - group.groupRot3D[0];
            const dry = ry - group.groupRot3D[1];
            const drz = rz - group.groupRot3D[2];
            for (const child of group.children) {
                if (child instanceof Mesh3D) {
                    child.rotationX += drx;
                    child.rotationY += dry;
                    child.rotation  += drz;
                }
            }
            group.groupRot3D = [rx, ry, rz];
            this.ctx.scheduleRender();
        }
    }

    setScale(nodeId: string, sx: number, sy: number, sz: number): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) {
            if (mesh.parent instanceof MeshGroup3D) return;
            mesh.setScale3D(Math.max(sx, 1e-6), Math.max(sy, 1e-6), Math.max(sz, 1e-6));
            this.ctx.scheduleRender();
            return;
        }
        const group = this.getMeshGroup(nodeId);
        if (group) {
            const ox = group.groupScale3D[0], oy = group.groupScale3D[1], oz = group.groupScale3D[2];
            const fx = ox !== 0 ? sx / ox : 1;
            const fy = oy !== 0 ? sy / oy : 1;
            const fz = oz !== 0 ? sz / oz : 1;
            // Compute group centroid
            let cx = 0, cy = 0, cz = 0, n = 0;
            for (const child of group.children) {
                if (child instanceof Mesh3D) { cx += child.x; cy += child.y; cz += child.z; n++; }
            }
            if (n > 0) { cx /= n; cy /= n; cz /= n; }
            // Scale each child's transform and position from centroid.
            // Clamp to 1e-6 so the 2D localMatrix stays invertible even if sx/sy/sz = 0.
            for (const child of group.children) {
                if (!(child instanceof Mesh3D)) continue;
                child.setScale3D(
                    Math.max(child.scaleX * fx, 1e-6),
                    Math.max(child.scaleY * fy, 1e-6),
                    Math.max(child.scaleZ * fz, 1e-6),
                );
                child.x = cx + (child.x - cx) * fx;
                child.y = cy + (child.y - cy) * fy;
                child.z = cz + (child.z - cz) * fz;
            }
            group.groupScale3D = [sx, sy, sz];
            this.ctx.scheduleRender();
        }
    }

    setMaterial(nodeId: string, material: Partial<Material3D>): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setMaterial(material); this.ctx.scheduleRender(); }
    }

    setDiffuseColor(nodeId: string, r: number, g: number, b: number, a = 1): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setDiffuseColor(r, g, b, a); this.ctx.scheduleRender(); }
    }

    setOpacity(nodeId: string, opacity: number): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setOpacity(opacity); this.ctx.scheduleRender(); }
    }

    setPrimitive(nodeId: string, primitive: MeshPrimitive, config?: Partial<Mesh3DConfig>): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setPrimitive(primitive, config); this.ctx.scheduleRender(); }
    }

    setGeometry(nodeId: string, geometry: MeshGeometry): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setGeometry(geometry); this.ctx.scheduleRender(); }
    }

    // ── Textures ────────────────────────────────────────────────────

    async setMeshTexture(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;

        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return false;

        const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
        const texture = device.createTexture({
            size: [bitmap.width, bitmap.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture },
            [bitmap.width, bitmap.height],
        );

        if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
        mesh.diffuseTexture = texture;
        mesh.material.hasTexture = true;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    clearMeshTexture(nodeId: string): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        if (mesh.diffuseTexture) {
            mesh.diffuseTexture.destroy();
            mesh.diffuseTexture = null;
        }
        mesh.material.hasTexture = false;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    // ── Global Scene Settings (serializable snapshot) ────────────────

    getGlobalScene3DSettings(): GlobalScene3DSettings {
        return {
            projection:    this._illustrationProjection,
            ps1:           { ...this.renderer3D.ps1Config },
            lighting: {
                directional: this.renderer3D.lightConfig,
                ambient:     this.renderer3D.ambientConfig,
            },
            bg:            { ...this.renderer3D.sceneBgOptions },
            fog:           { ...this.renderer3D.fogConfig },
            ibl:           { enabled: this.renderer3D.iblEnabled, intensity: (this.renderer3D as any)._iblIntensity as number },
            textureFilter: this.renderer3D.textureFilterMode,
            postProcess:   this.renderer3D.getPostProcessConfig(),
            shadows: {
                enabled:    this.renderer3D.shadowsEnabled,
                mapSize:    this.renderer3D.shadowMapSize,
                halfExtent: this.renderer3D.shadowHalfExtent,
                bias:       this.renderer3D.shadowBias,
            },
            snap: this.snapMode,
            snapGridSize:   this.snapGridSize,
            snapRotateStep: this.snapAngle,
            snapScaleStep:  this.snapScaleStep,
            grid: { visible: this._gridVisible, color: this.gridColor, opacity: this._gridOpacity },
        };
    }

    restoreGlobalScene3DSettings(s: Partial<GlobalScene3DSettings>): void {
        if (s.projection !== undefined) {
            this._illustrationProjection = s.projection;
            this.renderer3D.getCamera().mode = s.projection === 'orthographic' ? 'orthographic' : 'perspective';
        }
        if (s.ps1)          this.renderer3D.setPS1(s.ps1);
        if (s.lighting?.directional) {
            const d = s.lighting.directional;
            this.renderer3D.setDirectionalLight(d.direction[0], d.direction[1], d.direction[2], d.color[0], d.color[1], d.color[2], d.intensity);
        }
        if (s.lighting?.ambient) {
            const a = s.lighting.ambient;
            this.renderer3D.setAmbientLight(a.color[0], a.color[1], a.color[2], a.intensity);
        }
        if (s.bg)           this.renderer3D.setSceneBg(s.bg);
        if (s.fog)          this.renderer3D.setFog(s.fog);
        // IBL: intensity and enabled flag are restored; the actual environment map image
        // is not serialized (it requires re-uploading an ImageData). iblEnabled will be
        // false on load unless the host app re-sets the environment map after restore.
        if (s.ibl) (this.renderer3D as any)._iblIntensity = s.ibl.intensity;
        if (s.textureFilter !== undefined) this.renderer3D.setTextureFilterMode(s.textureFilter);
        if (s.postProcess)  this.renderer3D.setPostProcessing(s.postProcess);
        if (s.shadows) {
            if (s.shadows.enabled) {
                this.renderer3D.enableShadows(s.shadows.mapSize, s.shadows.halfExtent, s.shadows.bias);
            } else {
                this.renderer3D.disableShadows();
            }
        }
        if (s.snap !== undefined) this.snapMode = s.snap;
        if (s.snapGridSize   !== undefined) this.snapGridSize  = s.snapGridSize;
        if (s.snapRotateStep !== undefined) this.snapAngle     = s.snapRotateStep;
        if (s.snapScaleStep  !== undefined) this.snapScaleStep = s.snapScaleStep;
        if (s.grid) {
            if (s.grid.visible !== undefined) this._gridVisible = s.grid.visible;
            if (s.grid.color)                 this._gridColor   = [s.grid.color[0], s.grid.color[1], s.grid.color[2]];
            if (s.grid.opacity !== undefined) this._gridOpacity = s.grid.opacity;
            this._pushGridConfig();
        }
        this.ctx.scheduleRender();
    }

    // ── PS1 Config & Lighting ────────────────────────────────────────

    setPS1Config(config: Partial<PS1Config>): void { this.renderer3D.setPS1(config); this.ctx.scheduleRender(); }
    getPS1Config(): PS1Config { return { ...this.renderer3D.ps1Config }; }

    /**
     * Apply a named retro rendering preset.
     * - `'wobble'`  — 320×240, vertex jitter, affine warp, 32-level color, Bayer dithering, UV quantization
     * - `'pocket'`  — 400×240, stable verts, perspective-correct, near-full color
     * - `'off'`     — reset all lo-fi settings; full-resolution PBR rendering
     *
     * Individual `setPS1Config` calls still work for fine-tuning after applying a preset.
     */
    setRetroPreset(preset: 'wobble' | 'pocket' | 'off'): void {
        if (preset === 'wobble') {
            this.renderer3D.setPS1({ ...WOBBLE_PRESET });
            this.renderer3D.setTextureFilterMode('nearest');
            this.renderer3D.setFog({ mode: 'linear', color: [0, 0, 0], near: 8, far: 20, density: 0.1 });
        } else if (preset === 'pocket') {
            this.renderer3D.setPS1({ ...POCKET_PRESET });
            this.renderer3D.setTextureFilterMode('nearest');
            this.renderer3D.setFog({ mode: 'linear', color: [0.85, 0.9, 1.0], near: 12, far: 30, density: 0.1 });
        } else {
            this.renderer3D.setPS1({ ...DEFAULT_PS1_CONFIG });
            this.renderer3D.setTextureFilterMode('linear');
            this.renderer3D.setFog({ mode: 'off', color: [0.8, 0.8, 0.8], near: 5, far: 20, density: 0.1 });
        }
        this.ctx.scheduleRender();
    }

    setDirectionalLight(dx: number, dy: number, dz: number, r = 1, g = 1, b = 1, intensity = 1): void {
        this.renderer3D.setDirectionalLight(dx, dy, dz, r, g, b, intensity);
        this.ctx.scheduleRender();
    }

    setAmbientLight(r: number, g: number, b: number, intensity = 1): void {
        this.renderer3D.setAmbientLight(r, g, b, intensity);
        this.ctx.scheduleRender();
    }

    setFog3D(config: Partial<FogConfig>): void { this.renderer3D.setFog(config); this.ctx.scheduleRender(); }
    getFog3D(): FogConfig { return { ...this.renderer3D.fogConfig }; }

    setSceneBg3D(opts: ArmatureBgOptions): void { this.renderer3D.setSceneBg(opts); this.ctx.scheduleRender(); }
    getSceneBg3D(): ArmatureBgOptions { return this.renderer3D.sceneBgOptions; }

    setTextureFilterMode3D(mode: 'nearest' | 'linear'): void { this.renderer3D.setTextureFilterMode(mode); this.ctx.scheduleRender(); }

    setEnvironmentMap3D(imageData: ImageData | null, intensity = 1.0): void {
        if (!imageData) { this.renderer3D.clearEnvironmentMap3D(); }
        else { this.renderer3D.setEnvironmentMap3D(imageData, intensity); }
        this.ctx.scheduleRender();
    }
    clearEnvironmentMap3D(): void { this.renderer3D.clearEnvironmentMap3D(); this.ctx.scheduleRender(); }
    get iblEnabled3D(): boolean { return this.renderer3D.iblEnabled; }

    setPostProcessing3D(config: Parameters<Renderer3D['setPostProcessing']>[0]): void {
        this.renderer3D.setPostProcessing(config);
        this.ctx.scheduleRender();
    }
    getPostProcessing3D(): PostProcessConfig {
        return this.renderer3D.getPostProcessConfig();
    }

    createSprite(x: number, y: number, z: number, width = 1, height = 1, material?: Partial<import('../../renderer/3d/material-3d').Material3D>): import('../../scene-graph/shapes/mesh-3d').Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'sprite', width, height, material });
    }

    static get PS1Defaults(): PS1Config { return { ...DEFAULT_PS1_CONFIG }; }
    static get FogDefaults(): FogConfig { return { ...DEFAULT_FOG_CONFIG }; }

    // ── Selection ────────────────────────────────────────────────────

    getSelected3DIds(): Set<string> {
        return this.renderer3D.getSelectedMeshIds();
    }

    setSelected3DIds(ids: Set<string>): void {
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

    /**
     * Called when an outliner node is clicked. Syncs the 3D renderer and gizmo
     * without calling ctx.setSelectedNode (which would cause a cycle).
     * Handles both Mesh3D and MeshGroup3D node IDs.
     */
    syncSelectionFromOutliner(nodeId: string): void {
        const node = this.ctx.sceneGraph.findNodeById(nodeId);
        let meshIds = new Set<string>();
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

    // ── Hover highlight ──────────────────────────────────────────────

    /**
     * Highlight the given mesh with a thin light-blue outline on hover.
     * Pass null to clear. Safe to call from Outliner list item mouseenter/mouseleave.
     */
    setHoveredMesh(id: string | null): void {
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

    // ── Picking ──────────────────────────────────────────────────────

    /** If `meshId` is an attachment overlay (eye decal / hair / garment), return the body it belongs
     *  to — so clicking any part of a dressed character selects the body. Else return the id as-is. */
    private _resolveOverlayToBody(meshId: string): string {
        for (const r of this._faceRigs.values())     if (r.decalMeshId     === meshId) return r.bodyMeshId;
        for (const r of this._hairRigs.values())      if (r.hairMeshId      === meshId) return r.bodyMeshId;
        for (const r of this._clothingRigs.values())  if (r.clothingMeshId  === meshId) return r.bodyMeshId;
        return meshId;
    }

    /** If `meshId` is a procedural-character body OR one of its parts, return the body id; else null. */
    private _characterBodyOf(meshId: string): string | null {
        if (this.getMesh(meshId)?.isProceduralBody) return meshId;
        if (this._faceRigs.has(meshId) || this._hairRigs.has(meshId)
            || [...this._clothingRigs.values()].some(r => r.bodyMeshId === meshId)) return meshId;
        const owner = this._resolveOverlayToBody(meshId);
        return owner !== meshId ? owner : null;
    }

    /** All mesh ids of one character: the body + its eye decal + hair + every garment. */
    private _characterMeshIds(bodyId: string): Set<string> {
        const ids = new Set<string>([bodyId]);
        const fr = this._faceRigs.get(bodyId); if (fr) ids.add(fr.decalMeshId);
        const hr = this._hairRigs.get(bodyId); if (hr) ids.add(hr.hairMeshId);
        for (const r of this._clothingRigs.values()) if (r.bodyMeshId === bodyId) ids.add(r.clothingMeshId);
        return ids;
    }

    /** Expand a selection so picking ANY character part selects the WHOLE character (body + parts) —
     *  the gizmo then moves it as one unit (multi-select transform; the skeleton stays put). */
    private _expandCharacterSelection(ids: Set<string>): Set<string> {
        const out = new Set<string>();
        for (const id of ids) {
            const body = this._characterBodyOf(id);
            if (body) for (const m of this._characterMeshIds(body)) out.add(m);
            else out.add(id);
        }
        return out;
    }

    /**
     * Pick the front-most visible Mesh3D under the given canvas pixel.
     * Returns the hit mesh ID and world-space hit point, or null on miss.
     *
     * All four values must be in the SAME pixel space — physical (device) pixels.
     * Scale CSS mouse coordinates by devicePixelRatio (or canvas.width/rect.width)
     * before calling, and pass canvas.width / canvas.height (not clientWidth/Height).
     */
    pick3D(
        mouseX: number,
        mouseY: number,
        canvasWidth: number,
        canvasHeight: number,
    ): { meshId: string; hitPoint: [number, number, number]; faceNormal: [number, number, number]; triangleIndex: number; distance: number } | null {
        const camera = this.renderer3D.getCamera();
        const meshes = this.getAllMeshes();
        const result = this._picker.pickMesh(mouseX, mouseY, canvasWidth, canvasHeight, camera, meshes);
        if (!result) return null;
        // Clicking the eyes/hair/clothing selects the character body they're attached to.
        const meshId = this._resolveOverlayToBody(result.mesh.id);
        return { meshId, hitPoint: result.hitPoint, faceNormal: result.faceNormal, triangleIndex: result.triangleIndex, distance: result.distance };
    }

    /**
     * Convenience pick that takes raw client (CSS) coordinates and the canvas
     * bounding rect — always produces correct results regardless of devicePixelRatio.
     *
     * Usage:
     *   const rect = canvas.getBoundingClientRect();
     *   const hit  = shapeManager.scene3d.pickFromClient3D(e.clientX, e.clientY, rect);
     */
    pickFromClient3D(
        clientX: number,
        clientY: number,
        canvasRect: { left: number; top: number; width: number; height: number },
    ): { meshId: string; hitPoint: [number, number, number]; faceNormal: [number, number, number]; triangleIndex: number; distance: number } | null {
        // CSS coordinates: DPR cancels in NDC = 2*(cssX/cssW)-1, so pass CSS consistently.
        return this.pick3D(clientX - canvasRect.left, clientY - canvasRect.top, canvasRect.width, canvasRect.height);
    }

    // ── World ↔ Screen projection utilities ─────────────────────────

    /**
     * Project a 3D world position to 2D screen pixel coordinates.
     * Use this to position HTML overlays (e.g. drag handles, labels) over 3D objects.
     *
     * @param x,y,z      World-space position to project.
     * @param canvasW,H  Canvas pixel dimensions (canvas.width / canvas.height).
     * @returns Screen pixel coordinates and a depth value (0 = near plane, 1 = far plane).
     *          Returns null if the point is behind the camera.
     */
    projectWorldToScreen3D(
        x: number, y: number, z: number,
        canvasW: number, canvasH: number,
    ): { x: number; y: number; depth: number } | null {
        const vp = this.renderer3D.getCamera().getViewProjectionMatrix();
        // Clip space: vp * [x, y, z, 1]
        const cx = vp[0]*x + vp[4]*y + vp[8]*z  + vp[12];
        const cy = vp[1]*x + vp[5]*y + vp[9]*z  + vp[13];
        const cz = vp[2]*x + vp[6]*y + vp[10]*z + vp[14];
        const cw = vp[3]*x + vp[7]*y + vp[11]*z + vp[15];
        if (cw <= 0) return null; // behind camera
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        const ndcZ = cz / cw;
        return {
            x:     (ndcX + 1) * 0.5 * canvasW,
            y:     (1 - ndcY) * 0.5 * canvasH,
            depth: ndcZ * 0.5 + 0.5,
        };
    }

    /**
     * Unproject a 2D screen pixel + depth back to a 3D world position.
     * Use this to convert mouse drag deltas into world-space movement for handles.
     *
     * @param screenX,Y  Mouse position in canvas pixels.
     * @param depth      Depth from a prior projectWorldToScreen3D call (or 0 for near-plane).
     * @param canvasW,H  Canvas pixel dimensions.
     */
    unprojectScreenToWorld3D(
        screenX: number, screenY: number, depth: number,
        canvasW: number, canvasH: number,
    ): { x: number; y: number; z: number } {
        const ndcX =  screenX / canvasW * 2 - 1;
        const ndcY =  1 - screenY / canvasH * 2;
        const ndcZ =  depth * 2 - 1;

        const vp = this.renderer3D.getCamera().getViewProjectionMatrix();
        // Invert VP matrix
        const inv = mat4.invert(mat4.create(), vp as mat4);
        if (!inv) return { x: 0, y: 0, z: 0 };

        const wx = inv[0]*ndcX + inv[4]*ndcY + inv[8]*ndcZ  + inv[12];
        const wy = inv[1]*ndcX + inv[5]*ndcY + inv[9]*ndcZ  + inv[13];
        const wz = inv[2]*ndcX + inv[6]*ndcY + inv[10]*ndcZ + inv[14];
        const ww = inv[3]*ndcX + inv[7]*ndcY + inv[11]*ndcZ + inv[15];
        const rw = ww !== 0 ? 1 / ww : 1;
        return { x: wx * rw, y: wy * rw, z: wz * rw };
    }

    // ── Transform controls (gizmo + picking) ─────────────────────────

    /**
     * Provide a predicate that returns true while a mesh is in edit mode.
     * Must be called before enableTransformControls so the gizmo's click-to-select
     * path is suppressed during edit mode (preventing race with MeshEditPointerController).
     */
    setMeshEditModeChecker(fn: () => boolean): void {
        this._isMeshEditModeFn = fn;
    }

    /**
     * Provide a data supplier for the mesh edit overlay renderer.
     * Called once per frame while transform controls are active; return null when not editing.
     * Typically supplied by ShapeManager after both meshEdit and scene3d are initialized.
     */
    setMeshEditDataProvider(fn: () => MeshEditDrawData | null): void {
        this._meshEditDataFn = fn;
        // If transform controls are already active, wire the provider now.
        if (this._meshEditOverlay) {
            this.renderer3D.setMeshEditDataProvider(fn);
        }
    }

    /**
     * Enable the transform gizmo + click-to-select for 3D meshes.
     * Attaches pointer event listeners to the canvas.
     */
    enableTransformControls(): void {
        this.disableTransformControls();

        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) { console.warn('Scene3DManager: WebGPU device not available'); return; }

        const swapChainFormat = (this.ctx.webgpuRenderer as any).swapChainFormat ?? 'bgra8unorm';
        this._gizmoRenderer = new GizmoRenderer(device, swapChainFormat);
        this.renderer3D.setGizmoRenderer(this._gizmoRenderer);

        const callbacks = {
            getMeshes:       () => this.getAllMeshes(),
            getCamera:       () => this.renderer3D.getCamera(),
            getCanvasSize:   () => {
                const canvas = this.ctx.webgpuRenderer.getCanvas();
                return canvas ? { width: canvas.width, height: canvas.height } : { width: 1, height: 1 };
            },
            getSelectedIds:  () => this.renderer3D.getSelectedMeshIds(),
            setSelectedIds:  (ids: Set<string>) => {
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
                // Mark instance data dirty so mesh positions are re-uploaded every drag frame.
                this.renderer3D.markInstancesDirty();
                this.ctx.scheduleRender();
            },
            getOrbitController: () => this._orbitController,
            onTransformComplete: (before: Map<string, any>, after: Map<string, any>) => {
                const meshes = this.getAllMeshes();
                this._undoManager.push({
                    description: 'Transform mesh',
                    undo: () => {
                        for (const mesh of meshes) {
                            const s = before.get(mesh.id);
                            if (!s) continue;
                            mesh.x = s.x; mesh.y = s.y; mesh.z = s.z;
                            mesh.rotationX = s.rx; mesh.rotationY = s.ry; mesh.rotation = s.rz;
                            mesh.scaleX = s.sx; mesh.scaleY = s.sy; mesh.scaleZ = s.sz;
                        }
                    },
                    redo: () => {
                        for (const mesh of meshes) {
                            const s = after.get(mesh.id);
                            if (!s) continue;
                            mesh.x = s.x; mesh.y = s.y; mesh.z = s.z;
                            mesh.rotationX = s.rx; mesh.rotationY = s.ry; mesh.rotation = s.rz;
                            mesh.scaleX = s.sx; mesh.scaleY = s.sy; mesh.scaleZ = s.sz;
                        }
                    },
                });
                // Mark all transformed meshes as save-dirty.
                for (const id of after.keys()) {
                    const m = this.getMesh(id);
                    if (m) m.stateDirty = true;
                }
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
                    let data: ArrayGizmoData;

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

                    } else {
                        // radial
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
        this.ctx.webgpuRenderer.addPreRenderCallback(syncCallback);

        const canvas = this.ctx.webgpuRenderer.getCanvas();
        if (canvas) {
            this._transformController.attach(canvas as HTMLCanvasElement);
            this._setupBoneOverlayListeners();
        }
    }

    private _boneOverlayListenerCleanup?: () => void;

    /** Set up (or re-use) the canvas listeners that drive bone overlay hover, drag, and placement.
     *  Idempotent — safe to call multiple times; only registers once per canvas session. */
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
                            const hit = this._gizmoRenderer.hitTestJoint(origin, dir, skel, camera);
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
                if (this._hoveredTailJointIndex !== null && !this._weightPaintMeshId) {
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
                if (skelHead && !this._weightPaintMeshId) {
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
                if (this._orbitController && !this._weightPaintMeshId) this._orbitController.enabled = true;
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

            (canvas as HTMLCanvasElement).addEventListener('mousemove', onMouseMove);
            (canvas as HTMLCanvasElement).addEventListener('mouseleave', onMouseLeave);
            (canvas as HTMLCanvasElement).addEventListener('mousedown', onMouseDown);
            (canvas as HTMLCanvasElement).addEventListener('mouseup',   onMouseUp);
            this._boneOverlayListenerCleanup = () => {
                (canvas as HTMLCanvasElement).removeEventListener('mousemove',  onMouseMove);
                (canvas as HTMLCanvasElement).removeEventListener('mouseleave', onMouseLeave);
                (canvas as HTMLCanvasElement).removeEventListener('mousedown',  onMouseDown);
                (canvas as HTMLCanvasElement).removeEventListener('mouseup',    onMouseUp);
            };
    }

    disableTransformControls(): void {
        this._boneOverlayListenerCleanup?.();
        this._boneOverlayListenerCleanup = undefined;
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

    // ── Array Tool (Phase 4) ──────────────────────────────────────────────────

    enableArrayTool(mode: ArrayToolMode = 'line', initialCount = 3): void {
        this._arrayTool?.destroy();

        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;

        const gr = this._gizmoRenderer;
        if (!gr) return; // transform controls must be active

        this._arrayTool = new ArrayToolController(
            canvas,
            this.renderer3D,
            gr,
            this._picker,
            {
                getAllMeshes:       () => this.getAllMeshes(),
                getCamera:         () => this.renderer3D.getCamera(),
                getCanvasSize:     () => ({ width: canvas.width, height: canvas.height }),
                getSelectedMeshId: () => {
                    const ids = this.getSelected3DIds();
                    const [firstId] = ids;
                    if (!firstId) return null;
                    const mesh = this.getMesh(firstId);
                    // Copies live inside an ArrayGroup3D — don't treat them as array sources
                    if (!mesh || mesh.parent instanceof ArrayGroup3D) return null;
                    return firstId;
                },
                getGroupSiblings: (meshId: string) => {
                    const mesh = this.getMesh(meshId);
                    if (!mesh) return [];
                    const parent = mesh.parent;
                    if (!(parent instanceof MeshGroup3D) || parent instanceof ArrayGroup3D) return [mesh];
                    return parent.children.filter((c): c is Mesh3D => c instanceof Mesh3D);
                },
                getOrientationMode: () => this.getGizmoOrientation(),
                getOccupiedHandleIds: (sourceId: string) => {
                    const occupied = new Set<string>();
                    const dominant = (v: [number,number,number]): string => {
                        const [x, y, z] = v.map(Math.abs);
                        if (x >= y && x >= z) return v[0] >= 0 ? 'px' : 'nx';
                        if (y >= x && y >= z) return v[1] >= 0 ? 'py' : 'ny';
                        return v[2] >= 0 ? 'pz' : 'nz';
                    };
                    for (const node of this.ctx.sceneGraph.root.children) {
                        if (!(node instanceof ArrayGroup3D) || node.sourceId !== sourceId) continue;
                        const p = node.arrayParams;
                        if (p.mode === 'linear') {
                            occupied.add(dominant(p.spacing));
                        } else if (p.mode === 'grid') {
                            if (p.diagonalOnly) {
                                occupied.add(dominant(p.spacingX) + dominant(p.spacingY));
                            } else {
                                occupied.add(dominant(p.spacingX));
                                occupied.add(dominant(p.spacingY));
                            }
                        }
                    }
                    return occupied;
                },
                createLinearArray3D: (id, n, sp) => { this.createLinearArray3D(id, n, sp); },
                createGridArray3D:   (id, cX, spX, cY, spY, diag) => { this.createGridArray3D(id, cX, spX, cY, spY, diag); },
                createRadialArray3D: (id, n, r, ax, deg) => { this.createRadialArray3D(id, n, r, ax, deg); },
                scheduleRender:    () => { this.ctx.scheduleRender(); },
            },
            mode,
            initialCount,
        );

        const tool = this._arrayTool;
        this._arrayToolPreRenderCb = () => tool.checkState();
        this.ctx.webgpuRenderer.addPreRenderCallback(this._arrayToolPreRenderCb);
    }

    disableArrayTool(): void {
        if (this._arrayToolPreRenderCb) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._arrayToolPreRenderCb);
            this._arrayToolPreRenderCb = null;
        }
        this._arrayTool?.destroy();
        this._arrayTool = null;
    }

    setArrayToolMode(mode: ArrayToolMode): void {
        this._arrayTool?.setMode(mode);
    }

    setArrayToolCount(count: number): void {
        this._arrayTool?.setCount(count);
    }

    getArrayToolCount(): number {
        return this._arrayTool?.getCount() ?? 3;
    }

    setArrayToolAxis(axis: 'x' | 'y' | 'z'): void {
        this._arrayTool?.setRadialAxis(axis);
    }

    getArrayToolAxis(): 'x' | 'y' | 'z' {
        return this._arrayTool?.getRadialAxis() ?? 'y';
    }

    /** null = auto-size from mesh AABB. */
    setArrayToolRadius(r: number | null): void {
        this._arrayTool?.setRadialRadius(r);
    }

    getArrayToolRadius(): number | null {
        return this._arrayTool?.getRadialRadius() ?? null;
    }

    setArrayToolArc(deg: number): void {
        this._arrayTool?.setRadialArc(deg);
    }

    getArrayToolArc(): number {
        return this._arrayTool?.getRadialArc() ?? 360;
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

    // ── Snap settings ────────────────────────────────────────────────

    /** Grid size for Ctrl+drag position snapping (world units). Default 1.0. */
    get snapGridSize(): number { return this._transformController?.snapGridSize ?? 1.0; }
    set snapGridSize(v: number) { if (this._transformController) this._transformController.snapGridSize = v; this._pushGridConfig(); }

    /** Angle increment for Ctrl+drag rotation snapping (radians). Default 15° (π/12). */
    get snapAngle(): number { return this._transformController?.snapAngle ?? Math.PI / 12; }
    set snapAngle(v: number) { if (this._transformController) this._transformController.snapAngle = v; }

    /** Scale factor increment for Ctrl+drag scale snapping. Default 0.25. */
    get snapScaleStep(): number { return this._transformController?.snapScaleStep ?? 0.25; }
    set snapScaleStep(v: number) { if (this._transformController) this._transformController.snapScaleStep = v; }

    // ── Ground grid (visible reference grid on Y=0) ──────────────────
    // Live viewport state (not document-persisted, like the snap settings above). Spacing
    // tracks snapGridSize so the visible grid == the grid you snap to. Frogmarks persists
    // these as a UI pref and re-applies via the ShapeManager properties on load.
    private _gridVisible = false;
    private _gridVisibleOverride = true;  // render-only context gate (e.g. hide in 2D mode); NOT persisted
    private _gridColor: [number, number, number] = [0.42, 0.42, 0.5];
    private _gridOpacity = 0.32;

    /** Show/hide the ground reference grid. */
    get gridVisible(): boolean { return this._gridVisible; }
    set gridVisible(v: boolean) { this._gridVisible = v; this._pushGridConfig(); }

    /** Render-only gate (NOT persisted) — e.g. hide the ground grid while a 2D/vector layer is active. */
    get gridVisibleOverride(): boolean { return this._gridVisibleOverride; }
    set gridVisibleOverride(v: boolean) { this._gridVisibleOverride = v; this._pushGridConfig(); }

    /** Minor grid-line color [r,g,b] 0..1 (the X/Z axis lines stay red/blue). */
    get gridColor(): [number, number, number] { return [this._gridColor[0], this._gridColor[1], this._gridColor[2]]; }
    set gridColor(c: [number, number, number]) { this._gridColor = [c[0], c[1], c[2]]; this._pushGridConfig(); }

    /** Grid-line opacity 0..1. */
    get gridOpacity(): number { return this._gridOpacity; }
    set gridOpacity(v: number) { this._gridOpacity = Math.max(0, Math.min(1, v)); this._pushGridConfig(); }

    /** Push grid render state to the renderer; spacing = the current transform snap size. */
    private _pushGridConfig(): void {
        this.renderer3D.setGridConfig(this._gridVisible && this._gridVisibleOverride, this._gridColor, this._gridOpacity, this.snapGridSize);
        this.ctx.scheduleRender();
    }

    /** True when Ctrl is held during a drag and snapping is active. */
    get snapActive(): boolean { return this._transformController?.snapActive ?? false; }

    /**
     * Returns live drag state for Frogmarks to render a degree readout overlay.
     * `angleDeg` is non-null only during a rotation drag.
     * `gizmoCenterWorld` can be projected to canvas coords for label placement.
     */
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

    // ── Viewport snapping ────────────────────────────────────────────

    /** Ctrl+drag snap mode. `'grid'` by default. */
    get snapMode(): SnapMode { return this._transformController?.snapMode ?? 'grid'; }
    set snapMode(m: SnapMode) { if (this._transformController) this._transformController.snapMode = m; }

    /** World-space position of the active vertex snap target during a drag; null otherwise. */
    getSnapTarget(): [number, number, number] | null {
        return this._transformController?.snapTarget ?? null;
    }

    /** Vertex-snap double-circle visualization (center + candidate squares), or null when not vertex-snapping. */
    getSnapViz(): SnapVizData | null {
        return this._transformController?.snapViz ?? null;
    }

    /** Vertex-snap INNER radius (px) — the snap threshold + inner circle. */
    get snapVertexRadiusPx(): number { return this._transformController?.snapVertexRadiusPx ?? 20; }
    set snapVertexRadiusPx(v: number) { if (this._transformController) this._transformController.snapVertexRadiusPx = v; }
    /** Vertex-snap OUTER radius (px) — candidate squares show inside it. */
    get snapCandidateRadiusPx(): number { return this._transformController?.snapCandidateRadiusPx ?? 50; }
    set snapCandidateRadiusPx(v: number) { if (this._transformController) this._transformController.snapCandidateRadiusPx = v; }

    /**
     * Project a world-space point onto the WebGPU canvas, returning canvas pixel coordinates.
     * Returns null when the point is behind the camera or the canvas is unavailable.
     */
    worldToScreen(worldPos: [number, number, number]): [number, number] | null {
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return null;
        const camera = this.renderer3D.getCamera();
        const vp = camera.getViewProjectionMatrix() as Float32Array;
        const [px, py, pz] = worldPos;
        // Clip space via VP matrix (column-major gl-matrix layout)
        const cx = vp[0]*px + vp[4]*py + vp[8]*pz  + vp[12];
        const cy = vp[1]*px + vp[5]*py + vp[9]*pz  + vp[13];
        const cw = vp[3]*px + vp[7]*py + vp[11]*pz + vp[15];
        if (Math.abs(cw) < 1e-6) return null;
        const nx = cx / cw;
        const ny = cy / cw;
        return [(nx + 1) * 0.5 * canvas.width, (1 - ny) * 0.5 * canvas.height];
    }

    // ── Viewport transform shortcuts ────────────────────────────────

    get isShortcutActive(): boolean { return this._transformController?.isShortcutActive ?? false; }
    get shortcutMode(): 'grab' | 'rotate' | 'scale' | null { return this._transformController?.shortcutMode ?? null; }
    get shortcutAxis(): 'x' | 'y' | 'z' | null { return this._transformController?.shortcutAxis ?? null; }
    get shortcutNumericDisplay(): string { return this._transformController?.shortcutNumericDisplay ?? ''; }

    beginTransform3D(mode: 'grab' | 'rotate' | 'scale'): void {
        this._transformController?.beginTransform3D(mode);
    }

    constrainAxis3D(axis: 'x' | 'y' | 'z'): void {
        this._transformController?.constrainAxis3D(axis);
    }

    appendNumericInput(char: string): void {
        this._transformController?.appendNumericInput(char);
    }

    commitTransform3D(): void {
        this._transformController?.commitTransform3D();
    }

    cancelTransform3D(): void {
        this._transformController?.cancelTransform3D();
    }

    // ── Keyframe animation ───────────────────────────────────────────

    /**
     * Attach to the raster timeline so that 3D mesh keyframes are applied
     * automatically whenever the current frame changes.
     *
     * Safe to call before the raster layer manager is ready — if the timeline
     * isn't available yet, a pre-render callback retries on every frame until
     * it connects, then removes itself. Calling this multiple times tears down
     * the previous subscription first (idempotent).
     */
    attachKeyframesToTimeline(): void {
        this._keyframeUnsub?.();
        this._keyframeUnsub = undefined;
        if (!this._tryAttachKeyframesToTimeline()) {
            // Timeline not ready yet — poll via pre-render callback until it is
            const retry = () => {
                if (this._tryAttachKeyframesToTimeline()) {
                    this.ctx.webgpuRenderer.removePreRenderCallback(retry);
                }
                return false; // never requests a render itself
            };
            this.ctx.webgpuRenderer.addPreRenderCallback(retry);
        }
    }

    /** @internal — attempts to subscribe; returns true if successful. */
    private _tryAttachKeyframesToTimeline(): boolean {
        const timeline = this.ctx.rasterLayerManager?.getTimeline();
        if (!timeline) return false;
        this._keyframeUnsub = timeline.on((e: any) => {
            if (e.type === 'frame-changed') {
                this.applyAllKeyframesAtFrame(e.frame ?? timeline.getCurrentFrame());
                this.ctx.scheduleRender();
            }
        });
        return true;
    }

    detachKeyframesFromTimeline(): void {
        this._keyframeUnsub?.();
        this._keyframeUnsub = undefined;
    }

    /**
     * Interpolate and apply all keyframe tracks for every mesh at the given frame.
     */
    applyAllKeyframesAtFrame(frame: number): void {
        for (const mesh of this.getAllMeshes()) {
            this.applyMeshKeyframesAtFrame(mesh.id, frame);
        }
        this.applyCameraKeyframesAtFrame(frame);
        // Mesh transforms changed — tell the renderer to re-upload instance matrices.
        // Without this, _instancesDirty stays false and uploadMeshInstances returns early,
        // leaving the GPU with stale model/normal matrices.
        this.renderer3D.markInstancesDirty();
    }

    applyCameraKeyframesAtFrame(frame: number): void {
        const t = this._cameraKeyframeTracks;
        const cam = this.renderer3D.getCamera();
        const pos = sampleTrack(t.position ?? [], frame, interpolateVec3);
        if (pos) cam.setPosition(pos[0], pos[1], pos[2]);
        const tgt = sampleTrack(t.target ?? [], frame, interpolateVec3);
        if (tgt) cam.setTarget(tgt[0], tgt[1], tgt[2]);
        const fov = sampleTrack(t.fov ?? [], frame, interpolateScalar);
        if (fov !== null) cam.fov = fov * Math.PI / 180;
    }

    applyMeshKeyframesAtFrame(meshId: string, frame: number): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        const tracks = mesh.keyframeTracks;

        const pos = sampleTrack(tracks.position ?? [], frame, interpolateVec3);
        if (pos) { mesh.x = pos[0]; mesh.y = pos[1]; mesh.z = pos[2]; }

        const rot = sampleTrack(tracks.rotation ?? [], frame, interpolateVec3);
        if (rot) { mesh.rotationX = rot[0]; mesh.rotationY = rot[1]; mesh.rotation = rot[2]; }

        const scale = sampleTrack(tracks.scale ?? [], frame, interpolateVec3);
        if (scale) { mesh.scaleX = scale[0]; mesh.scaleY = scale[1]; mesh.scaleZ = scale[2]; }

        const color = sampleTrack(tracks.diffuseColor ?? [], frame, interpolateVec4);
        if (color) mesh.setDiffuseColor(color[0], color[1], color[2], color[3]);

        const opacity = sampleTrack(tracks.opacity ?? [], frame, interpolateScalar);
        if (opacity !== null) mesh.setOpacity(opacity);

        const vis = sampleTrack(tracks.visible ?? [], frame, (a, _b, _t) => a);
        if (vis !== null) mesh.visible = vis;

        // Blend shape weight tracks
        if (tracks.blendWeights) {
            for (const [shapeName, track] of Object.entries(tracks.blendWeights)) {
                const w = sampleTrack(track, frame, interpolateScalar);
                if (w !== null) {
                    const idx = mesh.blendShapes.findIndex(s => s.name === shapeName);
                    if (idx >= 0) {
                        mesh.blendWeights[idx] = w;
                        mesh.gpuDirty = true;
                    }
                }
            }
            if (tracks.blendWeights && Object.keys(tracks.blendWeights).length > 0) {
                mesh.evaluateBlendShapes();
            }
        }

        // Apply frame-link animation delta on top of keyframed values
        // (scroll type is driven by _ensureScrollCb pre-render callback instead)
        const fla = this._frameLinkAnims3D.get(meshId);
        if (fla?.enabled && fla.type !== 'scroll') {
            const { pos: dp, rot: dr, scale: ds } = evalFrameLink3D(fla, frame);
            if (fla.type === 'spin') {
                // Spin accumulates intentionally — constant angular velocity via +=
                mesh.rotationX += dr[0]; mesh.rotationY += dr[1]; mesh.rotation += dr[2];
            } else {
                // Oscillating types: anchor to a rest pose so drift is structurally impossible.
                // Capture rest on the first frame this FLA runs (post-keyframe, pre-delta).
                // If a keyframe was applied this frame, use it as the base instead of rest.
                if (!this._flaRestTransforms.has(meshId)) {
                    this._flaRestTransforms.set(meshId, {
                        x: mesh.x, y: mesh.y, z: mesh.z,
                        rx: mesh.rotationX, ry: mesh.rotationY, rz: mesh.rotation,
                        sx: mesh.scaleX, sy: mesh.scaleY, sz: mesh.scaleZ,
                    });
                }
                const rest = this._flaRestTransforms.get(meshId)!;
                mesh.x  = (pos   ? pos[0]   : rest.x)  + dp[0];
                mesh.y  = (pos   ? pos[1]   : rest.y)  + dp[1];
                mesh.z  = (pos   ? pos[2]   : rest.z)  + dp[2];
                mesh.rotationX = (rot ? rot[0] : rest.rx) + dr[0];
                mesh.rotationY = (rot ? rot[1] : rest.ry) + dr[1];
                mesh.rotation  = (rot ? rot[2] : rest.rz) + dr[2];
                mesh.scaleX = (scale ? scale[0] : rest.sx) + ds[0];
                mesh.scaleY = (scale ? scale[1] : rest.sy) + ds[1];
                mesh.scaleZ = (scale ? scale[2] : rest.sz) + ds[2];
            }
        }
    }

    // ── Frame Link Animation 3D ──────────────────────────────────────

    /** Set (or replace) the procedural frame-link animation for a mesh or MeshGroup3D.
     *  When called on a group, the same config is written to every Mesh3D child (write-time
     *  propagation). Each child stores an independent entry so the evaluation and serialization
     *  paths are unchanged. */
    setFrameLinkAnimation3D(meshId: string, anim: Partial<FrameLinkAnimation3D>): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof MeshGroup3D) {
            let any = false;
            for (const child of node.children) {
                if (child instanceof Mesh3D) {
                    this.setFrameLinkAnimation3D(child.id, anim);
                    any = true;
                }
            }
            return any;
        }
        if (!this.getMesh(meshId)) return false;
        const existing = this._frameLinkAnims3D.get(meshId) ?? { ...DEFAULT_FRAME_LINK_ANIMATION_3D };
        const merged = { ...existing, ...anim };
        this._frameLinkAnims3D.set(meshId, merged);
        this._flaRestTransforms.delete(meshId); // re-capture rest on next frame
        if (merged.enabled && merged.type === 'scroll') {
            this._scrollRealFrames.set(meshId, 0);
            this._ensureRibbonUpdateCb();
            this.ctx.scheduleRender();
        }
        return true;
    }

    private _ensureRibbonUpdateCb(): void {
        if (this._ribbonUpdateCb) return;
        this._ribbonUpdateCb = () => {
            let hasActive = false;
            const cam = this.renderer3D.getCamera();
            const camPos: [number, number, number] = [cam.position[0], cam.position[1], cam.position[2]];

            // Rebuild camera-facing ribbons every frame
            for (const [meshId, ribbon] of this._ribbonData) {
                if (ribbon.pathMode !== 'camera-facing') continue;
                const mesh = this.getMesh(meshId);
                if (!mesh) continue;
                hasActive = true;
                mesh.setGeometry(generateRibbon({
                    controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
                    width: ribbon.width,
                    segments: ribbon.segments,
                    uvScrollOffset: ribbon.uvScrollOffset,
                    uvScrollOffsetV: ribbon.uvScrollOffsetV,
                    uvEndPadding: ribbon.uvEndPadding,
                    uvTileCount: ribbon.uvTileCount,
                    pathMode: ribbon.pathMode,
                    doubleSided: ribbon.doubleSided,
                    flipRearU: ribbon.flipRearU,
                    cameraPosition: camPos,
                }));
            }

            // Scroll UV animation
            for (const [meshId, fla] of this._frameLinkAnims3D) {
                if (!fla.enabled || fla.type !== 'scroll') continue;
                const ribbon = this._ribbonData.get(meshId);
                if (!ribbon) continue;
                const mesh = this.getMesh(meshId);
                if (!mesh) continue;
                hasActive = true;
                const frame = (this._scrollRealFrames.get(meshId) ?? 0) + 1;
                this._scrollRealFrames.set(meshId, frame);
                const { uvOffset } = evalFrameLink3D(fla, frame);
                if (fla.axis === 'y') {
                    ribbon.uvScrollOffsetV = uvOffset[1];
                } else {
                    ribbon.uvScrollOffset = uvOffset[0];
                }
                mesh.setGeometry(generateRibbon({
                    controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
                    width: ribbon.width,
                    segments: ribbon.segments,
                    uvScrollOffset: ribbon.uvScrollOffset,
                    uvScrollOffsetV: ribbon.uvScrollOffsetV,
                    uvEndPadding: ribbon.uvEndPadding,
                    uvTileCount: ribbon.uvTileCount,
                    pathMode: ribbon.pathMode,
                    doubleSided: ribbon.doubleSided,
                    flipRearU: ribbon.flipRearU,
                    cameraPosition: camPos,
                }));
            }

            if (!hasActive) {
                this.ctx.webgpuRenderer.removePreRenderCallback(this._ribbonUpdateCb!);
                this._ribbonUpdateCb = null;
            }
            return hasActive;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._ribbonUpdateCb);
    }

    /** Get the frame-link animation config for a mesh or group.
     *  For groups, returns the first child's config as a representative value. */
    getFrameLinkAnimation3D(meshId: string): FrameLinkAnimation3D | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof MeshGroup3D) {
            for (const child of node.children) {
                if (child instanceof Mesh3D) {
                    const fla = this._frameLinkAnims3D.get(child.id);
                    if (fla) return fla;
                }
            }
            return null;
        }
        return this._frameLinkAnims3D.get(meshId) ?? null;
    }

    /** Remove the frame-link animation from a mesh or all children of a MeshGroup3D. */
    removeFrameLinkAnimation3D(meshId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof MeshGroup3D) {
            let any = false;
            for (const child of node.children) {
                if (child instanceof Mesh3D) {
                    this._scrollRealFrames.delete(child.id);
                    this._flaRestTransforms.delete(child.id);
                    any = this._frameLinkAnims3D.delete(child.id) || any;
                }
            }
            return any;
        }
        this._scrollRealFrames.delete(meshId);
        this._flaRestTransforms.delete(meshId);
        return this._frameLinkAnims3D.delete(meshId);
    }

    setMeshKeyframe(
        meshId: string,
        property: TrackName,
        frame: number,
        value: any,
        easing: KeyframeEasing = 'linear',
    ): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        if (!mesh.keyframeTracks[property]) (mesh.keyframeTracks as any)[property] = [];
        const track: any[] = (mesh.keyframeTracks as any)[property];

        // Capture before-state for undo
        const existing = track.find((kf: any) => kf.frame === frame);
        const beforeValue = existing ? JSON.parse(JSON.stringify(existing.value)) : undefined;
        const beforeEasing: KeyframeEasing | undefined = existing?.easing;

        setKeyframe(track, frame, value, easing);
        mesh.stateDirty = true;

        this._undoManager.push({
            description: `Set keyframe: ${property} @ ${frame}`,
            undo: () => {
                const t: any[] = (mesh.keyframeTracks as any)[property];
                if (t) {
                    if (beforeValue === undefined) {
                        removeKeyframe(t, frame);
                    } else {
                        setKeyframe(t, frame, JSON.parse(JSON.stringify(beforeValue)), beforeEasing!);
                    }
                    mesh.stateDirty = true;
                }
            },
            redo: () => {
                if (!(mesh.keyframeTracks as any)[property]) (mesh.keyframeTracks as any)[property] = [];
                setKeyframe((mesh.keyframeTracks as any)[property], frame, JSON.parse(JSON.stringify(value)), easing);
                mesh.stateDirty = true;
            },
        });
        return true;
    }

    removeMeshKeyframe(meshId: string, property: TrackName, frame: number): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        const track = (mesh.keyframeTracks as any)[property];
        if (!track) return false;

        // Capture before removal for undo
        const existing = (track as any[]).find((kf: any) => kf.frame === frame);
        if (!existing) return false;
        const savedValue = JSON.parse(JSON.stringify(existing.value));
        const savedEasing: KeyframeEasing = existing.easing;

        const removed = removeKeyframe(track, frame);
        if (removed) {
            mesh.stateDirty = true;
            this._undoManager.push({
                description: `Remove keyframe: ${property} @ ${frame}`,
                undo: () => {
                    if (!(mesh.keyframeTracks as any)[property]) (mesh.keyframeTracks as any)[property] = [];
                    setKeyframe((mesh.keyframeTracks as any)[property], frame, JSON.parse(JSON.stringify(savedValue)), savedEasing);
                    mesh.stateDirty = true;
                },
                redo: () => {
                    const t: any[] = (mesh.keyframeTracks as any)[property];
                    if (t) { removeKeyframe(t, frame); mesh.stateDirty = true; }
                },
            });
        }
        return removed;
    }

    getMeshKeyframeTracks(meshId: string): Mesh3DKeyframeTracks | null {
        return this.getMesh(meshId)?.keyframeTracks ?? null;
    }

    clearMeshKeyframeTracks(meshId: string): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;

        // Deep-copy tracks before clearing for undo
        const savedTracks = JSON.parse(JSON.stringify(mesh.keyframeTracks));
        mesh.keyframeTracks = {};
        mesh.stateDirty = true;

        this._undoManager.push({
            description: 'Clear keyframe tracks',
            undo: () => {
                mesh.keyframeTracks = JSON.parse(JSON.stringify(savedTracks));
                mesh.stateDirty = true;
            },
            redo: () => {
                mesh.keyframeTracks = {};
                mesh.stateDirty = true;
            },
        });
        return true;
    }

    // ── Blend shape weight keyframes ─────────────────────────────────

    setBlendShapeKeyframe(meshId: string, shapeName: string, frame: number, weight: number, easing: KeyframeEasing = 'linear'): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        if (!mesh.keyframeTracks.blendWeights) mesh.keyframeTracks.blendWeights = {};
        if (!mesh.keyframeTracks.blendWeights[shapeName]) mesh.keyframeTracks.blendWeights[shapeName] = [];
        const track = mesh.keyframeTracks.blendWeights[shapeName];

        const existing = track.find(kf => kf.frame === frame);
        const beforeValue = existing?.value;
        const beforeEasing = existing?.easing;

        setKeyframe(track, frame, weight, easing);
        mesh.stateDirty = true;

        this._undoManager.push({
            description: `Set blend shape keyframe: ${shapeName} @ ${frame}`,
            undo: () => {
                const t = mesh.keyframeTracks.blendWeights?.[shapeName];
                if (t) {
                    if (beforeValue === undefined) removeKeyframe(t, frame);
                    else setKeyframe(t, frame, beforeValue, beforeEasing!);
                    mesh.stateDirty = true;
                }
            },
            redo: () => {
                if (!mesh.keyframeTracks.blendWeights) mesh.keyframeTracks.blendWeights = {};
                if (!mesh.keyframeTracks.blendWeights[shapeName]) mesh.keyframeTracks.blendWeights[shapeName] = [];
                setKeyframe(mesh.keyframeTracks.blendWeights[shapeName], frame, weight, easing);
                mesh.stateDirty = true;
            },
        });
        return true;
    }

    removeBlendShapeKeyframe(meshId: string, shapeName: string, frame: number): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        const track = mesh.keyframeTracks.blendWeights?.[shapeName];
        if (!track) return false;

        const existing = track.find(kf => kf.frame === frame);
        if (!existing) return false;
        const savedValue = existing.value;
        const savedEasing = existing.easing;

        const removed = removeKeyframe(track, frame);
        if (removed) {
            mesh.stateDirty = true;
            this._undoManager.push({
                description: `Remove blend shape keyframe: ${shapeName} @ ${frame}`,
                undo: () => {
                    if (!mesh.keyframeTracks.blendWeights) mesh.keyframeTracks.blendWeights = {};
                    if (!mesh.keyframeTracks.blendWeights[shapeName]) mesh.keyframeTracks.blendWeights[shapeName] = [];
                    setKeyframe(mesh.keyframeTracks.blendWeights[shapeName], frame, savedValue, savedEasing);
                    mesh.stateDirty = true;
                },
                redo: () => {
                    const t = mesh.keyframeTracks.blendWeights?.[shapeName];
                    if (t) { removeKeyframe(t, frame); mesh.stateDirty = true; }
                },
            });
        }
        return removed;
    }

    getBlendShapeKeyframeTracks(meshId: string): Record<string, Keyframe<number>[]> | null {
        const mesh = this.getMesh(meshId);
        return mesh?.keyframeTracks.blendWeights ?? null;
    }

    // ── Keyframe query helpers (for timeline UI) ─────────────────────

    /**
     * Returns the set of frame numbers where ANY track on this mesh has a keyframe.
     * Use this to draw per-frame markers in the animation timeline UI.
     */
    getMeshKeyframeFrames(meshId: string): number[] {
        const mesh = this.getMesh(meshId);
        if (!mesh) return [];
        const frames = new Set<number>();
        for (const [key, track] of Object.entries(mesh.keyframeTracks)) {
            if (Array.isArray(track)) {
                for (const kf of track) frames.add(kf.frame);
            } else if (key === 'blendWeights' && track && typeof track === 'object') {
                for (const shapeTrack of Object.values(track as Record<string, Keyframe<number>[]>)) {
                    for (const kf of shapeTrack) frames.add(kf.frame);
                }
            }
        }
        return Array.from(frames).sort((a, b) => a - b);
    }

    /** Returns true if the mesh has a keyframe on any track at exactly `frame`. */
    hasMeshKeyframeAtFrame(meshId: string, frame: number): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        for (const [key, track] of Object.entries(mesh.keyframeTracks)) {
            if (Array.isArray(track) && track.some(kf => kf.frame === frame)) return true;
            if (key === 'blendWeights' && track && typeof track === 'object') {
                for (const shapeTrack of Object.values(track as Record<string, Keyframe<number>[]>)) {
                    if (shapeTrack.some(kf => kf.frame === frame)) return true;
                }
            }
        }
        return false;
    }

    /**
     * Returns a flat list of every Mesh3D in the scene with id and name.
     * Use this to populate the animation panel's mesh rows — it includes
     * meshes nested inside groups.
     */
    getAllMeshesForAnimation(): { id: string; name: string }[] {
        return this.getAllMeshes().map(m => ({ id: m.id, name: m.name }));
    }

    /**
     * Returns keyframe track data for every mesh in the scene.
     * Use this to build per-mesh dope-sheet rows in the animation panel.
     * Each entry's `tracks` object has the same shape as getMeshKeyframeTracks().
     */
    getAllMeshKeyframeTracks(): { meshId: string; name: string; tracks: Mesh3DKeyframeTracks }[] {
        return this.getAllMeshes().map(m => ({
            meshId: m.id,
            name: m.name,
            tracks: m.keyframeTracks,
        }));
    }

    // ── Camera keyframe API ──────────────────────────────────────────

    /** Set a keyframe on a camera track ('position' | 'target' | 'fov'). */
    setCameraKeyframe(property: CameraTrackName, frame: number, value: any, easing: KeyframeEasing = 'linear'): void {
        if (!this._cameraKeyframeTracks[property]) {
            (this._cameraKeyframeTracks as any)[property] = [];
        }
        setKeyframe((this._cameraKeyframeTracks as any)[property], frame, value, easing);
    }

    /** Remove a keyframe from a camera track. */
    removeCameraKeyframe(property: CameraTrackName, frame: number): boolean {
        const track = (this._cameraKeyframeTracks as any)[property];
        if (!track) return false;
        return removeKeyframe(track, frame);
    }

    /** Get all camera keyframe tracks. */
    getCameraKeyframeTracks(): Camera3DKeyframeTracks {
        return this._cameraKeyframeTracks;
    }

    /** Clear all camera keyframe tracks. */
    clearCameraKeyframeTracks(): void {
        this._cameraKeyframeTracks = {};
    }

    /**
     * Snapshot the current camera position, target, and FOV as keyframes at `frame`.
     * If frame is omitted, reads the current raster timeline frame (defaults to 0).
     */
    recordCameraKeyframe(frame?: number): void {
        const f = frame ?? this.ctx.rasterLayerManager?.getTimeline()?.getCurrentFrame() ?? 0;
        const cam = this.renderer3D.getCamera();
        this.setCameraKeyframe('position', f, [cam.position[0], cam.position[1], cam.position[2]]);
        this.setCameraKeyframe('target',   f, [cam.target[0],   cam.target[1],   cam.target[2]]);
        this.setCameraKeyframe('fov',      f, cam.fov * 180 / Math.PI);
    }

    /** When true, every completed gizmo drag auto-records keyframes at the current timeline frame. */
    autoKey3D = false;

    /**
     * Snapshot a mesh's current position/rotation/scale as keyframes at `frame`.
     * If frame is omitted, reads the current raster timeline frame (defaults to 0).
     */
    recordKeyframeForMesh(meshId: string, frame?: number): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh) return false;
        const f = frame ?? this.ctx.rasterLayerManager?.getTimeline()?.getCurrentFrame() ?? 0;
        this.setMeshKeyframe(meshId, 'position', f, [mesh.x, mesh.y, mesh.z]);
        this.setMeshKeyframe(meshId, 'rotation', f, [mesh.rotationX, mesh.rotationY, mesh.rotation]);
        this.setMeshKeyframe(meshId, 'scale',    f, [mesh.scaleX, mesh.scaleY, mesh.scaleZ]);
        return true;
    }

    /**
     * Record keyframes for every currently selected 3D mesh at the given (or current) frame.
     * Returns the count of meshes keyed.
     */
    recordKeyframesForSelectedMeshes(frame?: number): number {
        let count = 0;
        for (const id of this.renderer3D.getSelectedMeshIds()) {
            if (this.recordKeyframeForMesh(id, frame)) count++;
        }
        return count;
    }

    // ── Texture library ──────────────────────────────────────────────

    getTextureLibrary(): TextureLibrary {
        if (!this._textureLibrary) {
            const device = this.ctx.webgpuRenderer.getDevice();
            if (!device) throw new Error('Scene3DManager: WebGPU device not available');
            this._textureLibrary = new TextureLibrary(device);
        }
        return this._textureLibrary;
    }

    /**
     * Upload a texture to the library and apply it to the given mesh.
     * Returns the library texture ID.
     */
    async uploadAndApplyTexture(
        meshId: string,
        source: File | Blob | ImageBitmap,
        name?: string,
    ): Promise<string | null> {
        const mesh = this.getMesh(meshId);
        if (!mesh) return null;

        const lib = this.getTextureLibrary();
        const id  = await lib.upload(source, name);
        const tex = lib.getTexture(id);
        if (!tex) return null;

        if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        mesh.textureLibraryId = id;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return id;
    }

    /**
     * Apply an already-uploaded library texture to a mesh by ID.
     */
    applyLibraryTexture(meshId: string, textureId: string): boolean {
        const mesh = this.getMesh(meshId);
        const tex  = this.getTextureLibrary().getTexture(textureId);
        if (!mesh || !tex) return false;
        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        mesh.textureLibraryId = textureId;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    // ── Animation player ─────────────────────────────────────────────

    /**
     * Create (or replace) an AnimationPlayer3D that drives keyframe playback.
     * The player automatically calls applyAllKeyframesAtFrame on every frame tick.
     */
    createAnimationPlayer(config?: AnimationPlayer3DConfig): AnimationPlayer3D {
        this.destroyAnimationPlayer();
        this._animPlayer = new AnimationPlayer3D(config);
        this._animPlayer.onFrame((frame) => {
            this.applyAllKeyframesAtFrame(frame);
            this.ctx.scheduleRender();
        });
        return this._animPlayer;
    }

    getAnimationPlayer(): AnimationPlayer3D | undefined {
        return this._animPlayer;
    }

    destroyAnimationPlayer(): void {
        this._animPlayer?.destroy();
        this._animPlayer = undefined;
    }

    // ── Skeleton animation ────────────────────────────────────────────

    /**
     * Create an AnimationPlayer3D that drives a SkeletonAnimClip on a Skeleton3D node.
     * The player's onFrame handler interpolates joint poses each tick and recomputes
     * skin matrices.  The returned player starts paused — call player.play() to begin.
     * Destroy the player when done to stop the RAF loop.
     */
    playSkeletonClip(skeletonId: string, clip: SkeletonAnimClip): AnimationPlayer3D {
        const skeleton = this.getSkeleton(skeletonId);
        if (!skeleton) throw new Error(`Skeleton not found: ${skeletonId}`);

        const player = new AnimationPlayer3D({
            startFrame: clip.startFrame,
            endFrame:   clip.endFrame,
            fps:        clip.fps,
            loop:       true,
        });

        player.onFrame(frame => {
            applySkeletonClipAtFrame(clip, skeleton, frame);
            this.ctx.scheduleRender();
        });

        return player;
    }

    // ── Non-Linear Animation (NLA) ────────────────────────────────────

    /**
     * Create a new NLATrack for the given skeleton.
     * The bind pose is captured immediately from the skeleton's current joint state
     * and held for the lifetime of the track.
     */
    createNLATrack3D(
        skeletonId: string,
        name: string,
        fps = 24,
        loop = true,
    ): string {
        const skeleton = this.getSkeleton(skeletonId);
        if (!skeleton) throw new Error(`Skeleton not found: ${skeletonId}`);

        const trackId = _nanoid();
        const track: NLATrack = { id: trackId, name, skeletonId, segments: [], fps, loop };
        this._nlaTracks.set(trackId, track);

        // Snapshot bind pose if not yet captured for this skeleton.
        if (!this._nlaBindPoses.has(skeletonId)) {
            this._nlaBindPoses.set(skeletonId, snapshotSkeletonPose(skeleton));
        }

        // Persist the track on the skeleton data so it survives save/load.
        skeleton.data.nlaTracks ??= [];
        skeleton.data.nlaTracks.push(track);

        return trackId;
    }

    getNLATracks3D(skeletonId: string): NLATrack[] {
        return Array.from(this._nlaTracks.values()).filter(t => t.skeletonId === skeletonId);
    }

    addNLASegment3D(
        trackId: string,
        clipId: string,
        startFrame: number,
        opts?: Partial<Omit<NLAClipSegment, 'clipId' | 'startFrame'>>,
    ): number {
        const track = this._nlaTracks.get(trackId);
        if (!track) throw new Error(`NLA track not found: ${trackId}`);
        const seg: NLAClipSegment = {
            clipId,
            startFrame,
            clipStartOffset: opts?.clipStartOffset ?? 0,
            weight:          opts?.weight ?? 1,
            blendMode:       opts?.blendMode ?? 'replace',
            fadeIn:          opts?.fadeIn ?? 0,
            fadeOut:         opts?.fadeOut ?? 0,
        };
        track.segments.push(seg);
        return track.segments.length - 1;
    }

    removeNLASegment3D(trackId: string, segIndex: number): void {
        const track = this._nlaTracks.get(trackId);
        if (!track) return;
        track.segments.splice(segIndex, 1);
    }

    updateNLASegment3D(trackId: string, segIndex: number, updates: Partial<NLAClipSegment>): void {
        const track = this._nlaTracks.get(trackId);
        if (!track || !track.segments[segIndex]) return;
        Object.assign(track.segments[segIndex], updates);
    }

    /**
     * Start an AnimationPlayer3D that drives the NLA track.
     * Returns the player (starts paused — call player.play() to begin).
     */
    playNLATrack3D(trackId: string): AnimationPlayer3D {
        this.stopNLATrack3D(trackId);

        const track = this._nlaTracks.get(trackId);
        if (!track) throw new Error(`NLA track not found: ${trackId}`);

        const skeleton = this.getSkeleton(track.skeletonId);
        if (!skeleton) throw new Error(`Skeleton not found: ${track.skeletonId}`);

        const bindPose = this._nlaBindPoses.get(track.skeletonId)!;
        const clips    = skeleton.data.clips ?? [];

        // Compute total timeline span from the latest segment end.
        const totalFrames = track.segments.reduce((max, seg) => {
            const clip = clips.find(c => c.id === seg.clipId);
            const dur  = clip ? clip.endFrame - clip.startFrame - seg.clipStartOffset : 0;
            return Math.max(max, seg.startFrame + dur);
        }, 1);

        const player = new AnimationPlayer3D({
            startFrame: 0,
            endFrame:   totalFrames,
            fps:        track.fps,
            loop:       track.loop,
        });

        player.onFrame(frame => {
            evaluateNLAAtFrame(track, clips, skeleton, bindPose, frame);
            this.ctx.scheduleRender();
        });

        this._nlaPlayers.set(trackId, player);
        return player;
    }

    stopNLATrack3D(trackId: string): void {
        const player = this._nlaPlayers.get(trackId);
        if (player) {
            player.destroy();
            this._nlaPlayers.delete(trackId);
        }
    }

    seekNLATrack3D(trackId: string, frame: number): void {
        const track = this._nlaTracks.get(trackId);
        if (!track) return;
        const skeleton = this.getSkeleton(track.skeletonId);
        if (!skeleton) return;
        const bindPose = this._nlaBindPoses.get(track.skeletonId);
        if (!bindPose) return;
        const clips = skeleton.data.clips ?? [];
        evaluateNLAAtFrame(track, clips, skeleton, bindPose, frame);
        this.ctx.scheduleRender();
    }

    /**
     * Schedule a crossfade: ramps fromSeg weight 1→0 and toSeg weight 0→1
     * over `durationFrames` at the current player position.
     */
    crossfade3D(trackId: string, fromSegIdx: number, toSegIdx: number, durationFrames: number): void {
        const track = this._nlaTracks.get(trackId);
        if (!track) return;
        const player = this._nlaPlayers.get(trackId);
        if (!player) return;

        const fromSeg = track.segments[fromSegIdx];
        const toSeg   = track.segments[toSegIdx];
        if (!fromSeg || !toSeg) return;

        const startFrame = player.currentFrame;
        fromSeg.fadeOut = durationFrames;
        toSeg.startFrame = startFrame;
        toSeg.fadeIn     = durationFrames;
    }

    // ── GLTF / GLB Export ────────────────────────────────────────────

    /**
     * Export all Mesh3D and Skeleton3D objects in the scene to a GLB blob.
     * Returns the result synchronously (no GPU readback; all data is CPU-side).
     */
    exportSceneGltf3D(): GltfExportResult {
        return exportSceneToGlb(this.getAllMeshes(), this.getAllSkeletons());
    }

    // ── Skeleton authoring — creation ─────────────────────────────────

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

    /** Move a joint's local position. */
    moveBone3D(skeletonId: string, jointIndex: number, localPos: [number, number, number]): void {
        this.getSkeleton(skeletonId)?.moveJoint(jointIndex, localPos);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Set the visual tail offset for a joint (in the joint's own local frame). */
    setJointTailOffset3D(skeletonId: string, jointIndex: number, offset: [number, number, number]): void {
        this.getSkeleton(skeletonId)?.setJointTailOffset(jointIndex, offset);
        this.ctx.scheduleRender();
    }

    /** Remove a joint and all its descendants, re-indexing remaining joints. */
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

    /** Rename a joint. */
    renameBone3D(skeletonId: string, jointIndex: number, name: string): void {
        this.getSkeleton(skeletonId)?.renameJoint(jointIndex, name);
        this.ctx.emitSceneGraphChanged();
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

        parent.removeChild(mesh);
        this.ctx.sceneGraph.unregisterNode(mesh);
        parent.addChild(skinnedMesh);
        this.ctx.sceneGraph.registerNode(skinnedMesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return true;
    }

    // ── Skeleton authoring — weight paint ─────────────────────────────

    /**
     * Return indices of vertices on `meshId` whose world-space position is within
     * `radius` of the given world point. Uses the mesh's current model matrix.
     */
    getVerticesNearPoint3D(meshId: string, wx: number, wy: number, wz: number, radius: number): number[] {
        const mesh = this.getMesh(meshId) as import('../../scene-graph/shapes/mesh-3d').Mesh3D | null;
        if (!mesh) return [];
        const geom = mesh.geometry;
        if (!geom || geom.vertices.length === 0) return [];
        const m = mesh.localMatrix as unknown as Float32Array;
        const r2 = radius * radius;
        const result: number[] = [];
        const verts = geom.vertices;
        for (let i = 0, vi = 0; vi < verts.length; i++, vi += FLOATS_PER_VERT) {
            const px = verts[vi], py = verts[vi + 1], pz = verts[vi + 2];
            // Transform vertex position by model matrix
            const wpx = m[0]*px + m[4]*py + m[8]*pz  + m[12];
            const wpy = m[1]*px + m[5]*py + m[9]*pz  + m[13];
            const wpz = m[2]*px + m[6]*py + m[10]*pz + m[14];
            const dx = wpx - wx, dy = wpy - wy, dz = wpz - wz;
            if (dx*dx + dy*dy + dz*dz <= r2) result.push(i);
        }
        return result;
    }

    /** Enter weight-paint mode: saves vertex colors and shows heatmap for `jointIndex`. */
    enterWeightPaintMode3D(meshId: string, skeletonId: string, jointIndex: number): boolean {
        const mesh = this.getSkinnedMesh(meshId);
        if (!mesh) return false;
        this._weightPaintMeshId = meshId;
        this._weightPaintJointIndex = jointIndex;
        this._weightPaintSavedColors = mesh.vertexColors ? new Float32Array(mesh.vertexColors) : null;
        this._applyWeightHeatmap(meshId, jointIndex);
        this.renderer3D.setWeightPaintActive(true);
        this.renderer3D.setWeightPaintMesh(mesh);
        this.renderer3D.setWeightPaintBrushRadius(this._wpBrushRadius);
        this.renderer3D.setWeightPaintBrushCenter(null);
        if (this._orbitController) this._orbitController.enabled = false;
        this._setupWeightPaintListeners();
        return true;
    }

    /**
     * Switch the active weight-paint joint without re-entering the mode.
     * Refreshes the heatmap for the new joint index.
     */
    setWeightPaintJoint3D(jointIndex: number): void {
        if (!this._weightPaintMeshId) return;
        this._weightPaintJointIndex = jointIndex;
        this._applyWeightHeatmap(this._weightPaintMeshId, jointIndex);
    }

    private _applyWeightHeatmap(meshId: string, jointIndex: number): void {
        const mesh = this.getSkinnedMesh(meshId);
        if (!mesh) return;
        const vertCount = mesh.geometry.vertices.length / 12; // 12 floats per vertex
        if (!mesh.vertexColors || mesh.vertexColors.length !== vertCount * 4) {
            mesh.vertexColors = new Float32Array(vertCount * 4);
        }
        for (let vi = 0; vi < vertCount; vi++) {
            let w = 0;
            for (let k = 0; k < 4; k++) {
                if (mesh.jointIndices[vi * 4 + k] === jointIndex) {
                    w = mesh.jointWeights[vi * 4 + k];
                    break;
                }
            }
            // Heat color: 0→blue, 0.5→green, 1→red
            let r: number, g: number, b: number;
            if (w < 0.5) { r = 0; g = w * 2; b = 1 - w * 2; }
            else { r = (w - 0.5) * 2; g = 1 - (w - 0.5) * 2; b = 0; }
            mesh.vertexColors[vi * 4 + 0] = r;
            mesh.vertexColors[vi * 4 + 1] = g;
            mesh.vertexColors[vi * 4 + 2] = b;
            mesh.vertexColors[vi * 4 + 3] = 1;
        }
        this.ctx.scheduleRender();
    }

    /** Paint weights on a set of vertices. Normalizes all weights after each stroke. */
    paintWeightDab3D(meshId: string, jointIndex: number, vertexIndices: number[], targetWeight: number, brushStrength: number): void {
        const mesh = this.getSkinnedMesh(meshId);
        if (!mesh) return;
        for (const vi of vertexIndices) {
            const base = vi * 4;
            // Find slot for this joint, or the slot with the smallest weight
            let slot = -1;
            let minW = Infinity;
            let minSlot = 0;
            for (let k = 0; k < 4; k++) {
                if (mesh.jointIndices[base + k] === jointIndex) { slot = k; break; }
                if (mesh.jointWeights[base + k] < minW) { minW = mesh.jointWeights[base + k]; minSlot = k; }
            }
            if (slot < 0) { slot = minSlot; mesh.jointIndices[base + slot] = jointIndex; }
            const cur = mesh.jointWeights[base + slot];
            mesh.jointWeights[base + slot] = cur + (targetWeight - cur) * brushStrength;
        }
        this.normalizeWeights3D(meshId);
        if (this._weightPaintJointIndex !== null) this._applyWeightHeatmap(meshId, this._weightPaintJointIndex);
    }

    /** Normalize all vertex weights so each vertex's 4 weights sum to 1.0. */
    normalizeWeights3D(meshId: string): void {
        const mesh = this.getSkinnedMesh(meshId);
        if (!mesh) return;
        const vc = mesh.jointWeights.length / 4;
        for (let vi = 0; vi < vc; vi++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += mesh.jointWeights[vi * 4 + k];
            if (sum > 0) for (let k = 0; k < 4; k++) mesh.jointWeights[vi * 4 + k] /= sum;
        }
        mesh.skinDirty = true;
    }

    /** Exit weight-paint mode: restore saved vertex colors. */
    exitWeightPaintMode3D(): void {
        if (!this._weightPaintMeshId) return;
        const mesh = this.getSkinnedMesh(this._weightPaintMeshId);
        if (mesh) {
            if (mesh.editMesh) {
                const saved = this._weightPaintSavedColors;
                if (saved) {
                    for (let vi = 0; vi < mesh.editMesh.vertices.length; vi++) {
                        mesh.editMesh.vertices[vi].color = [saved[vi*4], saved[vi*4+1], saved[vi*4+2], saved[vi*4+3]];
                    }
                } else {
                    for (const v of mesh.editMesh.vertices) v.color = [0.8, 0.8, 0.8, 1];
                }
                mesh.syncFromEditMesh();
            } else {
                // GLB mesh — restore vertexColors directly; null = revert to material color
                mesh.vertexColors = this._weightPaintSavedColors
                    ? new Float32Array(this._weightPaintSavedColors)
                    : null;
            }
        }
        this._weightPaintMeshId = null;
        this._weightPaintJointIndex = null;
        this._weightPaintSavedColors = null;
        this._weightPaintListenerCleanup?.();
        this._weightPaintListenerCleanup = undefined;
        this._wpPointerDown = false;
        this._wpBrushCenter = null;
        this.renderer3D.setWeightPaintActive(false);
        this.renderer3D.setWeightPaintMesh(null);
        this.renderer3D.setWeightPaintBrushCenter(null);
        if (this._orbitController) this._orbitController.enabled = true;
        this.ctx.scheduleRender();
    }

    setWeightPaintShowSkeleton(show: boolean): void {
        this.renderer3D.setWeightPaintShowSkeleton(show);
        this.ctx.scheduleRender();
    }

    setWeightPaintUnlit(unlit: boolean): void {
        this.renderer3D.setWeightPaintUnlit(unlit);
        this.ctx.scheduleRender();
    }

    // ── IK Chain API ─────────────────────────────────────────────────────────

    /**
     * Add an IK chain to a skeleton. Returns the new chain's id.
     * The initial target is placed at the end-effector's current world position.
     */
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

    /**
     * Set the FK/IK blend weight for a chain: 0 = pure FK, 1 = pure IK (default).
     * Values in between slerp localRotation → IK rotation for smooth FK/IK transitions.
     */
    setIKBlendWeight(skelId: string, chainId: string, weight: number): void {
        const chain = this.getSkeleton(skelId)?.data.ikChains?.find(c => c.id === chainId);
        if (!chain) return;
        chain.blendWeight = Math.max(0, Math.min(1, weight));
        this.ctx.scheduleRender();
    }

    /**
     * Set the pole vector target world position for a chain.
     * If the chain had no pole target before, this activates the pole constraint.
     */
    setPoleTarget(skelId: string, chainId: string, x: number, y: number, z: number): void {
        const chain = this.getSkeleton(skelId)?.data.ikChains?.find(c => c.id === chainId);
        if (!chain) return;
        chain.poleTarget = [x, y, z];
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** Remove the pole vector from a chain, reverting to unconstrained FABRIK. */
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

    /**
     * Highlight a joint by index in the bone overlay (e.g. on UI list hover).
     * Pass null to clear. Does not affect canvas pointer hover state.
     */
    highlightJoint3D(jointIndex: number | null): void {
        this.renderer3D.setHighlightJoint(jointIndex);
        this.ctx.scheduleRender();
    }

    /** Whether weight paint mode is currently active. */
    isWeightPainting(): boolean { return this._weightPaintMeshId !== null; }

    /** Configure the weight paint brush. Call whenever the UI sliders change. */
    setWeightPaintBrush(radius: number, strength: number, targetWeight: number): void {
        this._wpBrushRadius  = radius;
        this._wpBrushStrength = strength;
        this._wpTargetWeight  = targetWeight;
        this.renderer3D.setWeightPaintBrushRadius(radius);
    }

    private _setupWeightPaintListeners(): void {
        this._weightPaintListenerCleanup?.();
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;

        // Brush preview circle element
        const circle = document.createElement('div');
        circle.style.cssText = 'position:fixed;border:2px solid rgba(255,255,255,0.85);border-radius:50%;pointer-events:none;display:none;box-shadow:0 0 0 1px rgba(0,0,0,0.45);transform:translate(-50%,-50%);z-index:9999;';
        document.body.appendChild(circle);
        this._wpBrushCircle = circle;
        canvas.style.cursor = 'none';

        const updateCircle = (e: PointerEvent) => {
            if (!this._weightPaintMeshId) { circle.style.display = 'none'; return; }
            const rect = canvas.getBoundingClientRect();
            const hit = this.pickFromClient3D(e.clientX, e.clientY, rect);
            if (!hit || hit.meshId !== this._weightPaintMeshId) {
                circle.style.display = 'none';
                this._wpBrushCenter = null;
                this.renderer3D.setWeightPaintBrushCenter(null);
                this.ctx.scheduleRender();
                return;
            }
            this._wpBrushCenter = hit.hitPoint as [number, number, number];
            this.renderer3D.setWeightPaintBrushCenter(this._wpBrushCenter);
            this.ctx.scheduleRender();

            const cam = this.getCamera();
            const vp = mat4.multiply(mat4.create(),
                cam.getProjectionMatrix() as unknown as mat4,
                cam.getViewMatrix() as unknown as mat4);
            const [hx, hy, hz] = hit.hitPoint;
            const clipC = vec4.transformMat4(vec4.create(), vec4.fromValues(hx, hy, hz, 1), vp);
            const clipR = vec4.transformMat4(vec4.create(), vec4.fromValues(hx + this._wpBrushRadius, hy, hz, 1), vp);
            if (Math.abs(clipC[3]) < 1e-6) { circle.style.display = 'none'; return; }
            const cSx = (clipC[0] / clipC[3] + 1) * 0.5 * canvas.width;
            const cSy = (1 - clipC[1] / clipC[3]) * 0.5 * canvas.height;
            const rSx = Math.abs(clipR[3]) < 1e-6 ? cSx + 1 : (clipR[0] / clipR[3] + 1) * 0.5 * canvas.width;
            const rSy = Math.abs(clipR[3]) < 1e-6 ? cSy : (1 - clipR[1] / clipR[3]) * 0.5 * canvas.height;
            const cssScale = rect.width / canvas.width;
            const radiusPx = Math.max(4, Math.sqrt((rSx - cSx) ** 2 + (rSy - cSy) ** 2) * cssScale);
            const diam = radiusPx * 2;

            circle.style.display = 'block';
            circle.style.left = e.clientX + 'px';
            circle.style.top = e.clientY + 'px';
            circle.style.width = diam + 'px';
            circle.style.height = diam + 'px';
        };

        const onPointerDown = (e: PointerEvent) => {
            if (e.button !== 0 || !this._weightPaintMeshId) return;
            this._wpPointerDown = true;
            this._doPaintStroke(e);
            e.stopPropagation();
        };
        const onPointerMove = (e: PointerEvent) => {
            updateCircle(e);
            if (!this._wpPointerDown || !this._weightPaintMeshId) return;
            this._doPaintStroke(e);
            e.stopPropagation();
        };
        const onPointerUp = (e: PointerEvent) => {
            if (e.button !== 0) return;
            this._wpPointerDown = false;
        };
        const onPointerLeave = () => {
            circle.style.display = 'none';
            this._wpBrushCenter = null;
            this.renderer3D.setWeightPaintBrushCenter(null);
            this.ctx.scheduleRender();
        };

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerleave', onPointerLeave);
        window.addEventListener('pointerup', onPointerUp);

        this._weightPaintListenerCleanup = () => {
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerleave', onPointerLeave);
            window.removeEventListener('pointerup', onPointerUp);
            circle.remove();
            this._wpBrushCircle = null;
            canvas.style.cursor = '';
        };
    }

    private _doPaintStroke(e: PointerEvent): void {
        const meshId = this._weightPaintMeshId;
        const jointIndex = this._weightPaintJointIndex;
        if (meshId === null || jointIndex === null) return;
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const hit = this.pickFromClient3D(e.clientX, e.clientY, rect);
        if (!hit || hit.meshId !== meshId) return;
        const [hx, hy, hz] = hit.hitPoint;
        const verts = this.getVerticesNearPoint3D(meshId, hx, hy, hz, this._wpBrushRadius);
        if (verts.length === 0) return;
        this.paintWeightDab3D(meshId, jointIndex, verts, this._wpTargetWeight, this._wpBrushStrength);
    }

    // ── Skeleton authoring — clip authoring ───────────────────────────

    /** Create a new animation clip on a skeleton. Returns the clip ID. */
    createSkeletonClip3D(skeletonId: string, name: string, fps: number, endFrame: number): string {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return '';
        if (!skel.data.clips) skel.data.clips = [];
        const id = crypto.randomUUID();
        skel.data.clips.push({ id, name, startFrame: 0, endFrame, fps, tracks: [] });
        return id;
    }

    private _findClip(clipId: string): { skel: Skeleton3D; clip: SkeletonAnimClip } | null {
        for (const skel of this.getAllSkeletons()) {
            for (const clip of skel.data.clips ?? []) {
                if (clip.id === clipId) return { skel, clip };
            }
        }
        return null;
    }

    /** Set or update a keyframe on a track. Creates the track if needed. */
    setClipJointKeyframe3D(clipId: string, jointIndex: number, channel: 'translation' | 'rotation' | 'scale', frame: number, value: number[]): void {
        const found = this._findClip(clipId);
        if (!found) return;
        const { clip } = found;
        let track = clip.tracks.find(t => t.jointIndex === jointIndex && t.channel === channel);
        if (!track) {
            track = { jointIndex, channel, keyframes: [] };
            clip.tracks.push(track);
        }
        const existing = track.keyframes.findIndex(k => k.frame === frame);
        if (existing >= 0) track.keyframes[existing].value = value;
        else track.keyframes.push({ frame, value });
        track.keyframes.sort((a, b) => a.frame - b.frame);
    }

    /** Remove a keyframe from a track. */
    removeClipJointKeyframe3D(clipId: string, jointIndex: number, channel: 'translation' | 'rotation' | 'scale', frame: number): void {
        const found = this._findClip(clipId);
        if (!found) return;
        const track = found.clip.tracks.find(t => t.jointIndex === jointIndex && t.channel === channel);
        if (!track) return;
        track.keyframes = track.keyframes.filter(k => k.frame !== frame);
    }

    /** Return all clips authored on a skeleton. */
    getSkeletonClips3D(skeletonId: string): SkeletonAnimClip[] {
        return this.getSkeleton(skeletonId)?.data.clips ?? [];
    }

    /** Delete a clip from whichever skeleton owns it. */
    deleteSkeletonClip3D(clipId: string): void {
        const found = this._findClip(clipId);
        if (!found) return;
        found.skel.data.clips = (found.skel.data.clips ?? []).filter(c => c.id !== clipId);
    }

    /** Record the current joint poses as keyframes at `frame` in an existing clip. */
    recordSkeletonPose3D(skeletonId: string, clipId: string, frame: number): void {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return;
        for (const j of skel.data.joints) {
            this.setClipJointKeyframe3D(clipId, j.index, 'translation', frame, [...j.localPosition]);
            this.setClipJointKeyframe3D(clipId, j.index, 'rotation',    frame, [...j.localRotation]);
            this.setClipJointKeyframe3D(clipId, j.index, 'scale',       frame, [...j.localScale]);
        }
    }

    // ── IK Keyframe API ───────────────────────────────────────────────

    /**
     * Set or update a keyframe on an IK chain property track.
     * Creates the track if it doesn't exist yet.
     *   'target'      → value = [x, y, z]
     *   'poleTarget'  → value = [x, y, z]
     *   'blendWeight' → value = [w]  (0–1)
     */
    setIKKeyframe(
        clipId: string,
        chainId: string,
        property: IKKeyframeTrack['property'],
        frame: number,
        value: number[],
    ): void {
        const found = this._findClip(clipId);
        if (!found) return;
        const { clip } = found;
        if (!clip.ikTracks) clip.ikTracks = [];
        let track = clip.ikTracks.find(t => t.chainId === chainId && t.property === property);
        if (!track) {
            track = { chainId, property, keyframes: [] };
            clip.ikTracks.push(track);
        }
        const idx = track.keyframes.findIndex(k => k.frame === frame);
        if (idx >= 0) track.keyframes[idx].value = value;
        else track.keyframes.push({ frame, value });
        track.keyframes.sort((a, b) => a.frame - b.frame);
    }

    /** Remove a keyframe from an IK chain property track. */
    removeIKKeyframe(
        clipId: string,
        chainId: string,
        property: IKKeyframeTrack['property'],
        frame: number,
    ): void {
        const found = this._findClip(clipId);
        if (!found) return;
        const track = found.clip.ikTracks?.find(t => t.chainId === chainId && t.property === property);
        if (!track) return;
        track.keyframes = track.keyframes.filter(k => k.frame !== frame);
    }

    /**
     * Record the current IK state for all enabled chains as keyframes at `frame`.
     * Captures: target, poleTarget (when set), and blendWeight for each enabled chain.
     */
    recordIKPose(skeletonId: string, clipId: string, frame: number): void {
        const skel = this.getSkeleton(skeletonId);
        if (!skel?.data.ikChains) return;
        for (const chain of skel.data.ikChains) {
            if (!chain.enabled) continue;
            this.setIKKeyframe(clipId, chain.id, 'target', frame, [...chain.target]);
            if (chain.poleTarget) {
                this.setIKKeyframe(clipId, chain.id, 'poleTarget', frame, [...chain.poleTarget]);
            }
            this.setIKKeyframe(clipId, chain.id, 'blendWeight', frame, [chain.blendWeight ?? 1]);
        }
    }

    // ── Bone Constraints ─────────────────────────────────────────────────

    addJointConstraint(skelId: string, jointIndex: number, constraint: import('../../types/armature-3d').JointConstraint): number {
        const joint = this.getSkeleton(skelId)?.data.joints[jointIndex];
        if (!joint) return -1;
        if (!joint.constraints) joint.constraints = [];
        joint.constraints.push(constraint);
        const skel = this.getSkeleton(skelId)!;
        clearAllConstraintState(skel);
        this.ctx.emitSceneGraphChanged();
        return joint.constraints.length - 1;
    }

    removeJointConstraint(skelId: string, jointIndex: number, constraintIndex: number): void {
        const joint = this.getSkeleton(skelId)?.data.joints[jointIndex];
        if (!joint?.constraints) return;
        joint.constraints.splice(constraintIndex, 1);
        clearAllConstraintState(this.getSkeleton(skelId)!);
        this.ctx.emitSceneGraphChanged();
    }

    getJointConstraints(skelId: string, jointIndex: number): import('../../types/armature-3d').JointConstraint[] {
        return this.getSkeleton(skelId)?.data.joints[jointIndex]?.constraints ?? [];
    }

    // ── Spring-bone authoring ─────────────────────────────────────────────
    // Spring chains run after FK/IK/constraints each frame (damped-spring physics + body collision); see
    // spring-bone-solver.ts. The hair generator auto-creates them for tails; these expose arbitrary chains +
    // colliders for Edit Armature (cloth, accessories, etc.). All ride SkeletonData → persisted.

    /** Create a spring-bone chain over `jointIndices` (ROOT first → tip; the root's PARENT is the anchor).
     *  Returns the chain id (or '' if the skeleton/joints are invalid). */
    createSpringChain(skelId: string, jointIndices: number[], params?: Partial<SpringChain>): string {
        const skel = this.getSkeleton(skelId);
        if (!skel || jointIndices.length === 0) return '';
        const id = crypto.randomUUID();
        (skel.data.springChains ??= []).push({
            id, jointIndices: [...jointIndices],
            stiffness:  params?.stiffness ?? 0.6,
            drag:       params?.drag ?? 0.55,
            gravity:    params?.gravity ?? 0.004,
            gravityDir: params?.gravityDir ? [...params.gravityDir] as [number, number, number] : [0, -1, 0],
            hitRadius:  params?.hitRadius ?? 0.01,
            enabled:    params?.enabled ?? true,
        });
        resetSpringState(skel);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return id;
    }

    /** Update a spring chain's params (partial — only the provided fields change). */
    setSpringChainParams(skelId: string, chainId: string, params: Partial<SpringChain>): void {
        const chain = this.getSkeleton(skelId)?.data.springChains?.find(c => c.id === chainId);
        if (!chain) return;
        if (params.stiffness  !== undefined) chain.stiffness  = params.stiffness;
        if (params.drag       !== undefined) chain.drag       = params.drag;
        if (params.gravity    !== undefined) chain.gravity    = params.gravity;
        if (params.gravityDir !== undefined) chain.gravityDir = [...params.gravityDir] as [number, number, number];
        if (params.hitRadius  !== undefined) chain.hitRadius  = params.hitRadius;
        if (params.enabled    !== undefined) chain.enabled    = params.enabled;
        this.ctx.scheduleRender();
    }

    /** Remove a spring chain (its joints stay; they revert to their FK pose). */
    removeSpringChain(skelId: string, chainId: string): void {
        const skel = this.getSkeleton(skelId);
        if (!skel?.data.springChains) return;
        skel.data.springChains = skel.data.springChains.filter(c => c.id !== chainId);
        resetSpringState(skel);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /** All spring chains on a skeleton. */
    getSpringChains(skelId: string): SpringChain[] {
        return this.getSkeleton(skelId)?.data.springChains ?? [];
    }

    /** Add a collider the spring bones bounce off (sphere, or capsule if `tail` set). Returns its index. */
    addSpringCollider(skelId: string, collider: SpringCollider): number {
        const skel = this.getSkeleton(skelId);
        if (!skel) return -1;
        (skel.data.springColliders ??= []).push(collider);
        this.ctx.scheduleRender();
        return skel.data.springColliders.length - 1;
    }

    /** Remove a spring collider by index. */
    removeSpringCollider(skelId: string, index: number): void {
        const cols = this.getSkeleton(skelId)?.data.springColliders;
        if (!cols || index < 0 || index >= cols.length) return;
        cols.splice(index, 1);
        this.ctx.scheduleRender();
    }

    /** All spring colliders on a skeleton. */
    getSpringColliders(skelId: string): SpringCollider[] {
        return this.getSkeleton(skelId)?.data.springColliders ?? [];
    }

    // ── Pose Library ─────────────────────────────────────────────────────

    capturePose(skelId: string, name: string): string {
        const skel = this.getSkeleton(skelId);
        if (!skel) throw new Error(`Skeleton not found: ${skelId}`);
        if (!skel.data.poses) skel.data.poses = [];
        const id = _nanoid();
        const rotations = skel.data.joints.map((j, i) => ({
            jointIndex: i,
            rotation: [...j.localRotation] as [number, number, number, number],
        }));
        skel.data.poses.push({ id, name, rotations });
        this.ctx.scheduleRender();
        return id;
    }

    applyPose(skelId: string, poseId: string): void {
        const skel = this.getSkeleton(skelId);
        const pose = skel?.data.poses?.find(p => p.id === poseId);
        if (!skel || !pose) return;
        for (const entry of pose.rotations) {
            const joint = skel.data.joints[entry.jointIndex];
            if (joint) joint.localRotation = [...entry.rotation] as [number, number, number, number];
        }
        skel.computeWorldMatrices();
        skel.matricesDirty = true;
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    getPoses(skelId: string): { id: string; name: string }[] {
        const skel = this.getSkeleton(skelId);
        return (skel?.data.poses ?? []).map(p => ({ id: p.id, name: p.name }));
    }

    renamePose(skelId: string, poseId: string, name: string): void {
        const pose = this.getSkeleton(skelId)?.data.poses?.find(p => p.id === poseId);
        if (pose) { pose.name = name; this.ctx.emitSceneGraphChanged(); }
    }

    deletePose(skelId: string, poseId: string): void {
        const skel = this.getSkeleton(skelId);
        if (!skel?.data.poses) return;
        skel.data.poses = skel.data.poses.filter(p => p.id !== poseId);
        this.ctx.emitSceneGraphChanged();
    }

    // ── Skeleton authoring — retarget ─────────────────────────────────

    /**
     * Copy an animation clip from one skeleton to another by matching joint names.
     * Returns the new clip ID on the target skeleton, or '' if the source clip is not found.
     */
    retargetSkeletonClip3D(clipId: string, targetSkeletonId: string): string {
        const found = this._findClip(clipId);
        const targetSkel = this.getSkeleton(targetSkeletonId);
        if (!found || !targetSkel) return '';

        const { clip } = found;

        // Build name→index for target (case-insensitive)
        const nameToIdx = new Map<string, number>();
        for (const j of targetSkel.data.joints) nameToIdx.set(j.name.toLowerCase(), j.index);

        // Build name→index for source
        const srcNameToIdx = new Map<number, string>();
        for (const j of found.skel.data.joints) srcNameToIdx.set(j.index, j.name.toLowerCase());

        const newClipId = this.createSkeletonClip3D(targetSkeletonId, clip.name + ' (retargeted)', clip.fps, clip.endFrame);
        if (!newClipId) return '';

        for (const track of clip.tracks) {
            const srcName = srcNameToIdx.get(track.jointIndex);
            if (!srcName) continue;
            const tgtIdx = nameToIdx.get(srcName);
            if (tgtIdx === undefined) {
                console.warn('retarget: no match for joint', srcName);
                continue;
            }
            for (const kf of track.keyframes) {
                this.setClipJointKeyframe3D(newClipId, tgtIdx, track.channel, kf.frame, [...kf.value]);
            }
        }
        return newClipId;
    }

    // ── Texture library data (for save/load) ─────────────────────────

    /**
     * Returns a full texture library snapshot including base64 data URLs.
     * Include this in document save payloads so textures survive reload.
     */
    getTextureLibraryData(): { entries: any[] } | null {
        return this._textureLibrary?.toJSONWithData() ?? null;
    }

    /**
     * Restore the texture library from a saved snapshot, then re-apply
     * GPU textures to any meshes whose textureLibraryId matches an entry.
     */
    async restoreTextureLibraryData(data: { entries: any[] }): Promise<void> {
        const lib = this.getTextureLibrary();
        await lib.restoreFromJSON(data);
        for (const mesh of this.getAllMeshes()) {
            if (mesh.textureLibraryId) {
                const tex = lib.getTexture(mesh.textureLibraryId);
                if (tex) {
                    mesh.diffuseTexture = tex;
                    mesh.material.hasTexture = true;
                    mesh.gpuDirty = true;
                }
            }
            if (mesh.normalMapLibraryId) {
                const tex = lib.getTexture(mesh.normalMapLibraryId);
                if (tex) {
                    mesh.normalMapTexture = tex;
                    mesh.gpuDirty = true;
                }
            }
        }
        this.ctx.scheduleRender();
    }

    // ── Group outliner helpers ───────────────────────────────────────

    setGroupCollapsed(groupId: string, collapsed: boolean): boolean {
        const group = this.getMeshGroup(groupId);
        if (!group) return false;
        group.collapsed = collapsed;
        this.ctx.emitSceneGraphChanged();
        return true;
    }

    isGroupCollapsed(groupId: string): boolean {
        return this.getMeshGroup(groupId)?.collapsed ?? false;
    }

    // ── Outliner helpers ─────────────────────────────────────────────

    setMeshVisible(nodeId: string, visible: boolean): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        mesh.visible = visible;
        this.ctx.scheduleRender();
        return true;
    }

    isMeshVisible(nodeId: string): boolean {
        return this.getMesh(nodeId)?.visible ?? true;
    }

    setGroupVisible(groupId: string, visible: boolean): boolean {
        const group = this.getMeshGroup(groupId);
        if (!group) return false;
        group.visible = visible;
        this.ctx.scheduleRender();
        return true;
    }

    isGroupVisible(groupId: string): boolean {
        return this.getMeshGroup(groupId)?.visible ?? true;
    }

    setMeshName(nodeId: string, name: string): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        mesh.name = name;
        this.ctx.emitSceneGraphChanged();
        return true;
    }

    getMeshName(nodeId: string): string | null {
        return this.getMesh(nodeId)?.name ?? null;
    }

    setGroupName(groupId: string, name: string): boolean {
        const group = this.getMeshGroup(groupId);
        if (!group) return false;
        group.name = name;
        this.ctx.emitSceneGraphChanged();
        return true;
    }

    getGroupName(groupId: string): string | null {
        return this.getMeshGroup(groupId)?.name ?? null;
    }

    /**
     * Returns a snapshot hierarchy of 3D nodes for outliner display.
     * Top-level entries are direct children of root that are Mesh3D or MeshGroup3D.
     * Groups include their Mesh3D children.
     *
     * This allocates a new array on every call. Cache the result and invalidate on
     * scene-graph-changed events rather than calling this every frame.
     */
    getScene3DHierarchy(): Scene3DHierarchyNode[] {
        const result: Scene3DHierarchyNode[] = [];
        // Track which (parentGroupId:directionKey) buckets have already been emitted
        // so sibling ArrayGroup3Ds (one per group child) appear as a single outliner entry.
        const seenArrayBuckets = new Set<string>();

        for (const child of this.ctx.sceneGraph.root.children) {
            if (child instanceof Mesh3D) {
                result.push({
                    id: child.id, name: child.name,
                    type: '3DMesh', visible: child.visible, locked: child.locked,
                });
            } else if (child instanceof ArrayGroup3D) {
                const source = this.getMesh(child.sourceId);
                const parentGroup = source?.parent;
                if (parentGroup instanceof MeshGroup3D && !(parentGroup instanceof ArrayGroup3D)) {
                    // This ArrayGroup3D is one of N siblings for a group-sourced array.
                    // Only emit the first one encountered per (parentGroup, direction) bucket.
                    const bucketKey = `${parentGroup.id}:${this._arrayDirectionKey(child.arrayParams)}`;
                    if (seenArrayBuckets.has(bucketKey)) continue;
                    seenArrayBuckets.add(bucketKey);
                }
                result.push({
                    id: child.id, name: child.name,
                    type: '3DArrayGroup',
                    visible: child.visible, locked: child.locked,
                    collapsed: child.collapsed, children: [],
                    instanceCount: getArrayInstanceCount(child.arrayParams),
                });
            } else if (child instanceof MeshGroup3D) {
                const groupChildren: Scene3DHierarchyNode[] = [];
                for (const gc of child.children) {
                    if (gc instanceof Mesh3D) {
                        groupChildren.push({
                            id: gc.id, name: gc.name,
                            type: '3DMesh', visible: gc.visible, locked: gc.locked,
                        });
                    }
                }
                result.push({
                    id: child.id, name: child.name,
                    type: '3DMeshGroup',
                    visible: child.visible, locked: child.locked,
                    collapsed: child.collapsed, children: groupChildren,
                });
            }
        }
        return result;
    }

    // ── Normal maps ──────────────────────────────────────────────────

    /** Upload a normal map texture and apply it to the given mesh. */
    async setMeshNormalMap(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return false;

        const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
        const texture = device.createTexture({
            size: [bitmap.width, bitmap.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);

        if (mesh.normalMapTexture) mesh.normalMapTexture.destroy();
        mesh.normalMapTexture = texture;
        mesh.material.hasNormalMap = true;

        // Normal maps require the textured pipeline path (4-binding bind group).
        // Auto-create a white 1×1 diffuse if the mesh has no diffuse texture yet.
        if (!mesh.material.hasTexture) {
            const whiteTex = device.createTexture({
                size: [1, 1, 1], format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            device.queue.writeTexture({ texture: whiteTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
            if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
            mesh.diffuseTexture = whiteTex;
            mesh.material.hasTexture = true;
            console.warn(`[Scene3DManager] setMeshNormalMap: mesh "${nodeId}" had no diffuse texture — auto-created 1×1 white diffuse. Assign a real diffuse texture to replace it.`);
        }

        mesh.gpuDirty = true;
        mesh.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    clearMeshNormalMap(nodeId: string): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        if (mesh.normalMapTexture) {
            mesh.normalMapTexture.destroy();
            mesh.normalMapTexture = null;
        }
        mesh.normalMapLibraryId = null;
        mesh.material.hasNormalMap = false;
        mesh.gpuDirty = true;
        mesh.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    // ── Ribbon meshes ────────────────────────────────────────────────

    /**
     * Create a ribbon mesh that follows a Catmull-Rom spline path.
     *
     * The ribbon is double-sided, so textures applied to it are visible from
     * both the front and back.  UVs are arc-length parameterized along the path
     * (U = 0→1, V = 0 on one edge, 1 on the other) — ideal for HTML banners.
     *
     * @param x,y,z   World-space origin for the mesh node (control points are relative).
     * @param controlPoints  ≥2 points that define the spline path.
     * @param width   Ribbon width in world units.
     * @param segments  Curve subdivisions per segment (default 16).  Higher = smoother.
     * @param material  Optional material overrides.
     */
    addRibbon3D(
        x: number,
        y: number,
        z: number,
        controlPoints: RibbonControlPoint[],
        width: number,
        segments = 16,
        material?: Partial<Material3D>,
    ): Mesh3D {
        const geom = generateRibbon({
            controlPoints: controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width,
            segments,
        });
        const mesh = this.createMesh(x, y, z, { primitive: 'custom', geometry: geom, material });

        this._ribbonData.set(mesh.id, {
            meshId: mesh.id,
            controlPoints: [...controlPoints],
            width,
            segments,
            uvScrollOffset: 0,
            uvScrollOffsetV: 0,
            uvEndPadding: 0,
            uvTileCount: 1,
            pathMode: 'normal',
            doubleSided: 'double',
            flipRearU: false,
        });

        return mesh;
    }

    /**
     * Update the spline path of an existing ribbon mesh.
     * Rebuilds geometry immediately.
     */
    updateRibbonPath3D(meshId: string, controlPoints: RibbonControlPoint[]): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.controlPoints = [...controlPoints];
        const cam0 = this.renderer3D.getCamera();
        const geom = generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam0.position[0], cam0.position[1], cam0.position[2]],
        });
        mesh.setGeometry(geom);
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Update the width of a ribbon mesh.  Rebuilds geometry immediately.
     */
    updateRibbonWidth3D(meshId: string, width: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.width = width;
        const cam1 = this.renderer3D.getCamera();
        const geom = generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam1.position[0], cam1.position[1], cam1.position[2]],
        });
        mesh.setGeometry(geom);
        this.ctx.scheduleRender();
        return true;
    }

    /** Returns the stored ribbon data for a mesh, or null if it is not a ribbon. */
    getRibbonData3D(meshId: string): RibbonData | null {
        return this._ribbonData.get(meshId) ?? null;
    }

    /** Remove ribbon tracking data (does NOT delete the mesh). */
    removeRibbonData3D(meshId: string): boolean {
        return this._ribbonData.delete(meshId);
    }

    /**
     * Update a single control point on an existing ribbon by index and rebuild geometry.
     * Useful for drag handles — call this on every pointer-move event instead of
     * rebuilding the full control points array each time.
     *
     * @returns false if the mesh is not a ribbon or the index is out of range.
     */
    setRibbonControlPoint3D(meshId: string, index: number, x: number, y: number, z: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;
        if (index < 0 || index >= ribbon.controlPoints.length) return false;

        ribbon.controlPoints[index] = { x, y, z };
        const cam2 = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam2.position[0], cam2.position[1], cam2.position[2]],
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Set the UV end-padding for a ribbon — extra UV units added to the end of the
     * U range so a looping scroll has a small overlap instead of a hard seam.
     * Typical values: 0 (off) to 0.1 (10% overlap). Rebuilds geometry immediately.
     */
    setRibbonEndPadding3D(meshId: string, uvEndPadding: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.uvEndPadding = Math.max(0, uvEndPadding);
        const cam3 = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam3.position[0], cam3.position[1], cam3.position[2]],
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Set the path-orientation mode for a ribbon mesh and rebuild its geometry.
     *
     * - `'normal'`        — Rotation-Minimizing Frame. Ribbon lies in the path plane.
     * - `'world-up'`      — Width direction is always world-Y; ribbon stands upright.
     * - `'camera-facing'` — Face always rotates toward the camera (rebuilt every frame).
     */
    setRibbonPathMode3D(meshId: string, mode: RibbonPathMode): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.pathMode = mode;

        const cam = this.renderer3D.getCamera();
        const camPos: [number, number, number] = [cam.position[0], cam.position[1], cam.position[2]];
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: mode,
            cameraPosition: camPos,
        }));

        if (mode === 'camera-facing') {
            this._ensureRibbonUpdateCb();
        }

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Set which faces of a ribbon are visible and rebuild geometry immediately.
     * - `'double'` (default) — both front and back faces visible.
     * - `'front'`  — front face only; prevents mirrored text from showing inside loops/spirals.
     * - `'back'`   — back face only; useful for inside-of-loop views.
     * Legacy boolean accepted: `true` → `'double'`, `false` → `'front'`.
     */
    setRibbonDoubleSided3D(meshId: string, doubleSided: 'double' | 'front' | 'back' | boolean): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.doubleSided =
            doubleSided === true  ? 'double' :
            doubleSided === false ? 'front'  :
            doubleSided;
        const cam = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam.position[0], cam.position[1], cam.position[2]],
            doubleSided,
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Update the curve subdivision count of a ribbon and rebuild geometry immediately.
     * Higher values produce smoother curves but more triangles.
     * Typical values: 8 (draft) · 16 (standard) · 32 (smooth) · 64 (high quality).
     */
    updateRibbonSegments3D(meshId: string, segments: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.segments = Math.max(1, segments | 0);
        const cam = this.renderer3D.getCamera();
        const geom = generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam.position[0], cam.position[1], cam.position[2]],
        });
        mesh.setGeometry(geom);
        this.ctx.scheduleRender();
        return true;
    }

    // ── Ribbon handle transform helpers ─────────────────────────────────────────

    /** Convert a control point in mesh-local space to world space. */
    private _cpToWorld(mesh: Mesh3D, cp: { x: number; y: number; z: number }): [number, number, number] {
        const w = vec4.transformMat4(vec4.create(), [cp.x, cp.y, cp.z, 1] as any, mesh.localMatrix as any);
        return [w[0] / w[3], w[1] / w[3], w[2] / w[3]];
    }

    /** Convert a world-space position back to mesh-local space. */
    private _worldToCpLocal(mesh: Mesh3D, wx: number, wy: number, wz: number): [number, number, number] {
        const inv = mat4.invert(mat4.create(), mesh.localMatrix as any);
        if (!inv) return [wx, wy, wz];
        const l = vec4.transformMat4(vec4.create(), [wx, wy, wz, 1] as any, inv);
        return [l[0] / l[3], l[1] / l[3], l[2] / l[3]];
    }

    // ── Canvas-overlay ribbon control-point handle API ──────────────────────────

    /**
     * Project each ribbon control point into overlay pixel space for canvas overlay drawing.
     *
     * Pass the dimensions of whatever element you draw the overlay circles on
     * (e.g.  or ).
     * The returned { x, y } are in that same coordinate space, ready to draw with.
     *
     * Make sure the same dimensions are passed to beginRibbonHandleDrag3D and moveRibbonHandle3D.
     *
     * @returns One entry per control point —  in overlay pixels, or null if behind camera.
     */
    getRibbonHandleScreenPositions3D(
        ribbonId: string,
        overlayWidth: number,
        overlayHeight: number,
    ): Array<{ x: number; y: number; index: number } | null> {
        const ribbon = this._ribbonData.get(ribbonId);
        if (!ribbon) return [];
        const mesh = this.getMesh(ribbonId);
        return ribbon.controlPoints.map((cp, index) => {
            const [wx, wy, wz] = mesh ? this._cpToWorld(mesh, cp) : [cp.x, cp.y, cp.z];
            const proj = this.projectWorldToScreen3D(wx, wy, wz, overlayWidth, overlayHeight);
            if (!proj) return null;
            return { x: proj.x, y: proj.y, index };
        });
    }

    /**
     * Begin dragging a ribbon control point by its index.
     * Captures the depth of the control point at the current camera position.
     * Call once on pointerdown.
     *
     * @param overlayWidth   Width of your overlay element in pixels.
     * @param overlayHeight  Height of your overlay element in pixels.
     * @returns false if the ribbon or index is invalid.
     */
    beginRibbonHandleDrag3D(
        ribbonId: string,
        handleIndex: number,
        overlayWidth: number,
        overlayHeight: number,
    ): boolean {
        const ribbon = this._ribbonData.get(ribbonId);
        if (!ribbon || handleIndex < 0 || handleIndex >= ribbon.controlPoints.length) return false;
        const mesh = this.getMesh(ribbonId);
        const cp = ribbon.controlPoints[handleIndex];
        const [wx, wy, wz] = mesh ? this._cpToWorld(mesh, cp) : [cp.x, cp.y, cp.z];
        const proj = this.projectWorldToScreen3D(wx, wy, wz, overlayWidth, overlayHeight);
        if (!proj) return false;
        this._ribbonHandleDragDepth.set(`${ribbonId}:${handleIndex}`, proj.depth);
        return true;
    }

    /**
     * Move a ribbon control point to the current pointer position.
     * Call on every pointermove while dragging.
     *
     * @param offsetX       Pointer X in overlay pixels (e.g. event.offsetX, or clientX − rect.left).
     * @param offsetY       Pointer Y in overlay pixels.
     * @param overlayWidth  Width of the overlay element.
     * @param overlayHeight Height of the overlay element.
     * @returns false if the drag was not started.
     */
    moveRibbonHandle3D(
        ribbonId: string,
        handleIndex: number,
        offsetX: number, offsetY: number,
        overlayWidth: number, overlayHeight: number,
    ): boolean {
        const depth = this._ribbonHandleDragDepth.get(`${ribbonId}:${handleIndex}`);
        if (depth === undefined) return false;
        const world = this.unprojectScreenToWorld3D(offsetX, offsetY, depth, overlayWidth, overlayHeight);
        const mesh = this.getMesh(ribbonId);
        const [lx, ly, lz] = mesh
            ? this._worldToCpLocal(mesh, world.x, world.y, world.z)
            : [world.x, world.y, world.z];
        return this.setRibbonControlPoint3D(ribbonId, handleIndex, lx, ly, lz);
    }

    /** End a handle drag. Call on pointerup. */
    endRibbonHandleDrag3D(ribbonId: string, handleIndex: number): void {
        this._ribbonHandleDragDepth.delete(`${ribbonId}:${handleIndex}`);
    }

    /**
     * Toggle the "flip rear U" flag on a ribbon and rebuild geometry immediately.
     * When true, the back face gets horizontally mirrored U coordinates so text
     * reads left-to-right from both sides of the ribbon.
     * When false (default), the back face mirrors the front — text appears backwards
     * on the inside face.
     */
    setRibbonFlipRearU3D(meshId: string, flip: boolean): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;

        ribbon.flipRearU = flip;
        const cam = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam.position[0], cam.position[1], cam.position[2]],
            doubleSided: ribbon.doubleSided,
            flipRearU: flip,
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Set how many times the HTML/diffuse texture tiles along the ribbon length.
     * Default: 1 (texture shown once end-to-end). Set to N to repeat N times —
     * the U coordinate runs 0→N and the sampler wraps. Use this to keep complex
     * script (Urdu, Arabic, etc.) crisp on long ribbons: put one copy of the text
     * in the HTML and let the GPU repeat it instead of stretching a long texture.
     */
    setRibbonUvTileCount3D(meshId: string, tileCount: number): boolean {
        const mesh = this.getMesh(meshId);
        const ribbon = this._ribbonData.get(meshId);
        if (!mesh || !ribbon) return false;
        ribbon.uvTileCount = Math.max(1, tileCount);
        const cam = this.renderer3D.getCamera();
        mesh.setGeometry(generateRibbon({
            controlPoints: ribbon.controlPoints.map(p => [p.x, p.y, p.z] as [number, number, number]),
            width: ribbon.width,
            segments: ribbon.segments,
            uvScrollOffset: ribbon.uvScrollOffset,
            uvScrollOffsetV: ribbon.uvScrollOffsetV,
            uvEndPadding: ribbon.uvEndPadding,
            uvTileCount: ribbon.uvTileCount,
            pathMode: ribbon.pathMode,
            cameraPosition: [cam.position[0], cam.position[1], cam.position[2]],
            doubleSided: ribbon.doubleSided,
            flipRearU: ribbon.flipRearU,
        }));
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Show or hide control-point handles for a ribbon.
     * The canvas overlay reads `getRibbonData3D(id)?.showHandles` to decide
     * whether to draw circles. Default when undefined: handles are visible.
     */
    setRibbonShowHandles3D(meshId: string, show: boolean): boolean {
        const ribbon = this._ribbonData.get(meshId);
        if (!ribbon) return false;
        ribbon.showHandles = show;
        return true;
    }

    /**
     * Compute GPU texture dimensions that match a ribbon's aspect ratio.
     *
     * Height is set to `targetHeight` (rounded to the nearest power of two).
     * Width is derived from the ribbon's arc-length-to-width ratio so the
     * texture fills the ribbon face without stretching.
     * Both dimensions are clamped and rounded to the nearest power of two.
     *
     * @param meshId       Ribbon mesh node ID.
     * @param targetHeight Desired texture height in pixels (default 128).
     *                     Use 64 for compact ribbons, 256 for large/high-quality ones.
     * @param maxWidth     Upper limit on texture width in pixels (default 2048).
     * @returns `{ width, height }` or `null` if the mesh is not a ribbon or has invalid data.
     */
    computeRibbonTextureSize3D(
        meshId: string,
        targetHeight = 128,
        maxWidth = 2048,
    ): { width: number; height: number; fontSize: number } | null {
        const ribbon = this._ribbonData.get(meshId);
        if (!ribbon) return null;
        if (!(ribbon.width > 0)) return null; // catches NaN, 0, negative

        const pts = ribbon.controlPoints;
        let arcLen = 0;
        for (let i = 1; i < pts.length; i++) {
            const dx = pts[i].x - pts[i - 1].x;
            const dy = pts[i].y - pts[i - 1].y;
            const dz = pts[i].z - pts[i - 1].z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (isFinite(d)) arcLen += d;
        }
        const height = nearestPow2(Math.max(32, targetHeight));
        const aspectRatio = arcLen / ribbon.width;
        const width = nearestPow2(Math.max(64, Math.min(maxWidth, Math.round(aspectRatio * height))));
        if (width < 1 || height < 1) return null;
        // fontSize = texture height: the texture height IS the ribbon height in render-pixels,
        // so a font-size equal to height fills the ribbon vertically before any CSS scaling.
        return { width, height, fontSize: height };
    }

    // ── HTML-in-Canvas textures ──────────────────────────────────────

    /**
     * Render an HTML string to a GPU texture and apply it to a mesh.
     *
     * Uses the native browser "HTML-in-Canvas" technique (SVG foreignObject +
     * drawImage + copyExternalImageToTexture) — no external libraries.
     *
     * Call this once to set the initial content, then call `updateHtmlTexture3D`
     * to change the HTML without recreating the texture object.
     *
     * @param meshId   Target mesh node ID.
     * @param html     HTML body content to render (will be wrapped in a full HTML document).
     * @param width    Texture width in pixels (default 512).
     * @param height   Texture height in pixels (default 128).
     * @param options  Background color, container style overrides.
     */
    async setHtmlTexture3D(
        meshId: string,
        html: string,
        width = 512,
        height = 128,
        options?: HtmlTexture3DOptions,
    ): Promise<boolean> {
        const mesh = this.getMesh(meshId);
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!mesh || !device) return false;
        if (!(width >= 1) || !(height >= 1)) {
            console.error(`setHtmlTexture3D: invalid dimensions ${width}×${height} for mesh "${meshId}" — did computeRibbonTextureSize3D return null?`);
            return false;
        }

        // Reuse existing HtmlTexture3D if dimensions match, otherwise recreate
        let ht = this._htmlTextures.get(meshId);
        if (ht && (ht.width !== width || ht.height !== height)) {
            ht.destroy();
            ht = undefined;
            this._htmlTextures.delete(meshId);
        }
        if (!ht) {
            HtmlTexture3D.setMainCanvas(this.ctx.webgpuRenderer.getCanvas());
            ht = new HtmlTexture3D(device, width, height);
            this._htmlTextures.set(meshId, ht);
        }

        // Snapshot the old HtmlTexture3D-owned texture BEFORE update() destroys it
        // internally.  We need this to avoid a double-destroy: _uploadBitmap() already
        // calls .destroy() on the previous _texture; if mesh.diffuseTexture points to
        // that same object we must NOT call .destroy() on it a second time.
        const prevHtTex = ht.texture;

        const tex = await ht.update(html, options);
        if (!tex) return false;

        // Only destroy the mesh's existing diffuse texture if it is NOT the one that
        // HtmlTexture3D just destroyed internally.
        if (mesh.diffuseTexture && mesh.diffuseTexture !== prevHtTex) {
            mesh.diffuseTexture.destroy();
        }
        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        // Do NOT set gpuDirty — geometry did not change, only the texture.
        // The renderer rebuilds the texture bind group every frame anyway.

        // Cache content + options on the ribbon for auto-restore after document reload
        const ribbon = this._ribbonData.get(meshId);
        if (ribbon) {
            ribbon.htmlTextureId = meshId;
            ribbon.htmlContent = html;
            ribbon.htmlTextureWidth = width;
            ribbon.htmlTextureHeight = height;
            if (options?.backgroundColor !== undefined) ribbon.htmlTextureBgColor = options.backgroundColor;
            if (options?.stretchToFit !== undefined) ribbon.htmlTextureStretchToFit = options.stretchToFit;
        }

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Update the HTML content of an existing HTML texture without changing its size.
     * Faster than `setHtmlTexture3D` because it skips the texture recreation step.
     * Returns false if no HTML texture exists for this mesh — call setHtmlTexture3D first.
     */
    async updateHtmlTexture3D(meshId: string, html: string, options?: HtmlTexture3DOptions): Promise<boolean> {
        const mesh = this.getMesh(meshId);
        const ht   = this._htmlTextures.get(meshId);
        if (!mesh || !ht) return false;

        const tex = await ht.update(html, options);
        if (!tex) return false;

        mesh.diffuseTexture = tex;
        mesh.material.hasTexture = true;
        mesh.gpuDirty = true;

        // Keep cached state in sync so options survive live updates
        const ribbon = this._ribbonData.get(meshId);
        if (ribbon) {
            ribbon.htmlContent = html;
            if (options?.backgroundColor !== undefined) ribbon.htmlTextureBgColor = options.backgroundColor;
            if (options?.stretchToFit !== undefined) ribbon.htmlTextureStretchToFit = options.stretchToFit;
        }

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Remove the HTML texture from a mesh and destroy the GPU texture.
     * The mesh reverts to its material diffuse color.
     */
    removeHtmlTexture3D(meshId: string): boolean {
        const mesh = this.getMesh(meshId);
        const ht   = this._htmlTextures.get(meshId);
        if (!mesh || !ht) return false;

        ht.destroy();
        this._htmlTextures.delete(meshId);

        if (mesh.diffuseTexture) { mesh.diffuseTexture.destroy(); mesh.diffuseTexture = null; }
        mesh.material.hasTexture = false;
        mesh.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /** Returns true if the mesh has an active HTML texture. */
    hasHtmlTexture3D(meshId: string): boolean {
        return this._htmlTextures.has(meshId);
    }

    // ── Cloth / Banner ───────────────────────────────────────────────

    /**
     * Build and add a ClothMesh3D to the scene from a grid config.
     *
     * Phase 1: creates a flat (unsimulated) cloth at world position (x, y, z).
     * Phase 2: pass simulated positions via `simulatedPositions` to bake the
     *          post-physics pose into the node at creation time.
     *
     * @param x/y/z              World-space origin of the cloth.
     * @param gridConfig         Grid dimensions, active cells, pins, corner radius.
     * @param physicsConfig      Physics/solidification parameters (thickness etc.).
     * @param simulatedPositions Optional post-simulation vertex positions (Float32Array,
     *                           3 floats per vertex). If omitted the flat grid is used.
     * @param name               Display name for the node (default: "Cloth").
     */
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

        // Build geometry
        const result = buildClothGeometry(fullGrid);

        let geometry = _resolveClothGeometry(result, simulatedPositions, fullPhysics);

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

    /**
     * Replace the geometry, config, and simulated pose of an existing ClothMesh3D
     * node in-place — preserves node ID, layer order, name, and material.
     *
     * Use this for the Cloth Builder modal's re-edit flow: load the existing config
     * via getClothConfig(), let the user edit, then call this when they hit Create.
     *
     * @param meshId   ID of the ClothMesh3D to update.
     * @param gridConfig   New (or unchanged) grid configuration.
     * @param physicsConfig New (or unchanged) physics configuration.
     * @param simulatedPositions Simulated vertex positions; pass undefined for flat.
     * @param mode     Simulation mode to record ('hang' | 'drape' | 'none').
     * @returns false if the node was not found or is not a ClothMesh3D.
     */
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
        node.setGeometry(_resolveClothGeometry(result, simulatedPositions, physicsConfig));

        // Update readonly fields via casting — intentional internal mutation
        const m = node as any;
        m.clothConfig  = gridConfig;
        m.physicsConfig = physicsConfig;
        m.simState = {
            positions:      simulatedPositions ? Array.from(simulatedPositions) : Array.from(result.flatPositions),
            isSimulated:    !!simulatedPositions,
            simulationMode: mode,
        };

        this._clothData.set(meshId, result);
        node.gpuDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Retrieve the cloth grid and physics config for a ClothMesh3D node.
     * Returns null if the node is not a cloth mesh or does not exist.
     */
    getClothConfig(meshId: string): { grid: ClothGridConfig; physics: ClothPhysicsConfig } | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        return { grid: node.clothConfig, physics: node.physicsConfig };
    }

    /**
     * Returns the cached ClothGeometryResult for a cloth mesh (constraint graph,
     * inverse masses, slot maps). Needed by the simulator and re-edit modal.
     * May be null if the mesh was restored from serialization without a re-build;
     * call buildClothGeometry(getClothConfig(id).grid) to regenerate.
     */
    getClothGeometryResult(meshId: string): ClothGeometryResult | null {
        return this._clothData.get(meshId) ?? null;
    }

    /**
     * Convert a vertex grid position (col, row) to a stable **slot index**
     * (`col + row * (cols+1)`) for use in `ClothGridConfig.pinnedVertices`.
     *
     * Slot indices never change when activeCells changes, so they survive
     * cell-toggle operations. Returns -1 if the slot is inactive (corner-radius
     * cutout or custom activeCells hole). Returns null if the mesh is not found.
     *
     * For stitch constraints (StitchConstraint.a/b), use getClothVertexDenseIndex
     * instead — stitches use dense indices and are cleared on topology changes.
     */
    getClothVertexSlot(meshId: string, col: number, row: number): number | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        const result = this._clothData.get(meshId);
        if (!result) return null;
        const slotCols = node.clothConfig.cols + 1;
        const slot = col + row * slotCols;
        if (slot < 0 || slot >= result.vertexFromSlot.length) return null;
        // Return -1 for inactive slots so callers can skip unpinnable vertices.
        return result.vertexFromSlot[slot] >= 0 ? slot : -1;
    }

    /**
     * Convert a vertex grid position (col, row) to the **dense vertex index**
     * used by `StitchConstraint.a/b` and `bendStiffnessMap`.
     *
     * Dense indices are reassigned when activeCells changes, so do NOT store
     * them in pinnedVertices — use getClothVertexSlot for that instead.
     *
     * Returns -1 if the slot is inactive, null if the mesh is not found.
     */
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

    // ── Live config updates ───────────────────────────────────────────────────

    /**
     * Rebuild the cloth mesh from a new (or partially changed) grid/physics config.
     * Use this for real-time UI updates: every slider or grid-param change should
     * call this so the mesh and live simulation stay in sync instantly.
     *
     * Grid changes (cols, rows, cellSize, activeCells, cornerRadius) trigger a full
     * geometry rebuild + live sim reset from flat.
     *
     * Pass only the fields that changed; missing fields keep their current values.
     */
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
        node.setGeometry(_resolveClothGeometry(result, undefined, newPhys));

        const m = node as any;
        m.clothConfig   = newGrid;
        m.physicsConfig = newPhys;
        m.simState = {
            positions:      Array.from(result.flatPositions),
            isSimulated:    false,
            simulationMode: node.simState.simulationMode,
        };

        this._clothData.set(meshId, result);
        node.gpuDirty = true;

        // Reset or start the live sim
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

    /**
     * Hot-update physics parameters without rebuilding geometry.
     * Safe to call on every slider tick for gravity, damping, stiffness, wind.
     * Does NOT reset vertex positions — cloth continues from current pose.
     */
    setClothPhysics(meshId: string, params: Partial<ClothPhysicsConfig>): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const newPhys = { ...node.physicsConfig, ...params };
        (node as any).physicsConfig = newPhys;

        this._liveClothHandles.get(meshId)?.setPhysics(params);
        return true;
    }

    /**
     * Hot-swap which vertices are pinned without resetting the cloth to flat.
     * The cloth continues simulating from its current pose — pinned vertices
     * lock in-place immediately and unpinned ones start falling.
     *
     * Use this instead of setClothConfig({ pinnedVertices }) so the user sees
     * pin changes without the cloth snapping back to the rest pose.
     *
     * If no live sim is running this only updates clothConfig so the new pins
     * take effect on the next enableLiveCloth() call. It does NOT auto-start
     * the sim — call enableLiveCloth() explicitly when you want simulation to
     * begin. This prevents a double-create race when the caller also calls
     * enableLiveCloth() immediately after (e.g. on a Hang button click).
     */
    setClothPinnedVertices(meshId: string, pinnedVertices: number[]): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const newGrid = { ...node.clothConfig, pinnedVertices };
        (node as any).clothConfig = newGrid;

        // Rebuild geometry to get the updated inverseMass array.
        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);

        const handle = this._liveClothHandles.get(meshId);
        if (handle) {
            // Hot-update only the inverseMass GPU buffer — no position reset.
            handle.setInverseMass(result.inverseMass);
            this.ctx.scheduleRender();
        }
        // No else branch: if there's no live sim, clothConfig is already updated.
        // The caller should call enableLiveCloth() when simulation should start.
        return true;
    }

    /**
     * Debounced variant of setClothConfig — accumulates changes from rapid UI
     * interactions (slider drags, spinner increments) and applies them after
     * `delayMs` of silence. Each call resets the timer, so only the final value
     * triggers a rebuild. Defaults to 150 ms.
     *
     * Use setClothConfig directly for one-shot changes (e.g. cell toggle).
     */
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

    // ── Stitch tool ───────────────────────────────────────────────────────────

    /**
     * Begin an interactive stitch. Picks vertexA and enables live hover preview.
     * Call previewClothStitch(meshId, vertexB) on each pointer-move to show a
     * live preview of where the cloth will settle when stitched to that vertex.
     * Call commitClothStitch to save, or cancelClothStitchTool to discard.
     *
     * @param restLength  0 = full stitch (vertices touch); >0 = pleat/gather gap.
     * @returns false if the mesh or vertex index is invalid.
     */
    beginClothStitchTool(meshId: string, vertexA: number, restLength = 0): boolean {
        const vc = this._clothData.get(meshId)?.vertexCount ?? 0;
        if (vertexA < 0 || vertexA >= vc) return false;
        // Snapshot the current simulated pose so every preview hover starts from
        // the same baseline instead of building on top of previous preview states.
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        const savedPositions = (node instanceof ClothMesh3D && node.simState.isSimulated)
            ? new Float32Array(node.simState.positions)
            : null;
        this._stitchTool.set(meshId, { vertexA, restLength, previewB: null, savedPositions });
        return true;
    }

    /**
     * Update the hover-preview stitch target while the user moves the pointer
     * over candidate vertices. Resets the live simulation with a temporary stitch
     * so the cloth visually settles toward the preview each time vertexB changes.
     * No-op if `vertexB` hasn't changed since the last call.
     */
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
        // Each preview starts from the saved baseline (captured at beginClothStitchTool)
        // so every hover shows "cloth from rest pose + THIS stitch", not a compounding
        // chain of successive previews.
        const initPos = state.savedPositions ?? undefined;
        handle.reset(previewGrid, node.physicsConfig, mode, undefined, initPos);
        // Re-apply stiffness + wind so preview is consistent with current settings.
        const previewResult = buildClothGeometry(previewGrid);
        handle.setBendStiffness(previewResult.bendStiffness);
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);

        return true;
    }

    /**
     * Commit the previewed stitch as a permanent constraint.
     * Equivalent to calling addClothStitch(meshId, vertexA, previewB, restLength).
     * Returns the new stitch index, or null if no preview is active.
     * Clears the stitch tool state.
     */
    commitClothStitch(meshId: string): number | null {
        const state = this._stitchTool.get(meshId);
        if (!state || state.previewB === null) return null;
        this._stitchTool.delete(meshId);
        return this.addClothStitch(meshId, state.vertexA, state.previewB, state.restLength);
    }

    /**
     * Cancel the active stitch tool without committing. Restores the live
     * simulation to the node's committed stitch list (without the preview).
     */
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
        // Restore to the pose from before the stitch tool was opened.
        handle.reset(node.clothConfig, node.physicsConfig, mode, undefined, state.savedPositions ?? undefined);
        const result = this._clothData.get(meshId);
        if (result) handle.setBendStiffness(result.bendStiffness);
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);
    }

    // ── Stitch constraints ────────────────────────────────────────────────────

    /**
     * Add a vertex-to-vertex stitch constraint.
     * restLength = 0 pulls the two vertices flush together (full stitch).
     * restLength > 0 holds them at a fixed distance (gather / pleat).
     *
     * The constraint graph is rebuilt immediately; if a live sim is running for
     * this mesh it is restarted from the current positions so the stitch takes
     * effect right away.
     *
     * Returns the index of the new stitch in clothConfig.stitches, or null on error.
     */
    addClothStitch(meshId: string, a: number, b: number, restLength: number): number | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;
        const vc = this._clothData.get(meshId)?.vertexCount ?? 0;
        if (a < 0 || b < 0 || a >= vc || b >= vc) return null;

        const stitches = [...(node.clothConfig.stitches ?? []), { a, b, restLength: Math.max(0, restLength) }];
        const newGrid  = { ...node.clothConfig, stitches };
        (node as any).clothConfig = newGrid;

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);
        this._refreshLiveSimAfterConstraintChange(meshId, node, result);
        node.stateDirty = true;
        this.ctx.scheduleRender();
        return stitches.length - 1;
    }

    /**
     * Remove a stitch by its index in clothConfig.stitches.
     * Rebuilds the constraint graph and refreshes any live simulation.
     */
    removeClothStitch(meshId: string, index: number): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        const existing = node.clothConfig.stitches ?? [];
        if (index < 0 || index >= existing.length) return false;

        const stitches = existing.filter((_, i) => i !== index);
        const newGrid  = { ...node.clothConfig, stitches };
        (node as any).clothConfig = newGrid;

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);
        // Immediately show the stitch-free flat geometry so the mesh updates even
        // if the live sim hasn't fired its first callback yet.
        node.setGeometry(_resolveClothGeometry(result, undefined, node.physicsConfig));
        node.gpuDirty = true;
        this._refreshLiveSimAfterConstraintChange(meshId, node, result);
        node.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /** Remove all stitch constraints from a cloth mesh. */
    clearClothStitches(meshId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        if (!node.clothConfig.stitches?.length) return true;

        const newGrid = { ...node.clothConfig, stitches: [] };
        (node as any).clothConfig = newGrid;

        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);
        // Clear simState so the sim restarts from flat (not the stitched pose).
        (node as any).simState = {
            positions:      Array.from(result.flatPositions),
            isSimulated:    false,
            simulationMode: node.simState.simulationMode,
        };
        node.setGeometry(_resolveClothGeometry(result, undefined, node.physicsConfig));
        node.gpuDirty = true;
        this._refreshLiveSimAfterConstraintChange(meshId, node, result);
        node.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /** Return all stitch constraints for a cloth mesh. */
    getClothStitches(meshId: string): StitchConstraint[] {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return [];
        return [...(node.clothConfig.stitches ?? [])];
    }

    // ── Bend-stiffness painting ───────────────────────────────────────────────

    /**
     * Set the per-vertex bend-stiffness map (values clamped to [0, 1]).
     * 0.0 = silk-floppy (no bend resistance), 1.0 = stiff cardboard-like.
     * The map is persisted in clothConfig.bendStiffnessMap and uploaded to
     * any running live simulation's GPU buffer immediately.
     *
     * Pass a Float32Array of length vertexCount (from getClothGeometryResult).
     */
    setClothBendStiffness(meshId: string, map: Float32Array | number[]): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const arr = map instanceof Float32Array ? map : new Float32Array(map);
        const newGrid = { ...node.clothConfig, bendStiffnessMap: Array.from(arr) };
        (node as any).clothConfig = newGrid;

        // Rebuild geometry result so bendStiffness Float32Array is in sync
        const result = buildClothGeometry(newGrid);
        this._clothData.set(meshId, result);

        // Hot-update the live sim's GPU buffer if running
        const handle = this._liveClothHandles.get(meshId);
        if (handle) handle.setBendStiffness(result.bendStiffness);

        node.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }

    /** Returns the current bend-stiffness map (per-vertex Float32Array). */
    getClothBendStiffnessMap(meshId: string): Float32Array | null {
        const result = this._clothData.get(meshId);
        if (!result) return null;
        return result.bendStiffness.slice();
    }

    // ── Wind zones ────────────────────────────────────────────────────────────

    /**
     * Add a spatial wind zone to a cloth mesh's live config.
     * Wind zones only affect live simulations (enableLiveCloth / cloth builder preview).
     * Returns the new zone's ID, or null if the mesh is not found.
     */
    addWindZone(meshId: string, zone: Omit<WindZone, 'id'>): string | null {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return null;

        const id       = _nanoid();
        const newZone: WindZone = { ...zone, id };
        const zones    = [...(node.liveConfig.windZones ?? []), newZone];
        (node as any).liveConfig = { ...node.liveConfig, windZones: zones };

        this._liveClothHandles.get(meshId)?.setWindZones(zones);
        node.stateDirty = true;
        return id;
    }

    /**
     * Remove a wind zone by its ID.
     * Returns false if the mesh or zone was not found.
     */
    removeWindZone(meshId: string, zoneId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        const zones = (node.liveConfig.windZones ?? []).filter(z => z.id !== zoneId);
        if (zones.length === (node.liveConfig.windZones?.length ?? 0)) return false;
        (node as any).liveConfig = { ...node.liveConfig, windZones: zones };
        this._liveClothHandles.get(meshId)?.setWindZones(zones);
        node.stateDirty = true;
        return true;
    }

    /**
     * Patch fields of an existing wind zone.
     * Returns false if the mesh or zone was not found.
     */
    updateWindZone(meshId: string, zoneId: string, patch: Partial<Omit<WindZone, 'id'>>): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        const zones = (node.liveConfig.windZones ?? []).map(z =>
            z.id === zoneId ? { ...z, ...patch, id: z.id } : z,
        );
        if (!zones.find(z => z.id === zoneId)) return false;
        (node as any).liveConfig = { ...node.liveConfig, windZones: zones };
        this._liveClothHandles.get(meshId)?.setWindZones(zones);
        node.stateDirty = true;
        return true;
    }

    /** Return all wind zones for a cloth mesh. */
    getWindZones(meshId: string): WindZone[] {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return [];
        return [...(node.liveConfig.windZones ?? [])];
    }

    /** Remove all wind zones from a cloth mesh. */
    clearWindZones(meshId: string): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;
        (node as any).liveConfig = { ...node.liveConfig, windZones: [] };
        this._liveClothHandles.get(meshId)?.setWindZones([]);
        node.stateDirty = true;
        return true;
    }

    /**
     * Rebuild the live simulation after a constraint change (add/remove stitch).
     * Auto-starts the live sim if not already running so stitches are immediately
     * visible. Resets from flat so the cloth settles into its new constrained pose.
     */
    private _refreshLiveSimAfterConstraintChange(
        meshId: string,
        node: ClothMesh3D,
        newResult: ClothGeometryResult,
    ): void {
        let handle = this._liveClothHandles.get(meshId);
        if (!handle) {
            // Auto-start: stitches need simulation to be visible.
            this.enableLiveCloth(meshId);
            return; // enableLiveCloth registers the onPositionsUpdate callback; done.
        }
        const mode = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';
        // Continue from the current simulated pose so the cloth doesn't snap to
        // flat when a stitch is added or removed mid-simulation.
        const initPositions = node.simState.isSimulated
            ? new Float32Array(node.simState.positions)
            : undefined;
        handle.reset(node.clothConfig, node.physicsConfig, mode, undefined, initPositions);
        handle.setBendStiffness(newResult.bendStiffness);
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);
    }

    /**
     * Run cloth physics simulation to steady-state and return the final vertex
     * positions. Does NOT create or modify any scene-graph node.
     *
     * Frogmarks calls this when the user clicks [Hang ▶] or [Drape ▶] in the
     * Cloth Builder modal, then feeds the result to createClothMesh() on [Create].
     *
     * @param gridConfig    Cloth grid configuration (columns, rows, active cells …).
     * @param physicsConfig Physics parameters (gravity, damping, stiffness, wind …).
     * @param mode          'hang' — pin top row if no explicit pins; 'drape' — no pins,
     *                      cloth falls onto the proxy shape.
     * @param proxy         Collision proxy shape for drape mode. Ignored for 'hang'.
     * @param maxSteps      Hard cap on simulation steps (default 3000).
     * @returns             Float32Array of [x, y, z] per vertex at steady state.
     */
    async simulateCloth(
        gridConfig:    Partial<ClothGridConfig>,
        physicsConfig: Partial<ClothPhysicsConfig>,
        mode: 'hang' | 'drape',
        proxy: DrapeProxy = { type: 'none' },
        maxSteps = 3000,
    ): Promise<Float32Array> {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) throw new Error('simulateCloth: WebGPU device not available');

        // Resolve full configs
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

        // Build geometry + constraint graph (CPU)
        const result = buildClothGeometry(fullGrid);

        // Compute initial positions for the simulator
        // For drape: lift cloth above the proxy so it can fall onto it
        let initPositions: Float32Array | undefined;
        if (mode === 'drape') {
            const liftY = _drapeStartY(proxy, result.flatPositions, fullGrid, fullPhysics.gravity);
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

            if (mode === 'drape') {
                sim.setCollision(proxy);
            }

            return await sim.runToConvergence(maxSteps);
        } finally {
            sim.destroy();
        }
    }

    /**
     * Apply a new set of simulated vertex positions to an existing ClothMesh3D
     * and mark it GPU-dirty. Used for live preview updates in the builder modal.
     *
     * @param meshId             ID of a ClothMesh3D node in the scene.
     * @param simulatedPositions [x, y, z] per vertex (from simulateCloth or readPositions).
     * @param mode               Simulation mode to record in the node's simState.
     */
    updateClothMeshPose(
        meshId: string,
        simulatedPositions: Float32Array,
        mode: 'hang' | 'drape' | 'none' = 'none',
    ): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        const cached = this._clothData.get(meshId);
        if (!cached || simulatedPositions.length !== cached.vertexCount * 3) return false;

        node.setGeometry(_resolveClothGeometry(cached, simulatedPositions, node.physicsConfig));

        // Update simState in-place
        (node.simState as ClothSimState).positions      = Array.from(simulatedPositions);
        (node.simState as ClothSimState).isSimulated    = true;
        (node.simState as ClothSimState).simulationMode = mode;

        this._renderClothPreview(meshId);
        this.ctx.scheduleRender();
        return true;
    }

    // ── Live cloth simulation ─────────────────────────────────────────────────

    /**
     * Create a LiveClothHandle for interactive use in the Cloth Builder modal.
     * The handle owns its own ClothSimulator and runs a requestAnimationFrame loop.
     * Set handle.onPositionsUpdate to receive positions after each GPU readback,
     * then call updateClothMeshPose() with the result.
     * Always call handle.destroy() when the modal closes.
     *
     * Returns null if WebGPU is unavailable.
     */
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

    /**
     * Enable live physics for an existing ClothMesh3D in the scene.
     * Scene3DManager maintains a LiveClothHandle and calls tickLiveCloths() each
     * render frame (registered as a preRenderCallback on the WebGPU renderer).
     * The FrameLinkAnimation3D of type 'wind' on the node drives the wind force.
     *
     * Returns false if the node is not found, is not a ClothMesh3D, or WebGPU is unavailable.
     */
    enableLiveCloth(meshId: string, stepsPerFrame?: number): boolean {
        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (!(node instanceof ClothMesh3D)) return false;

        // Destroy any existing handle for this mesh
        this._liveClothHandles.get(meshId)?.destroy();

        const device = this.ctx.webgpuRenderer.getDevice();
        const cfg    = node.clothConfig;
        const phys   = node.physicsConfig;

        // Start from the mesh's current simulated positions
        const initPositions = node.simState.isSimulated
            ? new Float32Array(node.simState.positions)
            : undefined;

        // Determine mode from simState
        const mode: 'hang' | 'drape' = node.simState.simulationMode !== 'none'
            ? node.simState.simulationMode as 'hang' | 'drape'
            : 'hang';

        const handle = createLiveClothSimulation(device, cfg, phys, mode, undefined, initPositions);
        if (!handle) return false;

        // Wire GPU pose buffer override so the renderer reads live vertex data
        // without a CPU roundtrip. Fires on reset/destroy lifecycle events.
        handle.onPoseBufferChange = (buf) => {
            this.renderer3D.setVertexBufferOverride(meshId, buf);
        };
        if (handle.poseBuffer) {
            this.renderer3D.setVertexBufferOverride(meshId, handle.poseBuffer);
        }

        handle.onPositionsUpdate = (positions) => {
            // Pose buffer is live — both the main Renderer3D and the modal preview
            // ClothPreviewRenderer read poseVertexBuf directly (set via override in
            // tickLiveCloths / _renderClothPreview). Only persist simState here.
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

        // Apply persisted wind zones and bend stiffness immediately
        const zones = node.liveConfig.windZones ?? [];
        if (zones.length) handle.setWindZones(zones);
        const cachedResult = this._clothData.get(meshId);
        if (cachedResult) handle.setBendStiffness(cachedResult.bendStiffness);

        this._liveClothHandles.set(meshId, handle);

        // Update liveConfig on node
        (node as any).liveConfig = {
            enabled: true,
            stepsPerFrame: stepsPerFrame ?? DEFAULT_CLOTH_LIVE.stepsPerFrame,
        } satisfies ClothLiveConfig;

        // Register per-frame tick if not already registered
        this._ensureLiveClothTick();

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Disable live physics for a cloth mesh.
     * @param bakeCurrentPose  If true, snapshots the current simulated positions
     *                         and updates the mesh geometry so it stays in its
     *                         current shape after the live sim stops.
     */
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

        // Clear GPU pose buffer override before the handle destroys its buffer
        this.renderer3D.setVertexBufferOverride(meshId, null);
        handle.destroy();
        this._liveClothHandles.delete(meshId);

        const node = this.ctx.sceneGraph.findNodeById(meshId);
        if (node instanceof ClothMesh3D) {
            (node as any).liveConfig = { ...DEFAULT_CLOTH_LIVE, enabled: false } satisfies ClothLiveConfig;
        }

        if (this._liveClothHandles.size === 0) {
            this._removeLiveClothTick();
        }

        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Returns the active LiveClothHandle for a cloth mesh, or null if none is running.
     *
     * Frogmarks uses this in the Edit Cloth modal to:
     *   - handle.snapshot()    → get current positions for baking (Apply button)
     *   - handle.reset(...)    → restart sim from flat or a given pose
     *   - handle.setPhysics()  → hot-update gravity/damping (prefer setClothPhysics instead)
     *
     * Do NOT store the returned reference across async gaps or modal re-opens —
     * it can be replaced when setClothConfig() or reset() is called.
     */
    getLiveClothHandle(meshId: string): LiveClothHandle | null {
        return this._liveClothHandles.get(meshId) ?? null;
    }

    /**
     * Called once per render frame by the preRenderCallback registered in
     * _ensureLiveClothTick(). Applies wind animation from the mesh's
     * FrameLinkAnimation3D (type='wind') to each live cloth's simulator.
     * Returns true while any live cloths are active (keeps frames rendering).
     */
    tickLiveCloths(frame: number): boolean {
        if (this._liveClothHandles.size === 0) return false;

        for (const [meshId, handle] of this._liveClothHandles) {
            const node = this.ctx.sceneGraph.findNodeById(meshId);
            if (!(node instanceof ClothMesh3D)) {
                // Node was removed — clean up
                handle.destroy();
                this._liveClothHandles.delete(meshId);
                continue;
            }

            // Apply wind from FrameLinkAnimation3D (type='wind') if set on this mesh
            const anim = this._frameLinkAnims3D.get(meshId);
            if (anim?.enabled && anim.type === 'wind') {
                const { wind } = evalFrameLink3D(anim, frame);
                handle.setPhysics({ wind: { x: wind[0], y: wind[1], z: wind[2] } });
            }

            // Drive any attached modal preview canvas at 60fps using poseVertexBuf
            // directly — no CPU geometry upload, no rate-limiting.
            if (this._previewRenderers.has(meshId)) {
                this._renderClothPreview(meshId);
            }
        }

        return this._liveClothHandles.size > 0;
    }

    // Lazily register / remove the preRenderCallback for live cloth ticking
    private _liveClothTickCb: (() => boolean) | null = null;

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

    // ── Cloth preview canvas ──────────────────────────────────────────────────

    /**
     * Attach a secondary <canvas> to receive a live cloth preview.
     * Renders the mesh into the canvas after every updateClothMeshPose() call.
     * The canvas gets its own GPUCanvasContext — no main-canvas interference.
     * Orbit is enabled by default; drag to rotate.
     *
     * Returns a dispose function — call it when the modal closes (or use
     * handle.destroy() which triggers this automatically if wired up).
     *
     * @param meshId  The cloth mesh to preview (must exist in the scene).
     * @param canvas  An HTMLCanvasElement inside the modal.
     * @param opts    bgColor, orbitEnabled.
     */
    attachClothPreviewCanvas(
        meshId: string,
        canvas: HTMLCanvasElement,
        opts?: ClothPreviewOptions,
    ): () => void {
        const device = this.ctx.webgpuRenderer.getDevice();
        if (!device) return () => {};

        // Destroy any existing preview for this mesh
        this._previewRenderers.get(meshId)?.destroy();

        let preview: ClothPreviewRenderer;
        try {
            preview = new ClothPreviewRenderer(device, canvas, opts);
        } catch {
            return () => {};
        }
        this._previewRenderers.set(meshId, preview);

        // Render once immediately if the mesh already has geometry
        const mesh = this.getMesh(meshId);
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
        const mesh = this.getMesh(meshId);
        if (!mesh) return;

        const poseBuffer = this._liveClothHandles.get(meshId)?.poseBuffer ?? null;
        if (poseBuffer) {
            // Live path: poseVertexBuf is the authoritative vertex source.
            // Set the same override that the main Renderer3D uses — the preview's
            // internal Renderer3D reads from poseVertexBuf directly, zero CPU upload.
            // WebGPU queue ordering guarantees the compute write completes before
            // either render pass reads, so no double-buffering is needed.
            preview.setVertexBufferOverride(mesh.id, poseBuffer);
            // Preserve gpuDirty: tickLiveCloths runs as a preRenderCallback, BEFORE
            // the main Renderer3D's drawMeshes. If geometry just changed (e.g. new
            // subdivisions), the preview renderer will clear gpuDirty when it uploads
            // the new index buffer. Restore it so the main renderer does the same upload
            // rather than drawing the new poseVertexBuf against the stale index buffer.
            const wasDirty = mesh.gpuDirty;
            preview.render(mesh);
            if (wasDirty) mesh.gpuDirty = true;
        } else {
            // Static path: mesh.geometry was updated by setGeometry/updateClothMeshPose.
            // Clear any stale override and re-upload the CPU geometry.
            preview.setVertexBufferOverride(mesh.id, null);
            mesh.gpuDirty = true;
            preview.render(mesh);
            mesh.gpuDirty = true;
        }
    }

    /** Upload a normal map to the TextureLibrary and apply it to a mesh. Returns library ID. */
    async uploadAndApplyNormalMap(meshId: string, source: File | Blob | ImageBitmap, name?: string): Promise<string | null> {
        const mesh = this.getMesh(meshId);
        if (!mesh) return null;
        const lib = this.getTextureLibrary();
        const id  = await lib.upload(source, name ?? 'normal_map');
        const tex = lib.getTexture(id);
        if (!tex) return null;

        if (mesh.normalMapTexture && mesh.normalMapTexture !== tex) mesh.normalMapTexture.destroy();
        mesh.normalMapTexture = tex;
        mesh.normalMapLibraryId = id;
        mesh.material.hasNormalMap = true;

        if (!mesh.material.hasTexture) {
            const device = this.ctx.webgpuRenderer.getDevice()!;
            const whiteTex = device.createTexture({
                size: [1, 1, 1], format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            device.queue.writeTexture({ texture: whiteTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
            if (mesh.diffuseTexture) mesh.diffuseTexture.destroy();
            mesh.diffuseTexture = whiteTex;
            mesh.material.hasTexture = true;
            console.warn(`[Scene3DManager] uploadAndApplyNormalMap: mesh "${meshId}" had no diffuse texture — auto-created 1×1 white diffuse. Assign a real diffuse texture to replace it.`);
        }

        mesh.gpuDirty = true;
        mesh.stateDirty = true;
        this.ctx.scheduleRender();
        return id;
    }

    // ── Dirty tracking ───────────────────────────────────────────────────────

    /**
     * Returns IDs of all Mesh3D nodes whose save-relevant state has changed
     * since the last call to clearMeshDirtyState(). Use this for per-mesh
     * chunked saves so only changed meshes are re-uploaded.
     */
    getDirtyMeshIds(): string[] {
        return this.getAllMeshes().filter(m => m.stateDirty).map(m => m.id);
    }

    /**
     * Clear the stateDirty flag on the given mesh IDs (or all meshes if omitted).
     * Call this after a successful save of those meshes.
     */
    clearMeshDirtyState(ids?: string[]): void {
        if (ids) {
            for (const id of ids) {
                const m = this.getMesh(id);
                if (m) m.stateDirty = false;
            }
        } else {
            for (const m of this.getAllMeshes()) m.stateDirty = false;
        }
    }

    // ── Particle emitters ────────────────────────────────────────────────────

    /**
     * Add a CPU-simulated billboard particle emitter to the 3D scene.
     * Returns the emitter's ID. Pass `preset` to use a tuned preset config
     * ('dust' | 'sparks' | 'snow' | 'magic'); individual config fields override
     * the preset. The emitter begins ticking immediately.
     */
    addParticleEmitter(
        x: number, y: number, z: number,
        config: ParticleEmitterConfig = {},
        preset?: ParticlePreset,
    ): string {
        const emitter = new ParticleEmitter3D(
            this.ctx.interactionService, x, y, z, config, preset,
        );
        this._particleEmitters.set(emitter.id, emitter);

        // Add to scene graph so the main renderer can find it in `aboveRasterNodes`
        this.ctx.sceneGraph.root.addChild(emitter);
        this.ctx.emitSceneGraphChanged();

        this._ensureParticleTick();
        this.ctx.scheduleRender();
        return emitter.id;
    }

    removeParticleEmitter(id: string): void {
        const emitter = this._particleEmitters.get(id);
        if (!emitter) return;
        this._particleEmitters.delete(id);
        emitter.parent?.removeChild(emitter);
        this.ctx.emitSceneGraphChanged();

        if (this._particleEmitters.size === 0) {
            this._stopParticleTick();
        }
        this.ctx.scheduleRender();
    }

    getParticleEmitter(id: string): ParticleEmitter3D | null {
        return this._particleEmitters.get(id) ?? null;
    }

    setParticleEmitterConfig(id: string, config: ParticleEmitterConfig): void {
        const emitter = this._particleEmitters.get(id);
        if (emitter) emitter.setConfig(config);
    }

    getAllParticleEmitters(): ParticleEmitter3D[] {
        return [...this._particleEmitters.values()];
    }

    /** Re-register a ParticleEmitter3D node that was restored from JSON. */
    registerRestoredParticleEmitter(emitter: ParticleEmitter3D): void {
        this._particleEmitters.set(emitter.id, emitter);
        this._ensureParticleTick();
    }

    /** Ensure the GPU instance sync callback is active after ArrayGroup3D nodes are restored. */
    registerRestoredArrayGroups(): void {
        this._ensureArrayGroupSync();
    }

    // ── Bloom pass ───────────────────────────────────────────────────

    get bloomEnabled(): boolean { return this.renderer3D.bloomEnabled; }

    enableBloom(threshold?: number, intensity?: number): void {
        this.renderer3D.enableBloom(threshold, intensity);
    }

    disableBloom(): void {
        this.renderer3D.disableBloom();
    }

    setBloomThreshold(t: number): void { this.renderer3D.setBloomThreshold(t); }
    setBloomIntensity(v: number): void { this.renderer3D.setBloomIntensity(v); }

    private _ensureParticleTick(): void {
        if (this._particleTickCb) return;
        let lastTime = performance.now();
        this._particleTickCb = () => {
            const now = performance.now();
            const dt  = Math.min((now - lastTime) / 1000, 0.1); // clamp to 100 ms
            lastTime  = now;
            for (const e of this._particleEmitters.values()) {
                e.tick(dt);
            }
            const hasActive = this._particleEmitters.size > 0;
            if (!hasActive) {
                this.ctx.webgpuRenderer.removePreRenderCallback(this._particleTickCb!);
                this._particleTickCb = null;
            }
            return hasActive;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._particleTickCb);
    }

    private _stopParticleTick(): void {
        if (!this._particleTickCb) return;
        this.ctx.webgpuRenderer.removePreRenderCallback(this._particleTickCb);
        this._particleTickCb = null;
    }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Compute how much to lift the cloth in Y before a drape simulation so it
 * starts above the proxy and can fall onto it.
 */
function _drapeStartY(
    proxy: DrapeProxy,
    flatPositions: Float32Array,
    config: ClothGridConfig,
    gravity: number,
): number {
    const clothHalfH = config.rows * config.cellSize * 0.5;
    if (proxy.type === 'sphere') {
        const cy = proxy.center?.[1] ?? 0;
        return cy + proxy.radius + clothHalfH + 0.1;
    }
    if (proxy.type === 'box') {
        return proxy.max[1] + clothHalfH + 0.1;
    }
    if (proxy.type === 'ground') {
        const groundY = proxy.y ?? 0;
        return groundY + clothHalfH + Math.sqrt(2 * gravity * 0.5);  // ~1s of fall height
    }
    return 0;
}

/**
 * Resolve the final MeshGeometry for a cloth node.
 * Uses solidifyCloth when thickness > 0, otherwise plain position+normal update.
 * Falls back to the flat geometry if positions is null/wrong length.
 */
function _resolveClothGeometry(
    result:    ClothGeometryResult,
    positions: Float32Array | null | undefined,
    physics:   ClothPhysicsConfig,
): MeshGeometry {
    const pos = (positions && positions.length === result.vertexCount * 3)
        ? positions
        : result.flatPositions;
    if (physics.thickness > 0) {
        return solidifyCloth(result, pos, physics.thickness, physics.solidifyRounded);
    }
    if (pos !== result.flatPositions) {
        return applySimulatedPositions(result, pos);
    }
    return result.geometry;
}

/**
 * Overwrite vertex positions in a cloth geometry result with post-simulation
 * values and recompute per-vertex normals from the new triangle faces.
 *
 * Returns a new MeshGeometry (does not mutate `result`).
 */
function applySimulatedPositions(
    result: ClothGeometryResult,
    positions: Float32Array,
): MeshGeometry {
    const src = result.geometry.vertices;
    const verts = new Float32Array(src.length);
    verts.set(src);

    const vc = result.vertexCount;

    // Overwrite positions
    for (let vi = 0; vi < vc; vi++) {
        verts[vi * FLOATS_PER_VERT    ] = positions[vi * 3    ];
        verts[vi * FLOATS_PER_VERT + 1] = positions[vi * 3 + 1];
        verts[vi * FLOATS_PER_VERT + 2] = positions[vi * 3 + 2];
    }

    // Recompute per-vertex normals (accumulate face normals, then normalize)
    const normals = new Float32Array(vc * 3);
    const indices = result.geometry.indices;
    for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
        const ax = positions[i0*3], ay = positions[i0*3+1], az = positions[i0*3+2];
        const bx = positions[i1*3], by = positions[i1*3+1], bz = positions[i1*3+2];
        const cx = positions[i2*3], cy = positions[i2*3+1], cz = positions[i2*3+2];
        const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
        const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
        const nx = e1y*e2z - e1z*e2y;
        const ny = e1z*e2x - e1x*e2z;
        const nz = e1x*e2y - e1y*e2x;
        for (const vi of [i0, i1, i2]) {
            normals[vi*3]   += nx;
            normals[vi*3+1] += ny;
            normals[vi*3+2] += nz;
        }
    }
    for (let vi = 0; vi < vc; vi++) {
        const nx = normals[vi*3], ny = normals[vi*3+1], nz = normals[vi*3+2];
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
        verts[vi * FLOATS_PER_VERT + 3] = nx / len;
        verts[vi * FLOATS_PER_VERT + 4] = ny / len;
        verts[vi * FLOATS_PER_VERT + 5] = nz / len;
    }

    return { vertices: verts, indices: result.geometry.indices, format: '12float' };
}

// ── Array merge helpers ──────────────────────────────────────────────────────

/**
 * Transform all vertices in `srcVerts` by the 4×4 matrix `M` (column-major) and append
 * to `dstVerts`. Normals and tangents are transformed by the normal matrix (M⁻¹)ᵀ.
 * Indices are remapped by `baseVertex` and appended to `dstIdx`.
 */
function _mergeTransformedGeom(
    srcVerts: Float32Array,
    srcIdx:   Uint32Array,
    M:        Float32Array,
    dstVerts: number[],
    dstIdx:   number[],
): void {
    const FVERT      = FLOATS_PER_VERT;
    const baseVertex = dstVerts.length / FVERT;

    // Normal matrix = (M⁻¹)ᵀ (upper-left 3×3 only)
    const nm = mat3.fromMat4(mat3.create(), M as any);
    if (Math.abs(mat3.determinant(nm)) > 1e-12) {
        mat3.invert(nm as any, nm as any);
        mat3.transpose(nm as any, nm as any);
    }

    for (let vi = 0; vi < srcVerts.length; vi += FVERT) {
        const px = srcVerts[vi], py = srcVerts[vi+1], pz = srcVerts[vi+2];
        const wx = M[0]*px + M[4]*py + M[8]*pz  + M[12];
        const wy = M[1]*px + M[5]*py + M[9]*pz  + M[13];
        const wz = M[2]*px + M[6]*py + M[10]*pz + M[14];

        const nx = srcVerts[vi+3], ny = srcVerts[vi+4], nz = srcVerts[vi+5];
        const wnx = nm[0]*nx + nm[3]*ny + nm[6]*nz;
        const wny = nm[1]*nx + nm[4]*ny + nm[7]*nz;
        const wnz = nm[2]*nx + nm[5]*ny + nm[8]*nz;
        const nl  = Math.sqrt(wnx*wnx + wny*wny + wnz*wnz) || 1;

        const tx = srcVerts[vi+8], ty = srcVerts[vi+9], tz = srcVerts[vi+10], tw = srcVerts[vi+11];
        const wtx = nm[0]*tx + nm[3]*ty + nm[6]*tz;
        const wty = nm[1]*tx + nm[4]*ty + nm[7]*tz;
        const wtz = nm[2]*tx + nm[5]*ty + nm[8]*tz;
        const tl  = Math.sqrt(wtx*wtx + wty*wty + wtz*wtz) || 1;

        dstVerts.push(
            wx, wy, wz,
            wnx/nl, wny/nl, wnz/nl,
            srcVerts[vi+6], srcVerts[vi+7],
            wtx/tl, wty/tl, wtz/tl, tw,
        );
    }
    for (const i of srcIdx) dstIdx.push(baseVertex + i);
}

/**
 * Weld near-coincident vertices using a spatial hash.
 * Normals of merged vertices are averaged and re-normalized.
 */
function _weldGeometry(
    verts: number[],
    idx:   number[],
    threshold: number,
): { vertices: Float32Array; indices: Uint32Array } {
    const FVERT    = FLOATS_PER_VERT;
    const cellSize = Math.max(threshold, 1e-8);
    const invCell  = 1 / cellSize;
    const cellMap  = new Map<string, number[]>();
    const newVerts: number[] = [];
    const remap:    number[] = new Array(verts.length / FVERT);

    const cellKey = (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`;

    for (let vi = 0, i = 0; vi < verts.length; vi += FVERT, i++) {
        const px = verts[vi], py = verts[vi+1], pz = verts[vi+2];
        const cx = Math.floor(px * invCell);
        const cy = Math.floor(py * invCell);
        const cz = Math.floor(pz * invCell);

        let found = -1;
        outer: for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const bucket = cellMap.get(cellKey(cx+dx, cy+dy, cz+dz));
                    if (!bucket) continue;
                    for (const ni of bucket) {
                        const eo = ni * FVERT;
                        const ex = newVerts[eo], ey = newVerts[eo+1], ez = newVerts[eo+2];
                        const d2 = (px-ex)*(px-ex) + (py-ey)*(py-ey) + (pz-ez)*(pz-ez);
                        if (d2 <= threshold * threshold) { found = ni; break outer; }
                    }
                }
            }
        }

        if (found >= 0) {
            remap[i] = found;
            const eo = found * FVERT;
            newVerts[eo+3] += verts[vi+3];
            newVerts[eo+4] += verts[vi+4];
            newVerts[eo+5] += verts[vi+5];
        } else {
            const newIdx = newVerts.length / FVERT;
            remap[i] = newIdx;
            const k = cellKey(cx, cy, cz);
            const bucket = cellMap.get(k);
            if (bucket) bucket.push(newIdx); else cellMap.set(k, [newIdx]);
            for (let f = 0; f < FVERT; f++) newVerts.push(verts[vi+f]);
        }
    }

    for (let vi = 0; vi < newVerts.length; vi += FVERT) {
        const nx = newVerts[vi+3], ny = newVerts[vi+4], nz = newVerts[vi+5];
        const l = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
        newVerts[vi+3] /= l; newVerts[vi+4] /= l; newVerts[vi+5] /= l;
    }

    return {
        vertices: new Float32Array(newVerts),
        indices:  new Uint32Array(idx.map(i => remap[i])),
    };
}

/** 3-component cross product. */
function _crossVec3(a: [number,number,number], b: [number,number,number]): [number,number,number] {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}

/** Normalize a 3-component vector (returns input unchanged if near-zero length). */
function _normVec3(v: [number,number,number]): [number,number,number] {
    const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) || 1;
    return [v[0]/l, v[1]/l, v[2]/l];
}

/**
 * Append a 6-face oriented box (24 verts, 36 indices) to `dstVerts`/`dstIdx`.
 * Axes d, u, v must be orthonormal. Sizes are full extents (not half).
 * Vertex format: [px,py,pz, nx,ny,nz, u=0,v=0, tx=0,ty=0,tz=0, tw=1].
 */
function _appendOrientedBox(
    cx: number, cy: number, cz: number,
    d: [number,number,number], u: [number,number,number], v: [number,number,number],
    sizeD: number, sizeU: number, sizeV: number,
    dstVerts: number[], dstIdx: number[],
): void {
    const hD = sizeD/2, hU = sizeU/2, hV = sizeV/2;
    const corners: Array<[number,number,number]> = [];
    for (const sd of [-1, 1]) for (const su of [-1, 1]) for (const sv of [-1, 1]) {
        corners.push([
            cx + sd*hD*d[0] + su*hU*u[0] + sv*hV*v[0],
            cy + sd*hD*d[1] + su*hU*u[1] + sv*hV*v[1],
            cz + sd*hD*d[2] + su*hU*u[2] + sv*hV*v[2],
        ]);
    }
    // corners: [0]=(-d,-u,-v) [1]=(-d,-u,+v) [2]=(-d,+u,-v) [3]=(-d,+u,+v)
    //          [4]=(+d,-u,-v) [5]=(+d,-u,+v) [6]=(+d,+u,-v) [7]=(+d,+u,+v)
    const faces: Array<[[number,number,number], [number,number,number,number]]> = [
        [[-d[0],-d[1],-d[2]], [0, 1, 3, 2]],
        [[ d[0], d[1], d[2]], [4, 6, 7, 5]],
        [[-u[0],-u[1],-u[2]], [0, 4, 5, 1]],
        [[ u[0], u[1], u[2]], [2, 3, 7, 6]],
        [[-v[0],-v[1],-v[2]], [0, 2, 6, 4]],
        [[ v[0], v[1], v[2]], [1, 5, 7, 3]],
    ];
    const FVERT = FLOATS_PER_VERT;
    for (const [fn, vi] of faces) {
        const base = dstVerts.length / FVERT;
        for (const ci of vi) {
            const [px, py, pz] = corners[ci];
            dstVerts.push(px, py, pz, fn[0], fn[1], fn[2], 0, 0, 0, 0, 0, 1);
        }
        dstIdx.push(base, base+1, base+2, base, base+2, base+3);
    }
}

/** Ray–AABB intersection. Returns distance t ≥ 0, or null on miss. */
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
