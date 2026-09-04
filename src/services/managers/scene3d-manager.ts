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
import { EventEmitter } from '../../renderer/util/event-emitter';
import { deriveViewRules, normalizeViewState, DEFAULT_VIEW_STATE, type ViewState, type ViewTarget, type CameraMode } from './view-state';
import { GameLoop } from '../../game/game-loop';
import { CharacterController, type CharacterInput, type CharacterConfig } from '../../game/character-controller';
import { KeyboardInput } from '../../game/keyboard-input';
import { FlyController } from '../../game/fly-controller';
import { MouseLook } from '../../game/mouse-look';
import { slideAlongWall, isClimbableStep, expSmooth, clampCameraDistance } from '../../game/collision-math';
import { LocomotionClipDriver, type LocomotionClips } from '../../game/locomotion';
import { TriggerVolumeSystem, type TriggerVolume, type TriggerEvent } from '../../game/trigger-volumes';
import { InteractionSystem, type Interactable } from '../../game/interaction';
import { EnvironmentManager, DEFAULT_ENVIRONMENT, type SkyState, type ReflectionsState } from './environment-manager';
import { bakeSkyEquirect, DEFAULT_SKY } from '../../renderer/3d/procedural-sky';
import { SKY_PRESETS, skyPresetNames, type SkyPresetName } from '../../renderer/3d/sky-presets';
import { SpatialGridXZ, type XZBounds } from '../../game/spatial-grid';

/** Captured TRS of a mesh for Play-mode non-destructive snapshot/restore (see _snapshotTransforms). */
type PlayXform = { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number };

/** Neutral studio backdrop for the free3D / scene VIEW (as opposed to mesh-edit / UV-paint focus mode, which keeps
 *  the busy 'wavy' default). Flat near-black #0D0D0D to match the app canvas — one shared backdrop for every
 *  3D-workspace view (2D×scene + free3D×any) so they're consistent. */
const VIEW_3D_BG: import('../../types/armature-3d').ArmatureBgOptions = {
    mode: 'solid', color1: [0.051, 0.051, 0.051, 1],   // #0D0D0D
};
import { deriveCameraPose, frustumLineSegments } from '../../scene-graph/camera-math';
import { activeCameraAt, setCut, removeCut, pruneCuts, type CameraCut } from '../../scene-graph/camera-cuts';
import { planCinematicFrames, estimateExportDuration, validateExportOptions, computeAspectCropRect, type CinematicExportOptions } from './cinematic-export';
import { resolveGroundRecipe, GROUND_WEATHER, type GroundSurfaceName } from '../../world/ground-surfaces';
import { mat4, vec4, vec3, quat } from 'gl-matrix';
import { Camera3D, Camera3DConfig } from '../../renderer/3d/camera-3d';
import { OrbitController, OrbitControllerConfig } from '../../renderer/3d/orbit-controller';
import { Renderer3D, PS1Config, DEFAULT_PS1_CONFIG, WOBBLE_PRESET, POCKET_PRESET, FogConfig, DEFAULT_FOG_CONFIG, PostProcessConfig, SSAOConfig, HighlightStyle } from '../../renderer/3d/renderer-3d';
import { Material3D, type SceneWind3D } from '../../renderer/3d/material-3d';
import { MeshGeometry, generateRibbon, generateRoundedSlab, FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import { Mesh3D, Mesh3DConfig, MeshPrimitive, Submesh3D } from '../../scene-graph/shapes/mesh-3d';
import { RasterTextureManager } from '../../renderer/raster/raster-texture-manager';
import type { EyeParams } from './eye-generator';
import { HairParams } from './hair-generator';
import {
    ClothingParams, ClothingPattern, patternPresetNames, patternPreset,
} from './clothing-generator';
import { generateBodyResult } from './body-generator';
import {
    AttachmentType, AttachmentParams, AttachmentPlacement, generateAttachment,
    defaultAttachmentParams, defaultAttachmentPlacement, attachmentMaterial,
} from './attachment-generator';
import { MeshGroup3D } from '../../scene-graph/shapes/mesh-group-3d';
import type { ScatterLayer } from '../../world/ground-scatter';
import { ArrayGroup3D, ArrayParams, computeArrayOffsets, LocalBasis3, InstanceOverride } from '../../scene-graph/shapes/array-group-3d';
import { GizmoMode, GizmoAxis } from '../../renderer/3d/gizmo-renderer';
import { type MeshEditDrawData } from '../../renderer/3d/mesh-edit-overlay-renderer';
import { MeshPicker } from '../../renderer/3d/mesh-picker';
import { type SnapMode, type SnapVizData } from './transform-controller-3d';
import { TextureLibrary } from '../texture-library';
import {
  Mesh3DKeyframeTracks, TrackName, KeyframeEasing, Keyframe,
  Camera3DKeyframeTracks, CameraTrackName,
  sampleTrack, setKeyframe, removeKeyframe,
  cloneKeyframeTracks,
  interpolateVec3, interpolateVec4, interpolateScalar, interpolateEulerSlerp,
  FrameLinkAnimation3D, DEFAULT_FRAME_LINK_ANIMATION_3D, evalFrameLink3D,
} from '../../types/keyframe-3d';
import { AnimationPlayer3D, AnimationPlayer3DConfig } from '../../renderer/3d/animation-player-3d';
import { UndoManager3D } from './undo-manager-3d';
import { parseGLB, GltfMeshResult, parseSkinnedGLB, parseSkinnedGLTF } from '../../renderer/3d/gltf-importer';
import { Skeleton3D } from '../../scene-graph/shapes/skeleton-3d';
import { SkinnedMesh3D, fromBase64ToUint8, fromBase64ToFloat32 } from '../../scene-graph/shapes/skinned-mesh-3d';
import type { Joint3D, SkeletonData, SkeletonAnimClip, ArmatureBgOptions, IKChain, IKKeyframeTrack, NLATrack, NLAClipSegment, SpringCollider, SpringChain, AnimRegion } from '../../types/armature-3d';
import { solveAllIKChains, clearAllIKRotations } from '../../renderer/3d/ik-solver';

// ── Shared FOLIAGE look (foliage-quality.md §2, phases S1/S2) ─────────────────────────────────────
/** Height-graded vertex wind for one emitted layer (S1). `height` = the plant's LOCAL height (the grading
 *  denominator); `stiffness` = bend exponent (grass ≈1.2 floppy · hedge ≈3 stiff); `amount` = per-layer scale. */
export interface FoliageWindSpec { height: number; stiffness: number; amount: number }
/** Leaf translucency + ground blend + base AO for one emitted layer (S2). Omit on trunks/vessels. */
export interface FoliageShadeSpec {
    translucency?: number;
    translucencyColor?: [number, number, number];
    groundBlend?: number;
    groundTint?: [number, number, number];
    baseAO?: number;
}
/** Stamp the shared foliage look onto a material. Both halves ride the SAME repurposed instance slots, so
 *  wind/foliage shading is mutually exclusive with patternMode / boardShade / groundShade on a mesh — and
 *  `windHeight` is written even when only S2 is present, because the base-AO ramp shares that denominator. */
export function applyFoliageLook(mat: Material3D, wind?: FoliageWindSpec, shade?: FoliageShadeSpec): void {
    if (!wind && !shade) return;
    if (wind && wind.amount > 0) {
        mat.windSway = true;
        mat.windStiffness = wind.stiffness;
        mat.windAmount = wind.amount;
    }
    if (wind) mat.windHeight = Math.max(1e-3, wind.height);
    if (shade) {
        mat.foliageShade = true;
        mat.translucency = shade.translucency ?? 0.5;
        if (shade.translucencyColor) mat.translucencyColor = shade.translucencyColor;
        mat.groundBlend = shade.groundBlend ?? 0;
        if (shade.groundTint) mat.groundTint = shade.groundTint;
        mat.baseAOAmount = shade.baseAO ?? 0.3;
        if (mat.windHeight === undefined) mat.windHeight = 1;
    }
}

/** Per-character idle leg fidelity. 'none' = legs static (original behaviour). 'fk' = tiny FK weight-shift —
 *  practically free, feet drift ~1cm (sub-visible in a crowd); the default. 'ik' = pelvis weight-shift with the
 *  feet PINNED by foot-IK (feet stay locked; costs 2 IK solves/frame) — for hero / close-up / uneven-ground chars. */
export type LegIdleMode = 'none' | 'fk' | 'ik';
/** Runtime state for one body's procedural idle. */
type IdleRig = {
    skelId: string; intensity: number; t0: number;
    base: Map<string, [number, number, number, number]>;   // the pose the idle sines layer onto
    legMode: LegIdleMode;
    legChains?: { id: string; footName: string }[];         // foot-IK chains pinned while legMode==='ik'
};
import { solveAllConstraints, clearAllConstraintState } from '../../renderer/3d/constraint-solver';
import { solveSpringBones, resetSpringState } from '../../renderer/3d/spring-bone-solver';
import { applySkeletonClipAtFrame, evaluateNLAAtFrame, snapshotSkeletonPose, type SkeletonPose } from '../../renderer/3d/skeleton-animator';
import { buildDefaultPoses, buildDefaultClips, DEFAULT_CLIP_NAMES, DEFAULT_BREAK_CLIP_NAMES } from './default-animations';
import { exportSceneToGlb, type GltfExportResult } from '../../renderer/3d/gltf-exporter';
import { RenderStyle } from '../../renderer/3d/material-3d';
import { HtmlTexture3DOptions } from '../../renderer/3d/html-texture-3d';
import { RibbonData, RibbonControlPoint, RibbonPathMode } from '../../types/ribbon-3d';
import { ClothMesh3D, ClothGridConfig, ClothPhysicsConfig, ClothSimState, ClothLiveConfig, DEFAULT_CLOTH_PHYSICS, DEFAULT_CLOTH_LIVE, StitchConstraint, WindZone } from '../../scene-graph/shapes/cloth-mesh-3d';
import { buildClothGeometry, ClothGeometryResult } from '../../renderer/3d/cloth-geometry-builder';
import { DrapeProxy } from '../../renderer/3d/cloth-simulator';
import { resolveClothGeometry as _resolveClothGeometry } from '../../renderer/3d/cloth-mesh-helpers';
import { LiveClothHandle } from '../../renderer/3d/live-cloth-simulation';
import { ClothPreviewOptions } from '../../renderer/3d/cloth-preview-renderer';
import { ParticleEmitter3D, ParticleEmitterConfig, ParticlePreset } from '../../scene-graph/shapes/particle-emitter-3d';
import { Scene3DParticles } from './scene3d-particles';
import { Scene3DHtmlTextures } from './scene3d-html-textures';
import { Scene3DModifiers } from './scene3d-modifiers';
import { Scene3DPrimitives } from './scene3d-primitives';
import { Scene3DSurfacePaint } from './scene3d-surface-paint';
import { Scene3DMaterials } from './scene3d-materials';
import { Scene3DArrays } from './scene3d-arrays';
import { Scene3DGrouping } from './scene3d-grouping';
import { Scene3DKeyframes } from './scene3d-keyframes';
import { Scene3DTextures } from './scene3d-textures';
import { Scene3DImport } from './scene3d-import';
import { Scene3DArrayBake } from './scene3d-array-bake';
import { Scene3DWeightPaint } from './scene3d-weight-paint';
import { KitbashLibrary } from './kitbash-library';
import type { CharacterSlot, CharacterDefinition, CharacterData, KitbashPartMeta } from '../../types/kitbash-3d';
import { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';
import { Scene3DGreasePencil } from './scene3d-grease-pencil';
import { Scene3DBlendShapes } from './scene3d-blend-shapes';
import { Scene3DCloth } from './scene3d-cloth';
import { Scene3DRibbons } from './scene3d-ribbons';
import { Scene3DCharacter } from './scene3d-character';
import { Scene3DArmature } from './scene3d-armature';
import type { GpPoint, GpStroke3D } from '../../types/grease-pencil-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { Modifier } from '../../scene-graph/shapes/modifiers';
import { ArrayToolController, ArrayToolMode } from './array-tool-controller';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
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
    /** IBL: `image` is the env-map source encoded as a data URL so image-based lighting survives a document
     *  save/reload (older saves without it fall back to enabled/intensity only). `intensity` is the DIFFUSE scale;
     *  `specularIntensity` (optional/back-compat) is the independent reflection scale. */
    ibl:           { enabled: boolean; intensity: number; image?: string; specularIntensity?: number };
    /** Procedural-sky preset params (optional for back-compat). The baked look survives via `ibl.image`; this keeps
     *  the AUTHORABLE sky params so the preset stays editable after a reload. See environment-and-reflections.md. */
    sky?:          SkyState;
    /** Whether prefiltered-cubemap specular IBL (P1b) was active — re-baked from `sky` + sun on restore (optional). */
    iblSpecular?:  boolean;
    /** SSR / reflections config (P2) — optional for back-compat. */
    reflections?:  ReflectionsState;
    textureFilter: 'nearest' | 'linear';
    postProcess:   PostProcessConfig;
    /** SSAO (optional for back-compat with older saved scenes). */
    ssao?:         SSAOConfig;
    /** Scene wind (foliage sway direction/strength/speed) — optional for back-compat. */
    wind?:         SceneWind3D;
    shadows:       { enabled: boolean; mapSize: number; halfExtent: number; bias: number; strength?: number; softness?: number };
    snap:          SnapMode;
    /** Snap increments (optional for back-compat): grid cell size (world units, also the visible grid
     *  spacing), rotate step (radians), scale step (factor). */
    snapGridSize?:  number;
    snapRotateStep?: number;
    snapScaleStep?:  number;
    /** Visible ground grid — per-illustration (a character sheet wants one, a painted bg may not). */
    grid:          { visible: boolean; color: [number, number, number]; opacity: number };
    /** View state — target (illustration|scene) × camera mode (ortho2D|perspective2D|free3D) + camera poses.
     *  Optional for back-compat: older saves have no viewState → load as illustration/ortho2D. See view-state.ts. */
    viewState?:    ViewState;
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
/** How often (and how) the character blinks. */
export interface FaceBlinkConfig {
    mode: 'fixed' | 'random';
    /** fixed: seconds between blinks; random: minimum seconds. */
    minSec: number;
    /** random: maximum seconds (ignored when mode==='fixed'). */
    maxSec: number;
    /** Blink SPEED: how long the eyes stay closed, in milliseconds (~110 reads natural). */
    holdMs: number;
    /** Master toggle. When false the scheduler is cancelled (no blinking). Default true. */
    enabled?: boolean;
    /** 0–1 chance that a blink is a DOUBLE blink (a quick second blink right after). Default ~0.15. */
    doubleProbability?: number;
    /** Min / max random gap (ms) between the two blinks of a double blink. Default 150 / 320. */
    doubleGapMinMs?: number;
    doubleGapMaxMs?: number;
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

// HairRig / ClothingRig / AttachmentRig now live in the character subsystem (scene3d-character.ts).

const _nanoid = () => Math.random().toString(36).slice(2, 10);

/** '#rrggbb' / '#rgb' → {r,g,b} in 0..1. */
const hexToRgb01 = (hex: string): { r: number; g: number; b: number } => {
    let h = (hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};

/** Shallow flat-record equality (Object.is per value). BodyParams is flat scalars, so this is exact;
 *  an object-valued field compares by reference → "changed" (conservative: never falsely short-circuits). */
function shallowEqualParams<T extends object>(a: T, b: T): boolean {
    const ka = Object.keys(a) as (keyof T)[], kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.is(a[k], b[k])) return false;
    return true;
}

// ── Typed clone helpers (replace JSON.parse(JSON.stringify(...)) on interactive-edit paths) ────────
// Keyframe values are number | boolean | Vec3 | Vec4 (flat arrays); submesh materials are flat records
// with RGBA sub-objects. Structured per-track copies avoid serializing the whole tracks map per edit.

function cloneMaterial3D(m: Material3D): Material3D {
    return {
        ...m,
        diffuse:  { ...m.diffuse },
        specular: { ...m.specular },
        emissive: { ...m.emissive },
        ...(m.patternColor ? { patternColor: { ...m.patternColor } } : {}),
    };
}

function cloneSubmesh3D(s: Submesh3D): Submesh3D {
    return { ...s, material: cloneMaterial3D(s.material) };
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
    /** True for a THIN-WRAPPER container (the placed City): show as ONE item; select + translate/rotate it as a
     *  unit (no child expansion). Its `children` are omitted so it renders as a single outliner leaf. */
    thinWrapper?: boolean;
}

export class Scene3DManager {
    private ctx: ManagerContext;

    // Picking + gizmo
    private _picker = new MeshPicker();
    /** The per-frame gizmo/array sync callback registered in enableTransformControls — kept so
     *  disableTransformControls can REMOVE it (a fresh closure each enable dodges addPreRenderCallback's
     *  reference-dedup, so without this every enable/disable cycle leaked a callback that ran forever). */

    // Bone overlay state
    // True when showBoneOverlay3D was called explicitly by the Armature panel.
    // _syncBoneOverlay (triggered by mesh selection changes) must not clear an
    // explicitly-pinned overlay — the panel owns it until showBoneOverlay3D(null).
    // Fixed orbit center for armature mode — target stays here so orbit always
    // rotates around the mesh center regardless of accumulated pan.
    // Screen-space pan accumulator in orthographic world units.
    // Added to cam.orthoOffsetX/Y each frame; stays constant during orbit so the
    // mesh remains at the same screen position while the camera rotates around it.
    // Last known illustration camera center (cx/cy) for delta-tracking.
    // When illustration pan changes, the delta is folded into _armatureOrthoX/Y.
    // Scaled by zoomScale on zoom changes to avoid double-counting.
    // Fixed orbit center for mesh edit mode — same orbit-center-lock mechanism as armature.
    /** City mode: suppress hover outlines (see setHoveredMesh). */
    private _cityModeActive = false;
    // Joint drag state (drag-to-move)
    // Tail handle drag state
    // Bone placement mode — when active, the next viewport click places a joint
    // at the ray-scene (or ray-ground) intersection instead of selecting/dragging.
    // Two-click root bone placement: null = head phase, non-null = tail phase (index of the pending joint).
    // True when the last joint selection was via a tail sphere (vs head sphere).
    // Controls Add Bone: tail-selected → extend from tail; head-selected → branch from this joint.

    // Mesh rotation zeroed on armature entry for a clean front-facing workspace; restored on exit.

    // Mesh isolation (armature / weight-paint mode: all other meshes hidden)

    // Armature tool mode — 'move' repositions joints, 'rotate' applies FK rotation

    // Joint gizmo axis-drag state (move tool)

    // FK rotate drag state (rotate tool)

    // IK drag state
    private _idleSolveCallback: (() => boolean) | null = null;
    /** Procedural idle: bodyMeshId → the captured base pose + time origin. Drives breathing / weight-shift / sway. */
    private _idleRigs = new Map<string, IdleRig>();
    /** Per-character leg idle fidelity (persists across idle on/off; default 'fk'). Set via setLegIdleMode. */
    private _legIdleModes = new Map<string, LegIdleMode>();
    /** True while the idle WANTS the renderer's live rAF loop on. */
    private _idleHeldLive = false;
    /** True while an ANIMATED focus background ('wavy') in an edit mode (mesh-edit / packaging creator)
     *  WANTS the live rAF loop on — so the bg animates continuously instead of only repainting on
     *  pointer events. Mirrors {@link _idleHeldLive}. */
    private _focusBgHeldLive = false;
    /** True when the idle+focus-bg COHORT actually started the live loop and is responsible for
     *  pausing it — set only when nothing external (a clip/ghost/spawn owner) already drove the loop,
     *  so releasing the cohort never stomps a foreign owner. See {@link _syncCohortLiveLoop}. */
    private _cohortLoopStarted = false;
    /** Per-skeleton hair-sim activation: skelId → performance.now() deadline (Number.MAX_VALUE = pinned on).
     *  Springs solve ONLY for active skeletons (armature-edit target · recently animated · API-pinned) — so
     *  a crowd of idle characters never simulates hair (was: every spring-skeleton solved every frame). */
    private _springActiveUntil = new Map<string, number>();

    // Skin weight painting — §5.1 extracted (scene3d-weight-paint.ts); the first separable peel off the armature
    // tangle (own listener closure + fields). Browser-verified. The bone-overlay closure gates on isActive().
    private _weightPaint!: Scene3DWeightPaint;

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

    // 3D surface painting — §5.1 extracted (scene3d-surface-paint.ts); paint directly on a mesh in the viewport
    // (raycast hit → UV coord → begin/move/end handlers, i.e. the UVPaintController). The enter*/exit/screenToMeshUV3D
    // methods below delegate.
    private _surfacePaint!: Scene3DSurfacePaint;
    private _placePickCleanup?: () => void;   // active "click on a garment to drop a charm" surface-pin mode

    // GPU textures + texture library (upload/apply/normal-maps/library save-load) — §5.1 extracted
    // (scene3d-textures.ts). GPU-coupled, so browser-verified rather than unit-tested.
    private _textures!: Scene3DTextures;
    // Static GLB/glTF import (non-skinned) — §5.1 extracted (scene3d-import.ts). GPU-coupled (texture upload),
    // browser-verified. Skinned GLTF import stays here with the armature/character code.
    private _import!: Scene3DImport;
    // ArrayGroup bake (→ independent meshes / one welded mesh + geometry-merge helpers) — §5.1 extracted
    // (scene3d-array-bake.ts). Geometry/GPU-adjacent, browser-verified. The live array tool is Scene3DArrays.
    private _arrayBake!: Scene3DArrayBake;

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

    // The thin-wrapper container (e.g. placed City) currently selected AS A UNIT. When set, the transform
    // gizmo (box + move/rotate) operates on THIS node's own transform — which the scene graph composes into
    // every child for free — instead of a 700-mesh selection set. null when the selection isn't a thin wrapper.
    // Cached [...allMeshes, container] so the transform controller's getMeshes callback doesn't rebuild a
    // ~700-element array every hover frame; keyed on the base array identity (stable until structure changes).
    // Notified after a thin-wrapper is transformed via the gizmo, so the owner (WorldManager / BuildingManager)
    // can mirror the container's live transform into its persisted state. MULTIPLE owners register (the City AND
    // each Building are thin-wrappers), so this is a LIST — each listener guards on the container it owns.

    // Auto-sync illustration camera to pan/zoom each frame

    // Per-mesh procedural frame-link animations (keyed by mesh ID)
    private _frameLinkAnims3D = new Map<string, FrameLinkAnimation3D>();

    // Rest-pose snapshot captured at first FLA application (oscillating types only).
    // Cleared whenever FLA is set or removed so the next frame re-captures the current pose.
    private _flaRestTransforms = new Map<string, { x: number; y: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }>();

    // Ribbon meshes — §5.1 extracted into its own subsystem (scene3d-ribbons.ts): data map, scroll counters, the
    // handle-drag depth cache, and the camera-facing/scroll update tick. Initialized in the constructor.
    private _ribbons!: Scene3DRibbons;

    // Cloth state (geometry cache, live-sim handles, preview renderers, stitch tool, debounce timers) + the live
    // tick now live in the Scene3DCloth subsystem (scene3d-cloth.ts). Initialized in the constructor.

    // HTML-in-Canvas GPU textures — §5.1 extracted into its own subsystem (scene3d-html-textures.ts). The public
    // setHtmlTexture3D/... methods below delegate to it. Initialized in the constructor (needs `ctx` + a host).
    private _htmlTex!: Scene3DHtmlTextures;

    // Particle emitters — §5.1 extracted into its own id-keyed subsystem (scene3d-particles.ts). The public
    // addParticleEmitter/... methods below delegate to it. Initialized in the constructor (needs `ctx`).
    private _particles!: Scene3DParticles;

    // Kitbash part catalog
    private readonly _kitbashLibrary = new KitbashLibrary();
    // Assembled characters: charId → CharacterData
    private _characterMap = new Map<string, CharacterData>();

    // Grease Pencil — §5.1 the DATA MODEL (objects/layers/strokes/keyframes/active-stroke + JSON) is extracted into
    // its own subsystem (scene3d-grease-pencil.ts). The public createGpObject/... methods below delegate to it; the
    // interactive DRAW-MODE controller (_gpDraw*, listeners, plane raycast, gizmo save/restore) stays here and drives
    // the subsystem through its API. Initialized in the constructor (needs `ctx`).
    private _gp!: Scene3DGreasePencil;
    // Blend shapes / morph targets — §5.1 extracted (scene3d-blend-shapes.ts); operates on Mesh3D state via a host.
    private _blendShapes!: Scene3DBlendShapes;
    // Cloth / banner — §5.1 extracted (scene3d-cloth.ts); the public createClothMesh/... methods below delegate.
    private _cloth!: Scene3DCloth;
    // Character (body/face/hair/clothing/attachments) — §5.1 extracted incrementally (scene3d-character.ts).
    private _character!: Scene3DCharacter;
    // Armature/interactive-edit tangle (camera·orbit·view-gizmo, illustration-camera sync, transform gizmo, bone
    // overlay + joint editing, IK/FK, bone placement, isolation, selection/hover/thin-wrapper, canvas listeners) —
    // extracted as ONE indivisible unit (scene3d-armature.ts). The public methods below delegate. Init in constructor.
    private _armature!: Scene3DArmature;
    // Single owner of the scene ENVIRONMENT (sun/ambient/fog now; procedural sky + cubemap reflections + height fog
    // in later phases) — docs/specs/environment-and-reflections.md. P0 = a mirror of today's values (no behaviour change).
    private readonly _environment = new EnvironmentManager();
    /** The environment owner (sun/ambient/fog/…). Read/patch the coherent environment state. */
    get environment3D(): EnvironmentManager { return this._environment; }
    // CPU geometry-modifier stack — §5.1 extracted (scene3d-modifiers.ts); state lives on Mesh3D.modifiers.
    private _modifiers!: Scene3DModifiers;
    // Primitive + OBJ mesh creation surface — §5.1 extracted (scene3d-primitives.ts); the create* methods delegate.
    private _primitives!: Scene3DPrimitives;
    // Mesh appearance (render-style / pattern / material / diffuse / opacity) — §5.1 extracted (scene3d-materials.ts).
    private _materials!: Scene3DMaterials;
    // Array tool (ArrayGroup3D create / params / overrides / live GPU-instance sync) — §5.1 extracted
    // (scene3d-arrays.ts). The bake* methods stay here (geometry-merge helpers + selection state) for a later step.
    private _arrays!: Scene3DArrays;
    // Mesh groups + outliner (create/delete group, visibility/name, getScene3DHierarchy) — §5.1 extracted
    // (scene3d-grouping.ts). Thin-wrapper + selection-expansion stay here (selection/gizmo concerns).
    private _grouping!: Scene3DGrouping;
    // Per-mesh keyframe data (transform + blend-shape tracks, undoable) + timeline query helpers — §5.1 extracted
    // (scene3d-keyframes.ts). Camera keyframes / FLA / NLA / skeleton-clip / IK stay here (coupled seams).
    private _keyframes!: Scene3DKeyframes;

    constructor(ctx: ManagerContext) {
        this.ctx = ctx;
        this._particles = new Scene3DParticles(ctx);
        this._gp = new Scene3DGreasePencil(ctx);
        this._blendShapes = new Scene3DBlendShapes(ctx, { getMesh: (id) => this.getMesh(id) });
        this._cloth = new Scene3DCloth(ctx, {
            getMesh: (id) => this.getMesh(id),
            getFrameLinkAnim: (id) => this._frameLinkAnims3D.get(id) ?? null,
        });
        this._ribbons = new Scene3DRibbons(ctx, {
            createRibbonMesh: (x, y, z, geometry, material) => this.createMesh(x, y, z, { primitive: 'custom', geometry, material }),
            getMesh: (id) => this.getMesh(id),
            getFrameLinkAnim: (id) => this._frameLinkAnims3D.get(id) ?? null,
            projectWorldToScreen3D: (x, y, z, w, h) => this.projectWorldToScreen3D(x, y, z, w, h),
            unprojectScreenToWorld3D: (sx, sy, d, w, h) => this.unprojectScreenToWorld3D(sx, sy, d, w, h),
        });
        this._character = new Scene3DCharacter(ctx, {
            getMesh: (id) => this.getMesh(id),
            getAllMeshes: () => this.getAllMeshes(),
            getOrbitController: () => this._armature.getOrbitController() ?? null,
            getCamera: () => this.renderer3D.getCamera(),
            setRenderStyle: (id, style) => this.setRenderStyle(id, style),
            keepSpringsAlive: (skelId) => this._keepSpringsAlive(skelId),
        });
        this._htmlTex = new Scene3DHtmlTextures(ctx, {
            getMesh: (id) => this.getMesh(id),
            getRibbonData: (id) => this.getRibbonData3D(id),
        });
        this._modifiers = new Scene3DModifiers(ctx, {
            getMesh: (id) => this.getMesh(id),
            pushUndo: (cmd) => this._undoManager.push(cmd),
        });
        this._primitives = new Scene3DPrimitives(ctx, {
            pushUndo: (cmd) => this._undoManager.push(cmd),
            isIllustrationSync: () => this._armature.getIllustrationSync() !== null,
            illustrationMeshDefaultScale: () => this.illustrationMeshDefaultScale(),
            applyIllustrationCamera: () => this._applyIllustrationCamera(),
        });
        this._surfacePaint = new Scene3DSurfacePaint(ctx, {
            getMesh: (id) => this.getMesh(id),
            getPicker: () => this._picker,
            getCamera: () => this.renderer3D.getCamera(),
        });
        this._materials = new Scene3DMaterials(ctx, {
            getMesh: (id) => this.getMesh(id),
            getAllMeshes: () => this.getAllMeshes(),
            getProceduralBodyParts: (id) => this.getProceduralBodyParts(id),
        });
        this._arrays = new Scene3DArrays(ctx, {
            getMesh: (id) => this.getMesh(id),
            pushUndo: (cmd) => this._undoManager.push(cmd),
            getTransformOrientationMode: () => this._armature.getGizmoOrientation?.() ?? null,
        });
        this._grouping = new Scene3DGrouping(ctx, {
            getMesh: (id) => this.getMesh(id),
            pushUndo: (cmd) => this._undoManager.push(cmd),
            directionKey: (params) => this._arrays.directionKey(params),
        });
        this._keyframes = new Scene3DKeyframes(ctx, {
            getMesh: (id) => this.getMesh(id),
            getAllMeshes: () => this.getAllMeshes(),
            pushUndo: (cmd) => this._undoManager.push(cmd),
        });
        this._textures = new Scene3DTextures(ctx, {
            getMesh: (id) => this.getMesh(id),
            getAllMeshes: () => this.getAllMeshes(),
        });
        this._import = new Scene3DImport(ctx, {
            getModelStore: () => this._modelStore,
            pushUndo: (cmd) => this._undoManager.push(cmd),
            applyMorphTargets: (mesh, targets) => this._blendShapes.applyMorphTargets(mesh, targets),
            destroyTextureIfUnshared: (tex, exceptId) => this._textures.destroyTextureIfUnshared(tex, exceptId),
            isIllustrationSync: () => this._armature.getIllustrationSync() !== null,
            applyIllustrationCamera: () => this._applyIllustrationCamera(),
        });
        this._arrayBake = new Scene3DArrayBake(ctx, {
            getArrayGroup: (id) => this._arrays.getGroup(id),
            getMesh: (id) => this.getMesh(id),
            pushUndo: (cmd) => this._undoManager.push(cmd),
            clearSelectedGroup: () => this._armature.setSelectedGroupId(null),
        });
        this._weightPaint = new Scene3DWeightPaint(ctx, {
            getSkinnedMesh: (id) => this.getSkinnedMesh(id),
            getOrbitController: () => this._armature.getOrbitController() ?? null,
            getCamera: () => this.renderer3D.getCamera(),
            pickFromClient3D: (cx, cy, rect) => this.pickFromClient3D(cx, cy, rect),
            getVerticesNearPoint3D: (id, wx, wy, wz, r) => this.getVerticesNearPoint3D(id, wx, wy, wz, r),
        });
        const self = this;
        this._armature = new Scene3DArmature(ctx, {
            undoManager: this._undoManager,
            picker: this._picker,
            character: this._character,
            weightPaint: this._weightPaint,
            get cityModeActive() { return self._cityModeActive; },
            get autoKey3D() { return self.autoKey3D; },
            flaRestTransforms: this._flaRestTransforms,
            getMesh: (id) => this.getMesh(id),
            getAllMeshes: () => this.getAllMeshes(),
            getMeshGroup: (id) => this.getMeshGroup(id),
            getMeshCenter: (id) => this.getMeshCenter(id),
            getSkeleton: (id) => this.getSkeleton(id),
            getAllSkeletons: () => this.getAllSkeletons(),
            frameMesh: (nodeId, padding) => this.frameMesh(nodeId, padding),
            pick3D: (mx, my, w, h, inc) => this.pick3D(mx, my, w, h, inc),
            resolveOverlayToBody: (meshId) => this._resolveOverlayToBody(meshId),
            recordKeyframeForMesh: (meshId, frame) => this.recordKeyframeForMesh(meshId, frame),
            getArrayGroup: (groupId) => this._getArrayGroup(groupId),
            getGroupSiblingArrays: (groupId) => this._getGroupSiblingArrays(groupId),
            updateArrayParams3D: (groupId, params) => this.updateArrayParams3D(groupId, params),
            pushGridConfig: () => this._pushGridConfig(),
            ensureIdleCallback: () => this._ensureIdleCallback(),
            springsActiveFor: (skelId, now) => this._springsActiveFor(skelId, now),
            syncFocusBgLiveLoop: () => this._syncFocusBgLiveLoop(),
        });
        // Sync each procedural character's skeleton object-transform from its body mesh's transform
        // every frame, so the gizmo (which moves the body mesh) carries the skeleton + bones with it.
        this.ctx.webgpuRenderer.addPreRenderCallback(() => this._syncCharacterSkeletons());
        // Keep the selected camera-node's frustum wireframe in sync as you place/aim it (cinematic cameras).
        this.ctx.webgpuRenderer.addPreRenderCallback(() => this._refreshCameraFrustum());
    }

    /** body meshId → last localMatrixVersion synced to its skeleton.objectTransform (cheap change check). */
    private _charSkelSyncVer = new Map<string, number>();
    private _charSkelHasBodies = false;    // per-structure-version memo: any procedural bodies in the scene at all?
    private _charSkelStructVer = -1;
    /** Mirror each procedural body's transform onto its skeleton's objectTransform (matrix copy) so the
     *  skeleton + bones follow the character gizmo. Re-FKs only when the body's transform changed. */
    private _syncCharacterSkeletons(): boolean {
        // Structure-version-gated: a pure-city scene (no characters) paid a full O(meshes) instanceof scan EVERY
        // frame for nothing. Re-scan for bodies only when the scene structure changes; skip entirely when none.
        const sv = this.ctx.sceneStructureVersion();
        if (sv !== this._charSkelStructVer) {
            this._charSkelStructVer = sv;
            // A skinned mesh whose OWN transform drives its skeleton: a procedural humanoid body, OR any mesh
            // that owns a skeleton via transformViaSkeleton (a bound creature/prop). Attachments (clothing/hair/
            // charms/decals) also set transformViaSkeleton but RIDE a body-driven skeleton — excluded below.
            this._charSkelHasBodies = this.getAllMeshes().some(m => m instanceof SkinnedMesh3D && (m.isProceduralBody || m.transformViaSkeleton) && !!m.skeleton);
        }
        if (!this._charSkelHasBodies) return false;
        // Pass 1: skeletons already driven by a procedural body — their attachments must NOT fight them.
        const bodyDriven = new Set<string>();
        for (const m of this.getAllMeshes()) if (m instanceof SkinnedMesh3D && m.isProceduralBody && m.skeletonId) bodyDriven.add(m.skeletonId);
        let changed = false;
        for (const m of this.getAllMeshes()) {
            if (!(m instanceof SkinnedMesh3D) || !m.skeleton) continue;
            // Driver = a procedural body, OR a mesh owning its own (non-body-driven) skeleton. An attachment that
            // rides a body's skeleton has transformViaSkeleton too, but bodyDriven excludes it so it can't clobber.
            const drives = m.isProceduralBody || (m.transformViaSkeleton && !bodyDriven.has(m.skeletonId ?? ''));
            if (!drives) continue;
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

    /** Whether a skeleton's hair springs should simulate this frame. OFF for idle characters by default:
     *  only the armature-edit target, a recently-animated skeleton, or an API-pinned one jiggles. */
    private _springsActiveFor(skelId: string, now: number): boolean {
        if (this._armature.isBoneOverlayActive() && this._armature.getBoneOverlaySkeletonId() === skelId) return true;   // posing it
        return (this._springActiveUntil.get(skelId) ?? 0) > now;                                 // animating / pinned
    }
    /** Keep a skeleton's springs live for a short window — called each animation tick so hair jiggles
     *  during playback and settles ~`ms` after it stops, with no need to catch the stop event. */
    private _keepSpringsAlive(skelId: string, ms = 600): void {
        this._springActiveUntil.set(skelId, performance.now() + ms);
    }
    /** Enable/disable hair (spring-bone) simulation for a character. OFF by default — a crowd of idle
     *  characters costs nothing. `on` pins it; `false` lets it idle (springs settle, then stop solving). */
    setHairSimulation(bodyMeshId: string, on: boolean): void {
        const mesh = this.getMesh(bodyMeshId);
        const skelId = mesh instanceof SkinnedMesh3D ? mesh.skeletonId : null;
        if (!skelId) return;
        if (on) this._springActiveUntil.set(skelId, Number.MAX_VALUE);
        else this._springActiveUntil.delete(skelId);
        this.ctx.scheduleRender();
    }

    // ── Procedural idle (breathing / weight-shift / sway) ────────────────────────────────────────────
    /** The torso/head/shoulder joints the idle drives (by name) — everything else inherits via FK. */
    private static readonly _IDLE_JOINTS = ['lowerback', 'spine', 'chest', 'neck', 'head', 'shoulder_L', 'shoulder_R'];
    /** Legs: FK mode drives these directly (weight-shift); IK mode drives 'hips' + solves the rest. Base captured too. */
    private static readonly _LEG_IDLE_JOINTS = ['hips', 'upperleg_L', 'lowerleg_L', 'foot_L', 'upperleg_R', 'lowerleg_R', 'foot_R'];

    /** Toggle a gentle, looping IDLE animation on a standing character — breathing, weight-shift + sway, a slow head
     *  drift — driven procedurally (no keyframes). Layers on top of the current pose (captures it as the base), and
     *  the hair/chains/pendant SWING with it (it runs before the spring solve). `intensity` 0..~2 scales the motion. */
    /** Create (once) + register the procedural-idle pre-render callback on the CURRENT renderer, idempotently.
     *  DECOUPLED from orbit controls: `disableOrbitControls` (fired by the host when LEAVING an edit mode) used to
     *  strip this callback, which is exactly why the idle only ran in Edit Mesh/UV mode and died in normal view.
     *  Now `setIdleAnimation(on)` ensures it's registered regardless of orbit state. `addPreRenderCallback` dedupes
     *  by reference, so calling this repeatedly is safe and preserves ordering (it lands before the spring solve
     *  when orbit setup runs first → hair/chains still react to the breathing). */
    private _ensureIdleCallback(): void {
        if (!this._idleSolveCallback) {
            this._idleSolveCallback = () => {
                if (this._idleRigs.size === 0 || this._armature.isBoneOverlayActive()) return false;
                const now = performance.now();
                let animating = false;
                for (const [bodyMeshId, rig] of this._idleRigs) {
                    const skel = this.getSkeleton(rig.skelId);
                    if (!skel) continue;
                    // Idle BREAK: a one-shot personality clip occasionally plays OVER the base idle, then settles
                    // back. While it plays it drives the joints (the procedural idle is skipped that frame).
                    if (this._tickIdleBreak(skel, rig, bodyMeshId, now)) { animating = true; continue; }
                    this._applyIdle(skel, rig, (now - rig.t0) / 1000);   // base breathing / weight-shift / sway
                    this._finishIdleRig(skel, rig, bodyMeshId);          // squash/stretch (if on) + re-FK + springs
                    animating = true;
                }
                return animating;   // keep the render loop ticking while idling
            };
        }
        this.ctx.webgpuRenderer.addPreRenderCallback(this._idleSolveCallback);   // idempotent (dedupes by ref)
    }

    setIdleAnimation(bodyMeshId: string, on: boolean, intensity = 1): void {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton || !body.skeletonId) return;
        const skel = body.skeleton;
        const wasOn = this._idleRigs.has(bodyMeshId);
        if (on) {
            this._ensureIdleCallback();   // make sure the per-frame callback is registered (independent of orbit controls)
            const base = new Map<string, [number, number, number, number]>();   // snapshot the pose we layer onto
            for (const name of [...Scene3DManager._IDLE_JOINTS, ...Scene3DManager._LEG_IDLE_JOINTS]) {
                const j = skel.data.joints.find(jt => jt.name === name);
                // capture the EFFECTIVE rotation (what FK actually uses), so the idle layers onto the real current pose
                if (j) base.set(name, [...(j.constraintRotation ?? j.ikRotation ?? j.localRotation)] as [number, number, number, number]);
            }
            const legMode = this._legIdleModes.get(bodyMeshId) ?? 'fk';   // micro-FK by default (free; feet drift ~cm)
            const rig: IdleRig = { skelId: body.skeletonId, intensity, t0: performance.now(), base, legMode };
            this._idleRigs.set(bodyMeshId, rig);
            if (legMode === 'ik') this._setupLegIK(skel, rig);   // pin the feet + enable the leg chains
            // Drive CONTINUOUS rendering while idling. The on-demand view only animated in Edit Mesh/UV mode because
            // SOMETHING there forces a frame every vsync (the animated 'wavy' bg rides that loop — it doesn't cause it).
            // (1) START the renderer's OWN live rAF loop (`play()`) — Salsa renders every frame on its own, independent
            //     of the host. Cooperative with the focus-bg hold: _syncCohortLiveLoop only starts a loop nothing else
            //     already drives, and only the cohort that started it pauses it (never stomp a clip/other owner).
            this._idleHeldLive = true;
            this._syncCohortLiveLoop();
            // (2) ALSO emit the interactive signal (renderer + host both subscribe) so a host that composites the 3D
            //     view on-demand keeps re-compositing too.
            if (!wasOn) this.ctx.interactionService.beginInteractive();
        } else {
            const rig = this._idleRigs.get(bodyMeshId);
            if (rig) {   // restore the base pose so the character settles back to its rest stance
                this._teardownLegIK(skel, rig);   // disable leg chains + clear their ikRotation (BEFORE we re-FK)
                for (const [name, q] of rig.base) {
                    const j = skel.data.joints.find(jt => jt.name === name);
                    if (j) j.localRotation = [...q] as [number, number, number, number];
                }
                skel.computeWorldMatrices(); skel.matricesDirty = true;
            }
            this._idleRigs.delete(bodyMeshId);
            if (wasOn) this.ctx.interactionService.endInteractive();   // release the interactive signal
            if (this._idleRigs.size === 0) { this._idleHeldLive = false; this._syncCohortLiveLoop(); }   // last idle off → release our hold (focus-bg may still need the loop)
        }
        this.ctx.scheduleRender();
    }
    /** Whether a body currently has the idle animation running. */
    isIdleAnimating(bodyMeshId: string): boolean { return this._idleRigs.has(bodyMeshId); }

    /** Start/stop the renderer's live rAF loop for the cooperative idle + focus-bg cohort. Starts the
     *  loop when EITHER wants it and nothing external already drives it (so we never pause a clip/ghost
     *  owner); stops it only when NEITHER wants it AND we were the ones who started it. Both holders
     *  toggle their own `_*HeldLive` flag then call this — so releasing one never pauses while the
     *  other still needs the loop. */
    private _syncCohortLiveLoop(): void {
        const want = this._idleHeldLive || this._focusBgHeldLive;
        if (want && !this._cohortLoopStarted) {
            if (!this.ctx.webgpuRenderer.isLive) { this.ctx.webgpuRenderer.play(); this._cohortLoopStarted = true; }
        } else if (!want && this._cohortLoopStarted) {
            this.ctx.webgpuRenderer.pause();
            this._cohortLoopStarted = false;
        }
    }

    /** Hold the live rAF loop on WHILE an edit mode (mesh-edit / packaging creator) shows an ANIMATED
     *  focus background, so it animates continuously instead of only repainting on mouse-move/click.
     *  The on-demand render loop is a deliberate battery optimisation — a STATIC bg still renders fine
     *  on demand — so we only hold the loop for a time-driven bg. Only 'wavy' is animated (the others,
     *  solid/gradient/checkers/dim/none, are static; see armature-bg-pass.ts). Call after every
     *  enter/exit that toggles the mesh-edit focus bg (setMeshEditModeActive) and from the bg-mode
     *  setter, so toggling the theme to/from 'wavy' while a mode is active starts/stops the loop live.
     *  Coordinated with the idle hold via {@link _syncCohortLiveLoop}; exit always releases. */
    private _syncFocusBgLiveLoop(): void {
        const r = this.renderer3D;
        const need = r.meshEditBgActive && r.getMeshEditBgMode().mode === 'wavy';
        if (need === this._focusBgHeldLive) return;   // no change (keeps begin/endInteractive balanced)
        this._focusBgHeldLive = need;
        if (need) this.ctx.interactionService.beginInteractive();
        else this.ctx.interactionService.endInteractive();
        this._syncCohortLiveLoop();
        this.ctx.scheduleRender();
    }

    /** Pin both feet as IK targets at their current (rest) world position + enable the leg chains, so the idle can
     *  shift the pelvis while the feet stay planted. No-op if the skeleton has no foot chains (older rigs). */
    private _setupLegIK(skel: Skeleton3D, rig: IdleRig): void {
        skel.computeWorldMatrices();   // ensure the foot world positions we pin as targets are current
        const chains: { id: string; footName: string }[] = [];
        for (const c of skel.data.ikChains ?? []) {
            const footName = skel.data.joints[c.endJointIdx]?.name;
            if (footName !== 'foot_L' && footName !== 'foot_R') continue;
            const foot = skel.data.joints[c.endJointIdx];
            c.target = [foot.worldMatrix[12], foot.worldMatrix[13], foot.worldMatrix[14]];   // pin where it rests
            c.enabled = true;
            chains.push({ id: c.id, footName });
        }
        rig.legChains = chains;
    }
    /** Undo _setupLegIK: disable the leg chains + clear the leg joints' ikRotation so FK/manual posing resumes cleanly. */
    private _teardownLegIK(skel: Skeleton3D, rig: IdleRig): void {
        if (!rig.legChains?.length) return;
        for (const lc of rig.legChains) {
            const c = (skel.data.ikChains ?? []).find(cc => cc.id === lc.id);
            if (c) c.enabled = false;
        }
        for (const name of Scene3DManager._LEG_IDLE_JOINTS) {
            const j = skel.data.joints.find(jt => jt.name === name);
            if (j) j.ikRotation = undefined;
        }
        rig.legChains = undefined;
    }
    /** Set a character's leg idle fidelity: 'fk' (default) = free micro weight-shift (feet oscillate ~cm), 'ik' = feet
     *  PINNED via foot-IK while the pelvis shifts (locked feet, +2 solves/frame), 'none' = legs static. Persists across
     *  idle on/off; reconfigures a running idle immediately. */
    setLegIdleMode(bodyMeshId: string, mode: LegIdleMode): void {
        this._legIdleModes.set(bodyMeshId, mode);
        const rig = this._idleRigs.get(bodyMeshId);
        if (!rig) return;                                            // not idling → applies next time idle starts
        const skel = this.getSkeleton(rig.skelId);
        if (!skel) return;
        if (rig.legMode === 'ik') this._teardownLegIK(skel, rig);    // leaving IK → release the pins
        rig.legMode = mode;
        if (mode === 'ik') { this._setupLegIK(skel, rig); }          // entering IK → pin the feet now
        else {                                                       // → restore legs to their captured base (no frozen frame)
            for (const name of Scene3DManager._LEG_IDLE_JOINTS) {
                const q = rig.base.get(name); const j = skel.data.joints.find(jt => jt.name === name);
                if (q && j) { j.localRotation = [...q] as [number, number, number, number]; j.ikRotation = undefined; }
            }
        }
        skel.computeWorldMatrices(); skel.matricesDirty = true;
        this.ctx.scheduleRender();
    }
    /** A character's current leg idle fidelity (default 'fk'). */
    getLegIdleMode(bodyMeshId: string): LegIdleMode { return this._legIdleModes.get(bodyMeshId) ?? 'fk'; }

    // ── Idle breaks (random one-shot personality clips between the base idle) ──
    private _idleBreaks = new Map<string, { enabled: boolean; minSec: number; maxSec: number; clips: string[]; active: { clipId: string; t0: number } | null; nextAt: number }>();

    /**
     * Configure random IDLE BREAKS — the BotW "alive" multiplier: between the base idle, every [minSec,maxSec]
     * (small random range) a random one-shot clip plays (Stretch / Scratch Head / …) then settles back. Requires
     * the base idle to be ON (setIdleAnimation) — breaks tick inside its per-frame callback. `clips` = clip NAMES
     * eligible to fire (default = the built-in one-shots present on the skeleton; any one-shot clip you add is
     * eligible). enabled:false stops breaks. Defaults: minSec 8, maxSec 20.
     */
    setIdleBreaks(bodyMeshId: string, opts: { enabled?: boolean; minSec?: number; maxSec?: number; clips?: string[] }): void {
        const cur = this._idleBreaks.get(bodyMeshId) ?? { enabled: false, minSec: 8, maxSec: 20, clips: [], active: null, nextAt: 0 };
        const next = { ...cur, ...opts, active: cur.active };
        if (opts.enabled && !cur.enabled) next.nextAt = performance.now() + this._idleBreakDelay(next);   // first break
        if (opts.enabled === false) next.active = null;                                                    // stop any in-flight break
        this._idleBreaks.set(bodyMeshId, next);
        if (next.enabled) this._ensureIdleCallback();
    }

    private _idleBreakDelay(b: { minSec: number; maxSec: number }): number {
        return (b.minSec + Math.random() * Math.max(0, b.maxSec - b.minSec)) * 1000;
    }
    private _pickIdleBreakClip(skel: Skeleton3D, names: string[]): string | null {
        const want = names.length ? names : DEFAULT_BREAK_CLIP_NAMES;
        const matches = (skel.data.clips ?? []).filter(c => want.includes(c.name));
        return matches.length ? matches[Math.floor(Math.random() * matches.length)].id : null;
    }
    /** Clear stale IK/constraint rotation on a clip's tracked joints so FK reads the clip's localRotation
     *  (matches what _applyIdle does for its joints — prevents a leftover IK pose hiding the break). */
    private _clearClipIK(skel: Skeleton3D, clip: { tracks: { jointIndex: number }[] }): void {
        for (const tr of clip.tracks) { const j = skel.data.joints[tr.jointIndex]; if (j) { j.ikRotation = undefined; j.constraintRotation = undefined; } }
    }
    /** Tick a body's idle break. Returns true if a break is CURRENTLY playing (so the base idle is skipped). */
    private _tickIdleBreak(skel: Skeleton3D, rig: IdleRig, bodyMeshId: string, now: number): boolean {
        const br = this._idleBreaks.get(bodyMeshId);
        if (!br?.enabled) return false;
        if (br.active) {
            const clip = skel.data.clips?.find(c => c.id === br.active!.clipId);
            if (clip) {
                const tSec = (now - br.active.t0) / 1000;
                const frame = tSec * clip.fps;
                if (frame < clip.endFrame) {
                    // Base idle on ALL joints first → untracked joints (legs, the far arm) keep breathing through
                    // the break; the clip + crossfade only override the joints the break actually animates.
                    this._applyIdle(skel, rig, (now - rig.t0) / 1000);
                    // Crossfade weight: ease 0→1 over the first `fade` s, 1→0 over the last `fade` s.
                    const durSec = clip.endFrame / Math.max(1, clip.fps);
                    const fade = Math.min(0.25, durSec * 0.3);
                    const w = Math.max(0, Math.min(1, Math.min(tSec / fade, (durSec - tSec) / fade)));
                    if (w >= 0.999) {
                        applySkeletonClipAtFrame(clip, skel, frame);
                        this._clearClipIK(skel, clip);
                    } else {
                        // snapshot the idle pose on the clip's rotation joints, apply the clip, slerp back by w
                        const idleQ = new Map<number, [number, number, number, number]>();
                        for (const tr of clip.tracks) if (tr.channel === 'rotation') idleQ.set(tr.jointIndex, [...skel.data.joints[tr.jointIndex].localRotation] as [number, number, number, number]);
                        applySkeletonClipAtFrame(clip, skel, frame);
                        this._clearClipIK(skel, clip);
                        const tmp = quat.create();
                        for (const [ji, q0] of idleQ) {
                            const j = skel.data.joints[ji];
                            quat.slerp(tmp, q0 as unknown as quat, j.localRotation as unknown as quat, w);
                            j.localRotation = [tmp[0], tmp[1], tmp[2], tmp[3]];
                        }
                    }
                    this._finishIdleRig(skel, rig, bodyMeshId);   // squash/stretch (if on) + re-FK + springs
                    return true;
                }
            }
            br.active = null; br.nextAt = now + this._idleBreakDelay(br);   // finished → schedule the next
        } else if (now >= br.nextAt) {
            const clipId = this._pickIdleBreakClip(skel, br.clips);
            if (clipId) { br.active = { clipId, t0: now }; return this._tickIdleBreak(skel, rig, bodyMeshId, now); }   // play it now
            br.nextAt = now + this._idleBreakDelay(br);                     // none eligible → try again later
        }
        return false;
    }

    // ── Squash & stretch (Option B — procedural volume change on top of ANY pose) ──
    private _squashStretch = new Map<string, { enabled: boolean; intensity: number; restSpan: number }>();

    /**
     * Toggle procedural SQUASH & STRETCH — a volume-preserving torso scale derived from how extended/compressed
     * the body is each frame (whole-body vertical span vs its rest span): reach/arms-up → STRETCH (taller+thinner),
     * crouch → SQUASH (shorter+wider), with X/Z = 1/√(Y). Layers on top of the idle + break clips (no per-clip
     * authoring). `intensity` ~0.04–0.12 (subtle; default 0.06); the effect is clamped. Requires the base idle ON (it applies in
     * the idle/break finalize each frame). NOTE: drives lowerback+spine, so push intensity too high and raised
     * arms can shear — keep it subtle.
     */
    setSquashStretch(bodyMeshId: string, opts: { enabled?: boolean; intensity?: number }): void {
        const cur = this._squashStretch.get(bodyMeshId) ?? { enabled: false, intensity: 0.06, restSpan: 0 };
        const next = { ...cur, ...opts };
        if (opts.enabled && !cur.enabled) next.restSpan = 0;   // recalibrate the rest span on (re)enable
        this._squashStretch.set(bodyMeshId, next);
        if (opts.enabled === false) {   // reset the torso scale to rest immediately
            const body = this.getMesh(bodyMeshId);
            const skel = body instanceof SkinnedMesh3D ? body.skeleton : null;
            for (const n of ['lowerback', 'spine']) { const j = skel?.data.joints.find(jj => jj.name === n); if (j) j.localScale = [1, 1, 1]; }
            skel?.computeWorldMatrices(); if (skel) skel.matricesDirty = true;
            this.ctx.scheduleRender();
        } else { this._ensureIdleCallback(); }
    }

    /** Finalize an idle/break frame: apply procedural squash/stretch (if enabled) then re-FK + keep springs alive.
     *  Measures the CLEAN pose (scale reset first) so the span signal doesn't feed back on itself. */
    private _finishIdleRig(skel: Skeleton3D, rig: IdleRig, bodyMeshId: string): void {
        const ss = this._squashStretch.get(bodyMeshId);
        const lb = ss?.enabled ? skel.data.joints.find(j => j.name === 'lowerback') : undefined;
        const sp = ss?.enabled ? skel.data.joints.find(j => j.name === 'spine') : undefined;
        if (ss?.enabled && lb && sp) {
            lb.localScale = [1, 1, 1]; sp.localScale = [1, 1, 1];   // clean pose for the measurement
            skel.computeWorldMatrices();
            let minY = Infinity, maxY = -Infinity;
            for (const j of skel.data.joints) {
                if (/spring|charm|dangle|tail/i.test(j.name)) continue;   // ignore hair/charm bones
                const y = j.worldMatrix[13]; if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
            const span = maxY - minY;
            if (ss.restSpan <= 0) ss.restSpan = span;                     // lazy rest calibration (first frame)
            const ratio = ss.restSpan > 0 ? span / ss.restSpan : 1;
            const k = Math.max(0.88, Math.min(1.15, 1 + (ratio - 1) * ss.intensity));   // Y factor (clamped)
            const s = 1 / Math.sqrt(k);                                   // X/Z = volume-preserving
            lb.localScale = [s, k, s]; sp.localScale = [s, k, s];
            skel.computeWorldMatrices();
        } else {
            skel.computeWorldMatrices();
        }
        // Foot-IK weight-shift: the pelvis just moved (in _applyIdle); re-solve the knees so the PINNED feet stay
        // planted. TWO passes: solveIKChain's position→rotation step is APPROXIMATE (per-joint minimal-arc from the
        // PRE-solve bone directions, applied once), so a single pass leaves the foot slightly off target and it
        // visibly "chases" the moving pelvis a frame behind (the staggered/delayed look). The 2nd pass warm-starts
        // from the 1st result (foot already near target → origDir ≈ newDir), collapsing the conversion error to ~0
        // so the feet lock solid. Cheap: 2 leg chains. (Bump to 3 if any residual chase remains.)
        if (rig.legMode === 'ik' && rig.legChains?.length) {
            solveAllIKChains(skel); skel.computeWorldMatrices();
            solveAllIKChains(skel); skel.computeWorldMatrices();
        }
        skel.matricesDirty = true;
        this._keepSpringsAlive(rig.skelId, 250);
    }

    /** Apply one frame of the idle pose: small phase-offset sine waves on the torso/head, composed onto the captured
     *  base rotations. Breathing ~4.5s, weight-shift/sway ~9.5s, head drift ~16s — kept tiny + organic. */
    // Idle-solver scratch: a name→index map cached per skeleton (rebuilt only when joint count changes — was
    // a fresh Map rebuilt over ALL joints every frame) + reused quats (was quat.create() + an array literal
    // per joint-set, ~15/frame). WeakMap auto-frees when the skeleton is GC'd (no manual cleanup needed).
    private _idleIdxCache = new WeakMap<Skeleton3D, { n: number; idx: Map<string, number> }>();
    private readonly _idleTmpQuat = quat.create();
    private readonly _idleOutQuat = quat.create();

    private _applyIdle(skel: Skeleton3D, rig: { intensity: number; base: Map<string, [number, number, number, number]>; legMode: LegIdleMode }, t: number): void {
        const k = rig.intensity;
        const breath = Math.sin(t * Math.PI * 2 * 0.22);            // inhale/exhale
        const sway   = Math.sin(t * Math.PI * 2 * 0.105);           // weight shift L↔R
        const sway2  = Math.sin(t * Math.PI * 2 * 0.105 + 1.1);     // a lagged copy for the shoulders
        const drift  = Math.sin(t * Math.PI * 2 * 0.062);           // slow head look-around
        let ic = this._idleIdxCache.get(skel);
        if (!ic || ic.n !== skel.data.joints.length) {
            const m = new Map<string, number>();
            for (let i = 0; i < skel.data.joints.length; i++) m.set(skel.data.joints[i].name, i);
            ic = { n: skel.data.joints.length, idx: m };
            this._idleIdxCache.set(skel, ic);
        }
        const idx = ic.idx;
        const tmp = this._idleTmpQuat;
        const set = (name: string, pitchDeg: number, yawDeg: number, rollDeg: number): void => {
            const i = idx.get(name); if (i === undefined) return;
            const base = rig.base.get(name); if (!base) return;
            quat.fromEuler(tmp, pitchDeg * k, yawDeg * k, rollDeg * k);          // small local-space delta
            const out = quat.multiply(this._idleOutQuat, base as unknown as quat, tmp);
            const j = skel.data.joints[i];
            // Mutate localRotation in place (reused array) instead of a fresh literal every set. out is reused
            // scratch → COPY the values, never assign the reference.
            const lr = j.localRotation as number[] | undefined;
            if (lr) { lr[0] = out[0]; lr[1] = out[1]; lr[2] = out[2]; lr[3] = out[3]; }
            else j.localRotation = [out[0], out[1], out[2], out[3]];
            // CRITICAL: computeWorldMatrices() reads (constraintRotation ?? ikRotation ?? localRotation). A leftover
            // IK/constraint rotation from a prior armature edit is NEVER cleared on exit, so it silently OVERRODE the
            // idle's localRotation → "idle does nothing". Clear them on the joints we drive so our pose takes effect.
            j.ikRotation = undefined;
            j.constraintRotation = undefined;
        };
        // pitch = nod (X), yaw = turn (Y), roll = lean (Z). Gentle but clearly visible; `intensity` scales it.
        set('lowerback',  0,             sway * 1.1,  -sway * 2.0);              // sway from the LUMBAR (above the legs) → FEET STAY PLANTED (rotating the root 'hips' carried the feet sideways)
        set('spine',      breath * 1.8,  sway * 0.7,   sway * 2.8);             // chest rises, body leans back
        set('chest',      breath * 3.0,  0,            sway * 1.3);             // ribcage breath
        set('neck',      -breath * 1.4,  drift * 1.8, -sway * 1.6);             // head stays level as the chest moves
        set('head',      -breath * 0.5,  drift * 4.0, -sway * 1.1);             // a slow look-around
        set('shoulder_L', breath * 1.1,  0,            sway2 * 0.9);            // shoulders lift on the inhale + sway
        set('shoulder_R', breath * 1.1,  0,           -sway2 * 0.9);
        // ── Legs (leg idle) ─────────────────────────────────────────────────────────────────────────
        // 'none' → static (torso-only idle). 'fk' → tiny weight-shift on the leg joints directly; the feet
        // oscillate ~1cm (sub-visible, free). 'ik' → drive the PELVIS only; the feet are pinned by foot-IK
        // (solved in _finishIdleRig) so the knees bend for a real, feet-locked contrapposto. Angles are first
        // guesses — tune from a screenshot (like BODY_POSES).
        if (rig.legMode === 'fk') {
            const wL = Math.max(0, sway), wR = Math.max(0, -sway);   // which leg is currently taking the weight
            set('upperleg_L', 0, 0, sway * 0.7);                     // thighs roll a hair with the sway
            set('upperleg_R', 0, 0, sway * 0.7);
            set('lowerleg_L', wR * 1.5, 0, 0);                       // the UNWEIGHTED knee softens
            set('lowerleg_R', wL * 1.5, 0, 0);
            set('foot_L', -wR * 0.8, 0, 0);                          // ankle keeps the sole roughly level
            set('foot_R', -wL * 0.8, 0, 0);
        } else if (rig.legMode === 'ik') {
            // Roll the pelvis OPPOSITE the lowerback lean (contrapposto: hips tip one way, torso counter-leans),
            // + a touch of yaw and breath bob. Feet locked by IK → the knees absorb the tilt.
            set('hips', breath * 0.3, sway * 0.7, sway * 2.4);
        }
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

    /** Request a render pass (for callers that mutate mesh materials directly and set gpuDirty). */
    requestRender3D(): void { this.ctx.scheduleRender(); }

    /** Tell the host the 3D hierarchy changed so it re-reads getScene3DHierarchy (outliner refresh). Use after
     *  a batch of SILENT mutations (e.g. async city staging, exiting City mode) that skipped their own emit. */
    notifySceneGraphChanged3D(): void { this.ctx.emitSceneGraphChanged(); }

    /** Notify that mesh TRANSFORMS were written directly (node x/y/z + updateLocalMatrix) — takes the renderer's
     *  transforms-only FAST PATH next frame (rewrites just the moved slots' matrices; no re-sort/repack/atlas).
     *  The per-frame animation path (world traffic movers). Material/geometry edits still use markInstancesDirty. */
    notifyMeshTransformsChanged3D(): void { this.renderer3D.markTransformsDirty(); this.ctx.scheduleRender(); }

    /** Render the shadow map every N rendered frames (1 = every frame, the default). City mode throttles to ~3 —
     *  the whole-scene shadow depth pre-pass is the biggest per-frame GPU cost of an animated diorama. */
    setShadowUpdateInterval(n: number): void { this.renderer3D.setShadowUpdateInterval(n); }
    /** Suspend/resume the shadow pass entirely (extreme zoom-out — see Renderer3D.setShadowsSuspended). */
    setShadowsSuspended3D(on: boolean): void { this.renderer3D.setShadowsSuspended(on); }
    /** PCF quality tier: 1 = fast 3x3 (city-scale win), 0/2 = default 5x5. Live uniform, no rebuild. */
    setShadowQuality3D(radius: number): void { this.renderer3D.setShadowQuality(radius); this.ctx.scheduleRender(); }
    /** Dynamic-resolution render scale (<1 = lo-res + linear upscale while the camera pans; 1 = native). */
    setDynamicResScale3D(s: number): void { this.renderer3D.setDynamicResScale(s); }
    /** Resize the directional shadow ortho box (world half-extent) so a bigger scene stays inside the frustum. */
    setShadowHalfExtent3D(he: number): void { this.renderer3D.setShadowHalfExtent(he); }
    /** Centre the shadow box on the camera focus (default, texel-snapped — consistent shadows across a panned/
     *  tiled city) vs lock it at the world origin (the old single-scene behaviour). */
    setShadowFollowCamera3D(on: boolean): void { this.renderer3D.setShadowFollowCamera(on); this.ctx.scheduleRender(); }

    /** SSAO — screen-space ambient occlusion (spec docs/specs/ssao.md). Off by default; grounds detail/creases.
     *  cfg: { radius (world units), intensity 0..2, bias, power }. Gate off for cel/PS1 styles (physical AO). */
    setSSAO3D(on: boolean, cfg?: Partial<SSAOConfig>): void { this.renderer3D.setSSAO(on, cfg); this.ctx.scheduleRender(); }
    /** Configure the HOVER-OUTLINE look (thickness + animated pattern + glow) — the "hover halo". `patternMode` 0 =
     *  flat ring (default), 1 = scrolling stripes, 2 = dots, 3 = checker. Applies to ANY hovered mesh. */
    setHoverOutlineStyle3D(style: Partial<HighlightStyle>): void { this.renderer3D.setHoverOutlineStyle(style); this.ctx.scheduleRender(); }
    /** The current hover-outline style. */
    get hoverOutlineStyle3D(): HighlightStyle { return this.renderer3D.hoverOutlineStyle; }
    /** Render the raw AO buffer to screen — verify the occlusion looks right before it feeds lighting (stage 2). */
    setSSAODebug3D(on: boolean): void { this.renderer3D.setSSAODebug(on); this.ctx.scheduleRender(); }
    /** Current SSAO config (seed a panel from this). */
    get ssao3D(): SSAOConfig { return this.renderer3D.ssaoConfig; }

    /** PCF penumbra width multiplier (1 = tight, ~2.5 = soft city-scale shadows). */
    setShadowSoftness(s: number): void { this.renderer3D.setShadowSoftness(s); this.ctx.scheduleRender(); }
    /** Shadow DARKNESS 0..1: 0 = barely-there, ~0.58 = default, 1 = fully black. Live; wire a "Shadow Strength" slider. */
    setShadowStrength3D(strength: number): void { this.renderer3D.setShadowStrength(strength); this.ctx.scheduleRender(); }
    get shadowStrength3D(): number { return this.renderer3D.shadowStrength; }

    /** Renderer perf counters for hitch diagnosis (pool/atlas rebuilds, repacks, shadow passes, appends/warms). */
    getPerf3D(): ReturnType<Renderer3D['getPerfCounters']> { return this.renderer3D.getPerfCounters(); }
    getFrameStats3D(): ReturnType<Renderer3D['getFrameStats3D']> { return this.renderer3D.getFrameStats3D(); }

    /** Diagnostic: number of registered per-frame pre-render callbacks (watch for leaks — climbs = a
     *  callback isn't being removed on teardown). */
    getPreRenderCallbackCount3D(): number { return this.ctx.webgpuRenderer.getPreRenderCallbackCount(); }

    /** Register / unregister a per-frame pre-render callback (e.g. WorldManager's zoom-gated detail LOD). Passthrough
     *  to the renderer's callback list. Return false from the callback (it's a "keep running" flag, not a result). */
    addPreRenderCallback3D(cb: () => boolean): void { this.ctx.webgpuRenderer.addPreRenderCallback(cb); }
    removePreRenderCallback3D(cb: () => boolean): void { this.ctx.webgpuRenderer.removePreRenderCallback(cb); }

    /** Diagnostic: geometry-pool occupancy (see Renderer3D.getGeomPoolStats). */
    getGeomPoolStats3D(): ReturnType<Renderer3D['getGeomPoolStats']> { return this.renderer3D.getGeomPoolStats(); }
    /** Request a one-time geometry-pool compaction next frame (reclaims disposed-tile dead space). Call on idle. */
    requestGeomCompaction3D(): void { this.renderer3D.requestGeomCompaction(); }

    /** PRE-UPLOAD a group's geometry so a later reveal is a cheap visibility flip (async city staging). */
    warmGroupGeometry3D(group: MeshGroup3D): boolean {
        return this.renderer3D.warmGeometry(group.children as unknown as Mesh3D[]);
    }

    /** Screen (CSS) point → the (x, z) where the view ray meets the y=`groundY` plane, or null if it doesn't.
     *  A cheap MESH-FREE alternative to picking for the ground (city meshes are non-pickable) — the region
     *  editor uses this to resolve a viewport click without raycasting ~700 building meshes. */
    pickGroundXZ(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, groundY = 0): [number, number] | null { return this._armature.pickGroundXZ(clientX, clientY, rect, groundY); }

    /** Nudge the active orbit's azimuth (radians) — the TURNTABLE hook (slow auto-spin around the orbit
     *  centre). No-op when no orbit controller is active. Combines gracefully with manual alt+drag. */
    orbitTurntable(deltaRad: number): void { return this._armature.orbitTurntable(deltaRad); }

    /** Up to 16 REAL POINT LIGHTS (street lamps at night): additive lambert with a smooth radius falloff,
     *  applied in the PBR/cel/cel-HD paths. Pass [] to clear. */
    setPointLights3D(lights: { pos: [number, number, number]; radius: number; color: [number, number, number]; intensity: number }[]): void {
        this.renderer3D.setPointLights(lights);
        this.ctx.scheduleRender();
    }
    /** Camera-following point lights: pass the FULL candidate set (every lit lamp); the renderer keeps only the N
     *  nearest the camera focus each frame, so the fixed budget follows the view. Pass [] to clear. */
    setCandidatePointLights3D(lights: { pos: [number, number, number]; radius: number; color: [number, number, number]; intensity: number }[]): void {
        this.renderer3D.setCandidatePointLights(lights);
        this.ctx.scheduleRender();
    }

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
    /** Stored projection preference — survives repeated syncIllustrationCamera calls. */

    /**
     * Sync the 3D camera to the 2D viewport (pan/zoom) for 3D Illustration mode.
     * Call this whenever panOffset or zoomFactor changes. Safe to call every frame.
     *
     * Coordinate convention: 2D uses Y-down (origin top-left), 3D uses Y-up.
     * The camera is placed so that a 3D mesh at (x, -y, 0) aligns with the 2D
     * world point (x, y) — users should negate Y when positioning 3D objects to
     * match 2D canvas coordinates.
     */
    syncIllustrationCamera(panX: number, panY: number, zoom: number, canvasW: number, canvasH: number): void { return this._armature.syncIllustrationCamera(panX, panY, zoom, canvasW, canvasH); }

    /**
     * Switch the 3D Illustration camera between perspective and orthographic.
     * Stores the preference so subsequent syncIllustrationCamera calls don't override it.
     * Immediately re-syncs the camera using the last syncIllustrationCamera params.
     */
    setIllustrationProjection(mode: 'perspective' | 'orthographic'): void { return this._armature.setIllustrationProjection(mode); }

    private _applyIllustrationCamera(): void { this._armature.applyIllustrationCamera(); }

    /**
     * Subscribe to the render loop so the illustration camera automatically tracks
     * the current pan/zoom on every frame.  Call once on document load and the
     * camera will always be in sync — no need to call syncIllustrationCamera manually.
     *
     * Safe to call multiple times (duplicate calls are no-ops).
     */
    enableAutoSyncIllustrationCamera(): void { return this._armature.enableAutoSyncIllustrationCamera(); }

    /** Stop automatic camera sync started by enableAutoSyncIllustrationCamera. */
    disableAutoSyncIllustrationCamera(): void { return this._armature.disableAutoSyncIllustrationCamera(); }

    /** Force the illustration camera auto-sync to RE-APPLY on the next frame even when pan/zoom is
     *  unchanged. Call when RELEASING orbit ownership (edit-mode exit): the auto-sync is change-gated
     *  (only re-syncs on a 2D pan/zoom change), so without this the camera stays at the orbited pose
     *  after exit until the user happens to pan — the "package doesn't snap back until I pan" bug.
     *  Nulling the cache makes the next pre-render callback detect a change and re-sync + scheduleRender
     *  ensures a frame actually runs. */
    private _forceIllustrationResync(): void { this._armature.forceIllustrationResync(); }

    /**
     * Returns the world-space point that the illustration camera is looking at —
     * i.e. the center of the visible canvas area in 3D world coordinates.
     * Use this to place new meshes at the center of the canvas rather than at the
     * world origin (which maps to the top-left corner in illustration mode).
     *
     * Returns null if syncIllustrationCamera has never been called.
     */
    getIllustrationCenter3D(): [number, number, number] | null { return this._armature.getIllustrationCenter3D(); }

    /**
     * Returns the recommended uniform scale for a new mesh in illustration mode.
     * In illustration mode 1 world unit = 1 canvas pixel, so a 1×1×1 mesh is
     * effectively invisible. This returns a scale that makes the mesh appear
     * roughly 10% of the visible canvas height (~100 px at 1080p, zoom 1).
     *
     * Returns 1 if the illustration camera has never been synced (perspective mode default).
     */
    getIllustrationMeshDefaultScale3D(): number { return this._armature.getIllustrationMeshDefaultScale3D(); }

    private illustrationMeshDefaultScale(): number { return this._armature.getIllustrationMeshDefaultScale3D(); }

    /** Frame all meshes in the current camera view. */
    frameAllMeshes(padding = 1.25): boolean {
        const meshes = this.getAllMeshes().filter(m => !m.frameExclude);   // ignore far decoration (void grid / apron)
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
        // Feed the scene size to the camera's autoFar so the far plane always encloses the world (no diagonal/grazing
        // clip, no dolly-culls-the-world) regardless of how far you later orbit/zoom. Cheap; updates on every reframe.
        cam.autoFar = true;
        cam.sceneRadius = radius;

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
        this._armature.getOrbitController()?.syncFromCamera();
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

    enableOrbitControls(config?: OrbitControllerConfig): OrbitController { return this._armature.enableOrbitControls(config); }

    /** Show the view gizmo. Requires orbit controls to be active. No-op if already shown. */
    enableViewGizmo(position?: import('../../renderer/3d/view-gizmo').ViewGizmoPosition): void { return this._armature.enableViewGizmo(position); }

    /** Nav gizmo placement (default top-left). Persists across re-enable; applies live if the gizmo exists. */
    setViewGizmoPosition(position: import('../../renderer/3d/view-gizmo').ViewGizmoPosition): void { return this._armature.setViewGizmoPosition(position); }

    /** Hide the view gizmo and remove its frame callback. */
    disableViewGizmo(): void { return this._armature.disableViewGizmo(); }

    disableOrbitControls(): void { return this._armature.disableOrbitControls(); }

    /**
     * Enable orbit for mesh edit mode. Keeps the camera at its current position —
     * no snap to front view. Sets cam.target to the mesh center and initialises the
     * ortho-offset pan accumulator so the mesh stays at exactly its current screen
     * position after orbit activates.
     */
    enableMeshEditOrbit(meshId: string): void { return this._armature.enableMeshEditOrbit(meshId); }

    /** Disable orbit and clean up mesh edit orbit state. */
    disableMeshEditOrbit(): void { return this._armature.disableMeshEditOrbit(); }

    /**
     * Enter a CITY-editing MODE: alt+drag orbit around the city, a clean focus background, and the view gizmo —
     * the same workspace as Edit-Mesh / Edit-Armature, but pivoted on the world origin (where the diorama sits).
     * The orbit controller then OWNS the camera (via `_meshEditOrbitCenter`), so the 2D illustration sync backs off.
     * Pair with {@link exitCityMode3D}. World generation itself lives in `sm.world` (WorldManager).
     */
    enterCityMode3D(center: [number, number, number] = [0, 0, 0]): void {
        const cam = this.renderer3D.getCamera();
        const sync = this._armature.getIllustrationSync();
        if (sync) {
            const { panX, panY, zoom, canvasH } = sync;
            const cx = -panX / (canvasH * zoom), cy = panY / (canvasH * zoom);
            cam.lookAt(cx, cy, 10, cx, cy, 0);
            cam.orthoSize = 1 / zoom;
        }
        this.enableOrbitControls({ altOrbitOnly: true });
        cam.setTarget(center[0], center[1], center[2]);
        this._armature.getOrbitController()?.syncFromCamera();
        this._armature.setMeshEditOrbitCenter([center[0], center[1], center[2]]);   // orbit now owns the camera
        if (sync) {
            const { panX, panY, zoom, canvasH } = sync;
            const cx = -panX / (canvasH * zoom), cy = panY / (canvasH * zoom);
            this._armature.meshEditOrthoX = cx - center[0]; this._armature.meshEditOrthoY = cy - center[1];
            this._armature.meshEditIllustrationCx = cx; this._armature.meshEditIllustrationCy = cy;
        } else {
            this._armature.meshEditOrthoX = 0; this._armature.meshEditOrthoY = 0; this._armature.meshEditIllustrationCx = 0; this._armature.meshEditIllustrationCy = 0;
        }
        cam.orthoOffsetX = this._armature.meshEditOrthoX; cam.orthoOffsetY = this._armature.meshEditOrthoY;
        this._cityModeActive = true;
        this.setHoveredMesh(null);   // no hover outlines on the diorama while the mode is active
        this.clearSelection();       // drop any stale selection (no gizmo/outline floating over the city)
        this.ctx.interactionService.suppressBoxSelect = true;
        this.enableViewGizmo();
        this.renderer3D.setMeshEditModeActive(true);   // focus background — clean workspace
        this._syncFocusBgLiveLoop();   // hold the live loop if the focus bg is animated ('wavy')
        this.frameAllMeshes(1.3);
        this.ctx.scheduleRender();
    }

    /** Leave City mode: drop the focus background + orbit (which also removes the view gizmo). */
    exitCityMode3D(): void {
        this.ctx.interactionService.suppressBoxSelect = false;
        this._cityModeActive = false;
        this._armature.setMeshEditOrbitCenter(null);
        this._armature.meshEditOrthoX = 0; this._armature.meshEditOrthoY = 0;
        const cam = this.renderer3D.getCamera();
        cam.orthoOffsetX = 0; cam.orthoOffsetY = 0;
        this.renderer3D.setMeshEditModeActive(false);
        this._syncFocusBgLiveLoop();   // release any animated-bg live-loop hold
        this.disableOrbitControls();
        this._forceIllustrationResync();   // snap the camera back to the 2D view NOW (not on the next pan)
    }

    // ── VIEW STATE: target × camera-mode (docs/specs/free-camera-and-scene-targets.md) ──────────────────────
    // Two INDEPENDENT axes: TARGET (illustration → X×Y composite | scene → interactive world) × CAMERA MODE
    // (ortho2D | perspective2D | free3D). Non-destructive — flips what RENDERS / which TOOLS are active / how the
    // CAMERA moves, never the data (the 3D scene graph + 2D layers always coexist). `deriveViewRules` (view-state.ts)
    // is the single source of truth for the 2×3 matrix; the engine applies the camera half here, the Frogmarks UI
    // applies the panel/tool half off `onViewStateChanged` + deriveViewRules(getViewState3D()).
    private _viewState: ViewState = { ...DEFAULT_VIEW_STATE };
    public readonly onViewStateChanged = new EventEmitter<void>();

    getViewState3D(): ViewState { return { ...this._viewState }; }

    /** Switch camera mode. free3D = orbit/pan/dolly (unclamped + nav gizmo, content framed); ortho2D/perspective2D
     *  = the locked illustration camera at that projection. Non-destructive. */
    setCameraMode3D(mode: CameraMode): void {
        if (this._viewState.cameraMode === mode) return;
        this._viewState.cameraMode = mode;
        this._applyViewState();
        this.onViewStateChanged.emit();
        this.ctx.scheduleRender();
        void this._refreshArtboardTexture();   // capture/clear the artboard texture for the new mode
    }

    /** Switch target. P1 stores + emits (Frogmarks hides the 2D panels / reveals the Play slot); the scene-target
     *  render changes (dropping the artboard composite) land in P2. Non-destructive either way. */
    setTarget3D(target: ViewTarget): void {
        if (this._viewState.target === target) return;
        this._viewState.target = target;
        this._applyViewState();
        this.onViewStateChanged.emit();
        this.ctx.scheduleRender();
        void this._refreshArtboardTexture();
    }

    /** illustration × free3D: show/hide the artboard "render frame" outline floating in 3D. */
    setArtboardFrameVisible3D(on: boolean): void {
        this._viewState.showArtboardFrame = on !== false;
        this._applyArtboardFrame();
        this.onViewStateChanged.emit();
        this.ctx.scheduleRender();
    }

    /** Push the artboard render-frame outline to the renderer for the current view state — shown only in
     *  illustration × free3D (+ showArtboardFrame). Sized to the fixed artboard (worldH=2, origin-centred). */
    private _applyArtboardFrame(): void {
        const rules = deriveViewRules(this._viewState);
        const b = this.ctx.webgpuRenderer.getIllustrationBounds?.();
        if (rules.artboardFrame && b) this.renderer3D.setArtboardFrame(true, b.width / 2, b.height / 2);
        else this.renderer3D.setArtboardFrame(false);
    }

    // Textured artboard (docs/specs/textured-artboard.md): the 2D illustration shown on the artboard plane in
    // illustration × free3D. Enabled flag lives in the (persisted) view state; captured once per free3D entry.
    private _capturingArtboard = false;

    /** Toggle the textured artboard (the 2D illustration on the artboard plane in free3D). Persisted in view state. */
    setArtboardTextured3D(on: boolean): void {
        this._viewState.showArtboardTexture = on !== false;
        void this._refreshArtboardTexture();
        this.onViewStateChanged.emit();
    }
    get isArtboardTextured3D(): boolean { return this._viewState.showArtboardTexture; }

    /**
     * In illustration × free3D (+ enabled), capture the 2D illustration to a texture and show it on the artboard
     * plane; otherwise clear it. The capture must render the 2D content, which is HIDDEN in free3D — so it briefly
     * forces a 2D-ortho illustration render state + artboard fit, captures (transparent, no present → no flicker),
     * then restores the free3D view. Re-entrancy-guarded so the internal _applyViewState calls don't recurse.
     */
    private async _refreshArtboardTexture(): Promise<void> {
        if (this._capturingArtboard) return;
        // Independent of the artboard-FRAME (outline) toggle — the texture shows in illustration × free3D whenever
        // enabled, whether or not the outline is on.
        const inIllusFree3D = this._viewState.target === 'illustration' && this._viewState.cameraMode === 'free3D';
        const wr = this.ctx.webgpuRenderer;
        const b = wr.getIllustrationBounds?.();
        if (!(inIllusFree3D && this._viewState.showArtboardTexture) || !b) {
            this.renderer3D.setArtboardTexture(null);
            this.ctx.scheduleRender();
            return;
        }
        this._capturingArtboard = true;
        const is = this.ctx.interactionService;
        const prevPan = { ...is.getPanOffset() };
        const prevZoom = is.getZoomFactor();
        const prevMeshEdit = this.renderer3D.meshEditBgActive;   // free3D hides the 2D content behind this
        try {
            // Force exactly the 2D-illustration render prerequisites for the capture (no camera/view-state change):
            // turn OFF the mesh-edit focus bg (so the 2D content composites again) and fit the artboard. The 2D draws
            // use the 2D world matrix, independent of the free3D camera, so they render framed regardless.
            this.renderer3D.setMeshEditModeActive(false);
            is.setPanOffset(0, 0);
            is.setZoom(0.85);
            const scissor = wr.getArtboardScissor?.();
            const cap = scissor ? await wr.captureArtboardToTexture(scissor) : null;
            this.renderer3D.setArtboardTexture(cap ? cap.texture.createView() : null, b.width / 2, b.height / 2, 1);
        } finally {
            this.renderer3D.setMeshEditModeActive(prevMeshEdit);
            is.setPanOffset(prevPan.x, prevPan.y);
            is.setZoom(prevZoom);
            this._capturingArtboard = false;
            this.ctx.scheduleRender();
        }
    }

    // ── WASD-FLY for the EDITOR free3D camera (distinct from Play's character controller) ────────────────────
    // OPT-IN (default off) so it never captures WASD globally unless the user enters fly mode — the editor way.
    // Active only in free3D edit mode (auto-disabled in the 2D modes and during Play). You AIM by orbit-drag; W/S
    // fly along the look dir, A/D strafe, E/Space up, Q down, Shift boost.
    private _flyController: FlyController | null = null;
    private _flyWanted = false;

    get isFlyEnabled3D(): boolean { return this._flyWanted; }
    /** Toggle the editor fly camera (only takes effect in free3D). Bind to a "Fly" toolbar toggle / shortcut. */
    setFlyEnabled3D(on: boolean): void { this._flyWanted = on !== false; this._applyFly(); }

    private _ensureFly(): FlyController {
        if (!this._flyController) {
            this._flyController = new FlyController({
                getPose: () => { const c = this.renderer3D.getCamera(); return { pos: [c.position[0], c.position[1], c.position[2]], tgt: [c.target[0], c.target[1], c.target[2]] }; },
                setPose: (pos, tgt) => {
                    const c = this.renderer3D.getCamera();
                    c.setPosition(pos[0], pos[1], pos[2]);
                    c.setTarget(tgt[0], tgt[1], tgt[2]);
                    this._armature.getOrbitController()?.syncFromCamera();
                    this.ctx.scheduleRender();
                },
            });
        }
        return this._flyController;
    }

    /** Enable the fly loop only when wanted AND in free3D edit (not playing). */
    private _applyFly(): void {
        const fly = this._ensureFly();
        if (this._flyWanted && this._viewState.cameraMode === 'free3D' && !this._playing) fly.enable();
        else fly.disable();
    }

    // ── CINEMATIC CAMERAS: look through a placeable camera (docs/specs/cinematic-cameras.md) ──────────────────
    // A CameraNode is a Mesh3D tagged isCamera; its TRANSFORM defines the pose (deriveCameraPose). lookThrough
    // drives the render camera to that pose (a static preview — re-call to refresh after moving the camera).
    private _lookThroughCamId: string | null = null;
    private _preLookCam: { pos: [number, number, number]; target: [number, number, number]; mode: 'perspective' | 'orthographic'; fov: number } | null = null;

    get lookThroughCameraId3D(): string | null { return this._lookThroughCamId; }

    /** Camera-node id → FOV (radians) evaluated from its fov keyframe track this frame (in-shot zoom). Transient. */
    private _animatedCamFov = new Map<string, number>();

    /** Point the render camera through a camera node's current pose (shared by manual look-through + the timeline
     *  preview driver). Static — the caller re-invokes to refresh after the node moves. */
    private _driveRenderCamFromCameraMesh(mesh: Mesh3D): void {
        const cam = this.renderer3D.getCamera();
        const pose = deriveCameraPose(mesh.localMatrix as unknown as ArrayLike<number>);   // cameras live at the scene root → local == world
        const s = mesh.cameraSettings ?? { fov: Math.PI / 4, projection: 'perspective' as const, near: 0.1, far: 100 };
        cam.mode = s.projection === 'orthographic' ? 'orthographic' : 'perspective';
        cam.fov = this._animatedCamFov.get(mesh.id) ?? s.fov;   // keyframed fov (zoom) overrides the static setting
        cam.lookAt(pose.eye[0], pose.eye[1], pose.eye[2], pose.eye[0] + pose.forward[0], pose.eye[1] + pose.forward[1], pose.eye[2] + pose.forward[2]);
    }
    /** Remember the edit camera once, so we can restore it when leaving a camera preview. */
    private _snapshotEditCam(): void {
        if (this._preLookCam) return;
        const cam = this.renderer3D.getCamera();
        this._preLookCam = { pos: [cam.position[0], cam.position[1], cam.position[2]], target: [cam.target[0], cam.target[1], cam.target[2]], mode: (cam.mode === 'orthographic' ? 'orthographic' : 'perspective'), fov: cam.fov };
    }
    private _restoreEditCam(): void {
        if (!this._preLookCam) return;
        const cam = this.renderer3D.getCamera();
        const p = this._preLookCam;
        cam.mode = p.mode; cam.fov = p.fov;
        cam.lookAt(p.pos[0], p.pos[1], p.pos[2], p.target[0], p.target[1], p.target[2]);
        this._preLookCam = null;
    }

    // Camera nodes (box) + their optional frog-on-cloud marker sprites are editor-only decorations — hide them all
    // while looking through / previewing / exporting so they never float in the shot. Transient (view state, not
    // persisted); restores exactly what it hid.
    private _markersHidden = false;
    private _hiddenMarkerIds: string[] = [];
    private _cameraMarkerSprites = new Map<string, string>();   // cameraId → its marker-sprite mesh id
    private _setCameraMarkersHidden(hidden: boolean): void {
        if (hidden === this._markersHidden) return;
        if (hidden) {
            this._hiddenMarkerIds = [];
            const hide = (m: Mesh3D | null) => { if (m && m.visible) { m.visible = false; this._hiddenMarkerIds.push(m.id); } };
            for (const m of this.getAllMeshes()) if (m.isCamera) hide(m);
            for (const spriteId of this._cameraMarkerSprites.values()) hide(this.getMesh(spriteId));
        } else {
            for (const id of this._hiddenMarkerIds) { const m = this.getMesh(id); if (m) m.visible = true; }
            this._hiddenMarkerIds = [];
        }
        this._markersHidden = hidden;
        this.renderer3D.markInstancesDirty();
    }

    /**
     * Attach a host-supplied image (the frog-on-a-cloud) as a camera node's marker — a billboard sprite parented to
     * the camera so it follows it, editor-only (auto-hides in the shot with the box). Salsa stays content-agnostic:
     * the ENGINE owns the mechanism, the HOST owns the asset. Replaces any existing marker sprite on that camera.
     * `size`/`offsetY` are world units (default 0.5 / 0.35 — a small sprite floating just above the camera).
     */
    async setCameraMarkerSprite3D(cameraId: string, source: File | Blob | ImageBitmap, opts?: { size?: number; offsetY?: number }): Promise<boolean> {
        const cam = this.getMesh(cameraId);
        if (!cam || !cam.isCamera) return false;
        // Drop any previous marker sprite for this camera.
        const prev = this._cameraMarkerSprites.get(cameraId);
        if (prev) { const m = this.getMesh(prev); m?.parent?.removeChild(m); this._cameraMarkerSprites.delete(cameraId); }

        const size = opts?.size ?? 0.5, offsetY = opts?.offsetY ?? 0.35;
        // Built directly (not via createMesh) so it doesn't steal selection or push an undo entry — it's decoration.
        const sprite = new Mesh3D(this.ctx.interactionService, 0, offsetY, 0, {
            primitive: 'sprite', width: size, height: size, billboard: true,
            material: { diffuse: { r: 1, g: 1, b: 1, a: 1 }, renderStyle: 'unlit', alphaCutout: true, doubleSided: true },
        });
        sprite.name = 'CameraMarker';
        sprite.billboard = true;
        cam.addChild(sprite);                              // localMatrix now = cameraWorld × offset → follows the camera
        this.ctx.emitSceneGraphChanged();                  // invalidate the mesh cache so the sprite renders + hides
        await this.setMeshTexture(sprite.id, source);      // upload the host image as its diffuse texture
        this._cameraMarkerSprites.set(cameraId, sprite.id);
        if (this._markersHidden) sprite.visible = false;   // respect an active preview/look-through
        this.ctx.scheduleRender();
        return true;
    }
    /** Remove a camera node's marker sprite (back to the plain box). */
    removeCameraMarkerSprite3D(cameraId: string): void {
        const id = this._cameraMarkerSprites.get(cameraId);
        if (!id) return;
        const m = this.getMesh(id); m?.parent?.removeChild(m);
        this._cameraMarkerSprites.delete(cameraId);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    lookThroughCamera3D(cameraMeshId: string | null): void {
        if (cameraMeshId === null) {                          // restore the edit camera
            this._restoreEditCam();
            this._lookThroughCamId = null;
            this._setCameraMarkersHidden(false);
            this._applyViewState();                           // re-enable orbit / the edit view
            this.ctx.scheduleRender();
            return;
        }
        const mesh = this.getMesh(cameraMeshId);
        if (!mesh || !mesh.isCamera) return;
        this.setPreviewThroughCameras3D(false);               // manual look-through and the auto preview are exclusive
        this._snapshotEditCam();
        this.disableOrbitControls();
        this._flyController?.disable();
        this._setCameraMarkersHidden(true);                   // don't render camera boxes in the shot
        this._driveRenderCamFromCameraMesh(mesh);
        this._lookThroughCamId = cameraMeshId;
        this.ctx.scheduleRender();
    }

    // ── CINEMATIC CAMERAS: cut/shot track + timeline preview driver (docs/specs/cinematic-cameras.md §3-4) ────
    // A document-level list of cuts ("at frame F, cut to camera C"). In preview mode, every timeline frame drives
    // the render camera through whichever camera is active at that frame. Pure cut logic lives in camera-cuts.ts.
    private _cameraCuts: CameraCut[] = [];
    private _previewThroughCameras = false;
    /** Fires whenever the cut list changes — including via UNDO/REDO and camera deletion. The host refreshes its
     *  timeline "Cameras" lane off this (no polling). */
    public readonly onCameraCutsChanged = new EventEmitter<void>();

    get previewThroughCameras3D(): boolean { return this._previewThroughCameras; }
    getCameraCuts3D(): readonly CameraCut[] { return this._cameraCuts; }
    /** Apply a new cut list: refresh preview, notify listeners, re-render. */
    private _applyCuts(next: CameraCut[]): void {
        this._cameraCuts = next;
        if (this._previewThroughCameras) this._applyCameraPreviewAt(this._currentTimelineFrame());
        this.onCameraCutsChanged.emit();
        this.ctx.scheduleRender();
    }
    /** Commit a new cut list + push one undo step that swaps the whole array (cuts are tiny — snapshotting the
     *  array is simpler and safer than diffing a single edit). Undo/redo re-emit onCameraCutsChanged. */
    private _commitCuts(next: CameraCut[], description: string): void {
        const before = this._cameraCuts;
        this._applyCuts(next);
        this._undoManager.push({
            description,
            undo: () => this._applyCuts(before),
            redo: () => this._applyCuts(next),
        });
    }
    setCameraCut3D(frame: number, cameraId: string): void {
        this._commitCuts(setCut(this._cameraCuts, frame, cameraId), `Set camera cut @ ${frame}`);
    }
    removeCameraCut3D(frame: number): void {
        this._commitCuts(removeCut(this._cameraCuts, frame), `Remove camera cut @ ${frame}`);
    }
    clearCameraCuts3D(): void { this._commitCuts([], 'Clear camera cuts'); }
    /** Replace the whole track (persistence / document restore). Not undoable — this IS the load path. */
    setCameraCuts3D(cuts: CameraCut[]): void { this._applyCuts(cuts.slice().sort((a, b) => a.frame - b.frame)); }

    /** Toggle previewing the timeline THROUGH the placed cameras (mutually exclusive with manual look-through and
     *  Play). On → snapshot the edit camera, disable orbit/fly, drive the render cam from the active camera at the
     *  current frame. Off → restore the edit camera. */
    setPreviewThroughCameras3D(on: boolean): void {
        if (on === this._previewThroughCameras) return;
        if (on && this._playing) return;                      // Play owns the camera — can't preview mid-play
        if (on) {
            if (this._lookThroughCamId !== null) { this._lookThroughCamId = null; }   // drop manual look-through, keep its snapshot
            this._snapshotEditCam();
            this.disableOrbitControls();
            this._flyController?.disable();
            this._setCameraMarkersHidden(true);               // don't render camera boxes in the shot
            this._previewThroughCameras = true;
            this._applyCameraPreviewAt(this._currentTimelineFrame());
        } else {
            this._previewThroughCameras = false;
            this._restoreEditCam();
            this._setCameraMarkersHidden(false);
            this._applyViewState();
        }
        this.ctx.scheduleRender();
    }

    private _currentTimelineFrame(): number {
        return this.ctx.rasterLayerManager?.getTimeline()?.getCurrentFrame() ?? 0;
    }
    /** Drive the render camera through the camera active at `frame` (no-op before the first cut → whatever camera
     *  was already set, e.g. the legacy single-camera track, stays). */
    private _applyCameraPreviewAt(frame: number): void {
        const id = activeCameraAt(this._cameraCuts, frame);
        if (!id) return;
        const mesh = this.getMesh(id);
        if (mesh && mesh.isCamera) this._driveRenderCamFromCameraMesh(mesh);
    }

    /**
     * P4 VIDEO EXPORT (docs/specs/cinematic-cameras.md §7). Deterministically render the cut sequence frame-by-frame
     * THROUGH the placed cameras, handing each rendered frame to `onFrame` as a PNG Blob. The host stitches the PNGs
     * into WebM/MP4 (ffmpeg.wasm or server) — the library stays codec-agnostic. Reuses the same seek→settle→read-back
     * path as artboard thumbnails (waitForFrameSettled + snapshotRegionToBlob), so frames are exact, not realtime.
     *
     * Restores the timeline frame, preview state, and edit camera when done (even on error). Browser-only.
     */
    async exportCinematicFrames3D(
        opts: CinematicExportOptions,
        onFrame: (frame: Blob, index: number, total: number) => void | Promise<void>,
    ): Promise<{ frameCount: number; fps: number; width: number; height: number; durationSec: number }> {
        const err = validateExportOptions(opts);
        if (err) throw new Error(`exportCinematicFrames3D: ${err}`);
        const renderer = this.ctx.webgpuRenderer;
        if (!renderer) throw new Error('exportCinematicFrames3D: no renderer');

        const frames = planCinematicFrames(opts.start, opts.end, opts.frameStep ?? 1);
        const timeline = this.ctx.rasterLayerManager?.getTimeline();
        const prevFrame = timeline?.getCurrentFrame() ?? 1;
        const wasPreview = this._previewThroughCameras;

        if (!wasPreview) this.setPreviewThroughCameras3D(true);   // render through the placed cameras + their cuts
        try {
            await renderer.waitForFrameSettled();                 // populate lastFrameSize before we read it
            const src = renderer.getLastFrameSize();
            // Center-crop the canvas to the OUTPUT aspect so the exported video isn't stretched (letterbox/crop).
            const crop = computeAspectCropRect(src.w, src.h, opts.width, opts.height);
            for (let i = 0; i < frames.length; i++) {
                const f = frames[i];
                timeline?.setCurrentFrame(f);                     // fires frame-changed → applyAllKeyframesAtFrame
                this.applyAllKeyframesAtFrame(f);                 // explicit too (handles unchanged / detached timeline)
                const blob = await renderer.snapshotRegionToBlob(crop.x, crop.y, crop.w, crop.h, opts.width, opts.height, 'image/png');
                await onFrame(blob, i, frames.length);
            }
        } finally {
            if (!wasPreview) this.setPreviewThroughCameras3D(false);
            timeline?.setCurrentFrame(prevFrame);
            this.applyAllKeyframesAtFrame(prevFrame);
            this.ctx.scheduleRender();
        }
        return { frameCount: frames.length, fps: opts.fps, width: opts.width, height: opts.height, durationSec: estimateExportDuration(frames.length, opts.fps) };
    }

    /** Per-frame: show the frustum wireframe of the SELECTED camera node (so you can aim it). Cleared while
     *  previewing through a camera (the frustum would be behind you) or when nothing camera-ish is selected.
     *  Memoized on (id + transform version + settings) so it only rebuilds when something actually moves. */
    private _frustumMemo: { id: string; ver: number; settings: string } | null = null;
    private _refreshCameraFrustum(): boolean {
        if (this._lookThroughCamId !== null || this._previewThroughCameras) {   // looking through a camera — no frustum
            if (this._frustumMemo) { this.renderer3D.setCameraFrustum(null); this._frustumMemo = null; }
            return false;
        }
        let cam: Mesh3D | null = null;
        for (const id of this.getSelected3DIds()) { const m = this.getMesh(id); if (m && m.isCamera) { cam = m; break; } }
        if (!cam) {
            if (this._frustumMemo) { this.renderer3D.setCameraFrustum(null); this._frustumMemo = null; }
            return false;
        }
        const settings = cam.cameraSettings ?? { fov: Math.PI / 4, projection: 'perspective' as const, near: 0.1, far: 100 };
        const ver = cam.localMatrixVersion;
        const sKey = `${settings.fov}|${settings.projection}|${settings.near}|${settings.far}|${settings.orthoSize ?? ''}`;
        if (this._frustumMemo && this._frustumMemo.id === cam.id && this._frustumMemo.ver === ver && this._frustumMemo.settings === sKey) return false;
        const pose = deriveCameraPose(cam.localMatrix as unknown as ArrayLike<number>);
        const aspect = this.renderer3D.getCamera().aspect || (16 / 9);
        const segs = frustumLineSegments(pose, settings, aspect).map(([a, b]) => [[a[0], a[1], a[2]], [b[0], b[1], b[2]]] as [number[], number[]]);
        this.renderer3D.setCameraFrustum(segs);
        this._frustumMemo = { id: cam.id, ver, settings: sKey };
        return false;
    }

    // ── PLAY MODE (scene target — docs/specs/play-mode.md, free-camera-and-scene-targets.md L3) ──────────────
    // A runtime loop + character controller over the scene. NON-DESTRUCTIVE: this first-person controller drives
    // the CAMERA only (no scene mutation), and exit restores the pre-play camera + edit view. When later phases
    // mutate scene state (physics/scripts), enter will snapshot + exit restore it (the Unity model). Frogmarks
    // shows the ▶ button on the scene target and feeds input via setPlayInput3D.
    private _playLoop: GameLoop | null = null;
    private _playController: CharacterController | null = null;
    private _playing = false;
    private _keyboard: KeyboardInput | null = null;
    private _mouseLook: MouseLook | null = null;
    private _playInput: CharacterInput = { forward: 0, right: 0, look: 0, jump: false };
    // Avatar locomotion animation (docs/specs/play-mode.md): map the controller's walk/idle/run/jump/fall state to a
    // clip NAME and hand it to the host to play on the avatar. Pure selection lives in game/locomotion.ts.
    private _playerClips: LocomotionClips | null = null;
    private _playerAnimHandler: ((clipName: string) => void) | null = null;
    private readonly _locoDriver = new LocomotionClipDriver();
    // Trigger volumes (docs/specs/play-mode.md): scene zones that fire enter/exit events as the player moves through
    // them — the primitive that turns "walk around" into "the scene responds". Handler wired by the host.
    private readonly _triggerSystem = new TriggerVolumeSystem();
    private _triggerHandler: ((event: TriggerEvent) => void) | null = null;
    private readonly _triggerScratch: TriggerEvent[] = [];
    // Interaction "use" verb (game/interaction.ts): nearest-in-range interactable + edge-detected use key → fire.
    private readonly _interactionSystem = new InteractionSystem();
    private _interactHandler: ((targetId: string) => void) | null = null;
    private _lastInteract = false;
    private _prePlayCam: { pos: [number, number, number]; target: [number, number, number]; mode: 'perspective' | 'orthographic' } | null = null;
    /** Transform snapshot captured on enter, restored on exit — the non-destructive guarantee once Play mutates the
     *  scene (physics/scripts). Camera-only Play never touches these, so restore is a safe no-op in that case. */
    private _prePlayXforms: Map<string, PlayXform> | null = null;
    /** The mesh bound as the "Player" (driven by the controller each tick), if any, + its pre-play visibility. */
    private _playerMesh: Mesh3D | null = null;
    private _playerMeshId: string | null = null;
    private _playerPrevVisible = true;
    // Collision broadphase (built on enter when collision is on): the static mesh set + an XZ grid over their
    // footprints, so per-tick ground/wall casts only test nearby meshes. Null = collision off → no grid.
    private _collisionMeshes: Mesh3D[] | null = null;
    private _collisionGrid: SpatialGridXZ | null = null;
    private _candIdx: number[] = [];       // scratch: grid → indices
    private _candMeshes: Mesh3D[] = [];     // scratch: indices → meshes (fed to the picker)
    // Third-person camera follow-smoothing state (the trailing eye position + the wall-clock of the last render tick).
    private _camEye: [number, number, number] | null = null;
    private _camLastMs = 0;
    public readonly onPlayStateChanged = new EventEmitter<void>();

    get isPlaying3D(): boolean { return this._playing; }

    /** Host feeds per-frame intent. forward/right/look ∈ [-1,1]; jump = edge-triggered; lookYaw/lookPitch = direct
     *  radian deltas for mouse-look (when the host drives its own pointer capture instead of the built-in one). */
    setPlayInput3D(input: Partial<CharacterInput>): void {
        if (input.forward !== undefined) this._playInput.forward = input.forward;
        if (input.right !== undefined) this._playInput.right = input.right;
        if (input.look !== undefined) this._playInput.look = input.look;
        if (input.jump !== undefined) this._playInput.jump = input.jump;
        if (input.lookYaw !== undefined) this._playInput.lookYaw = input.lookYaw;
        if (input.lookPitch !== undefined) this._playInput.lookPitch = input.lookPitch;
    }

    /** Register the avatar's locomotion clip names (idle/walk/run?/jump?/fall?) + a handler the Play loop calls with
     *  a clip name whenever the locomotion state transitions — the host plays that clip on the avatar. Pass null
     *  clips to disable. See game/locomotion.ts. */
    setPlayerAnimation3D(clips: LocomotionClips | null, handler: ((clipName: string) => void) | null): void {
        this._playerClips = clips;
        this._playerAnimHandler = handler;
        this._locoDriver.reset();
    }

    /** Set the Play-mode trigger volumes (scene zones that fire enter/exit as the player walks through). */
    setTriggerVolumes3D(volumes: TriggerVolume[]): void { this._triggerSystem.setVolumes(volumes); this._triggerSystem.reset(); }
    /** Handler called with each trigger enter/exit event during Play (wire to game logic / the UI state machine). */
    setTriggerHandler3D(handler: ((event: TriggerEvent) => void) | null): void { this._triggerHandler = handler; }
    /** Which trigger volumes currently contain the player's feet — for an interact key ("what am I standing in?"). */
    triggersContainingPlayer3D(): string[] {
        const cc = this._playController;
        return cc ? this._triggerSystem.containing(cc.pos) : [];
    }

    /** Register the Play-mode interactables (doors/signs/NPCs/…) the player can "use" when in range. */
    setInteractables3D(items: Interactable[]): void { this._interactionSystem.setInteractables(items); }
    /** Handler called with the interactable id when the player "uses" one (in addition to the UI auto-dispatch). */
    setInteractHandler3D(handler: ((targetId: string) => void) | null): void { this._interactHandler = handler; }
    /** The nearest in-range interactable to the player (for a "Press F to use" prompt), or null. */
    nearestInteractable3D(): string | null {
        const cc = this._playController;
        return cc ? (this._interactionSystem.nearest(cc.pos)?.id ?? null) : null;
    }
    /** Fire "use" on the nearest interactable now — host-driven (bind to a custom key). No-op if none / not playing. */
    playerInteract3D(): void { this._fireInteract(); }
    private _fireInteract(): void {
        const cc = this._playController; if (!cc) return;
        const hit = this._interactionSystem.nearest(cc.pos);
        if (hit) this._interactHandler?.(hit.id);
    }

    /**
     * Enter Play mode: run the game loop + character controller over the scene. Camera restored on exit.
     * Options:
     *  - start/config       — spawn point + CharacterConfig overrides (moveSpeed, cameraMode: 'first'|'third', …).
     *  - keyboard (def on)   — attach the built-in WASD keyboard; opt out to feed input via setPlayInput3D.
     *  - mouseLook (def on)  — attach the built-in pointer-lock mouse-look (click the canvas to capture).
     *  - collision (def on)  — walk on real scene geometry (down-ray ground) + block against walls (horizontal ray),
     *                          instead of the flat fallback plane. Set false for the cheap flat-ground behaviour.
     */
    enterPlayMode3D(opts?: {
        start?: [number, number, number];
        config?: Partial<CharacterConfig>;
        keyboard?: boolean;
        mouseLook?: boolean;
        collision?: boolean;
        playerMeshId?: string;
    }): void {
        if (this._playing) return;
        // Play owns the camera — it's mutually exclusive with cut-preview and manual look-through (all three drive
        // the render cam). Tear those down FIRST so _prePlayCam below snapshots the real edit camera, not a shot pose.
        if (this._previewThroughCameras) this.setPreviewThroughCameras3D(false);
        if (this._lookThroughCamId !== null) this.lookThroughCamera3D(null);
        const cam = this.renderer3D.getCamera();
        this._prePlayCam = { pos: [cam.position[0], cam.position[1], cam.position[2]], target: [cam.target[0], cam.target[1], cam.target[2]], mode: (cam.mode === 'orthographic' ? 'orthographic' : 'perspective') };
        this._prePlayXforms = this._snapshotTransforms();
        // Bind the "Player" avatar (if any): the controller drives its transform each tick, and its spawn defaults to
        // wherever the avatar sits in the scene. See setPlayerObject3D.
        const playerId = opts?.playerMeshId ?? this._playerMeshId;
        this._playerMesh = playerId ? (this.getAllMeshes().find(m => m.id === playerId) ?? null) : null;
        this._playerMeshId = this._playerMesh ? playerId! : null;
        const start = opts?.start ?? (this._playerMesh ? [this._playerMesh.x, this._playerMesh.y, this._playerMesh.z] as [number, number, number] : [cam.position[0], 0, cam.position[2]]);
        const controller = new CharacterController(opts?.config, start);
        this._playController = controller;
        this._playInput = { forward: 0, right: 0, look: 0, jump: false };
        // Collision against real scene geometry (opt-out → flat fallback plane). Ground = downward ray per tick;
        // walls = horizontal ray along the move. An XZ broadphase grid (built now over the static mesh set) means
        // each cast only tests nearby meshes, so it scales to a street-sized city. BVHs still build lazily per mesh
        // on first contact — but only for meshes the character actually approaches.
        if (opts?.collision !== false) {
            this._buildCollisionGrid();
            controller.groundSampler = (x, z) => this._picker.sampleGroundHeight(x, z, this._groundCandidates(x, z));
            controller.moveResolver = (fx, fz, tx, tz, r) => this._resolveWallMove(controller, fx, fz, tx, tz, r);
        }
        this._camEye = null; this._camLastMs = 0;   // third-person follow smoothing starts fresh (first frame snaps)
        this._locoDriver.reset();                    // first tick emits the initial locomotion clip (idle)
        this._triggerSystem.reset();                 // enter events fire fresh from the spawn position
        this._lastInteract = false;                  // don't fire a stale "use" on the first tick
        // Built-in WASD keyboard unless the host opts out (to feed its own input via setPlayInput3D).
        if (opts?.keyboard !== false) { this._keyboard = new KeyboardInput(); this._keyboard.attach(); }
        // Built-in pointer-lock mouse-look unless opted out — click the canvas to capture the pointer.
        if (opts?.mouseLook !== false) { this._mouseLook = new MouseLook(); this._mouseLook.attach(this.ctx.webgpuRenderer.getCanvas() as unknown as Element | null); }
        // Player avatar visibility: in first-person you're INSIDE the body (hide it, so it doesn't fill the view);
        // in third-person you follow it (keep it shown). Restored on exit.
        if (this._playerMesh) {
            this._playerPrevVisible = this._playerMesh.visible;
            this._playerMesh.visible = controller.cfg.cameraMode === 'third';
            this._drivePlayerMesh(controller);
        }
        cam.mode = 'perspective';
        this._flyController?.disable();                         // Play owns input now (fly re-applies on exit)
        this.disableOrbitControls();                            // the controller owns the camera now
        this._playLoop = new GameLoop();
        this._playLoop.start(
            (dt) => {
                const cc = this._playController; if (!cc) return;
                // Merge keyboard (WASD/turn/jump) with mouse-look (yaw/pitch deltas) and any host-fed intent.
                const base = this._keyboard ? this._keyboard.read() : { ...this._playInput };
                if (this._mouseLook) {
                    const d = this._mouseLook.consume();
                    base.lookYaw = (base.lookYaw ?? 0) + d.yaw;
                    base.lookPitch = (base.lookPitch ?? 0) + d.pitch;
                }
                cc.update(dt, base);
                // Avatar locomotion animation: emit a clip name only on transitions (idle↔walk↔run↔jump↔fall).
                if (this._playerClips && this._playerAnimHandler) {
                    const clip = this._locoDriver.update(cc.locomotion(), this._playerClips);
                    if (clip) this._playerAnimHandler(clip);
                }
                // Trigger volumes: fire enter/exit as the player's feet cross scene zones.
                if (this._triggerHandler) {
                    const events = this._triggerSystem.update(cc.pos, this._triggerScratch);
                    for (const e of events) this._triggerHandler(e);
                }
                // Interaction "use" verb: edge-detect the use key → fire the nearest in-range interactable once.
                const interact = base.interact ?? false;
                if (interact && !this._lastInteract) this._fireInteract();
                this._lastInteract = interact;
            },
            () => {
                const cc = this._playController; if (!cc) return;
                if (this._playerMesh) this._drivePlayerMesh(cc);
                let eye: [number, number, number], tgt: [number, number, number];
                if (cc.cfg.cameraMode === 'third') {
                    [eye, tgt] = this._thirdPersonCamera(cc);
                } else {
                    eye = cc.cameraEye(); tgt = cc.cameraTarget();   // first-person is rigid to the head (no smoothing)
                }
                cam.lookAt(eye[0], eye[1], eye[2], tgt[0], tgt[1], tgt[2]);
                this.ctx.scheduleRender();
            },
        );
        this._playing = true;
        this.onPlayStateChanged.emit();
    }

    /** Exit Play mode: stop the loop, restore the pre-play camera + scene transforms + re-apply the edit view. */
    exitPlayMode3D(): void {
        if (!this._playing) return;
        this._playLoop?.stop();
        this._playLoop = null;
        this._playController = null;
        this._keyboard?.detach();
        this._keyboard = null;
        this._mouseLook?.detach();
        this._mouseLook = null;
        this._playing = false;
        if (this._playerMesh) { this._playerMesh.visible = this._playerPrevVisible; this._playerMesh = null; }
        this._collisionGrid = null; this._collisionMeshes = null; this._camEye = null;
        if (this._prePlayXforms) { this._restoreTransforms(this._prePlayXforms); this._prePlayXforms = null; }
        const cam = this.renderer3D.getCamera();
        if (this._prePlayCam) {
            const p = this._prePlayCam;
            cam.mode = p.mode;
            cam.lookAt(p.pos[0], p.pos[1], p.pos[2], p.target[0], p.target[1], p.target[2]);
            this._prePlayCam = null;
        }
        this._applyViewState();                                 // land back in the edit view (free3D orbit etc.)
        this.onPlayStateChanged.emit();
        this.ctx.scheduleRender();
    }

    /** Assign (or clear with null) the mesh that Play drives as the "Player" avatar: the controller moves it and,
     *  in third-person, the camera follows it (follow distance/height = the CharacterConfig thirdPersonDistance/
     *  thirdPersonHeight). Persists across enter/exit so the host can set it once. Takes effect on the next
     *  enterPlayMode3D; if called mid-play it re-binds immediately. */
    setPlayerObject3D(meshId: string | null): void {
        this._playerMeshId = meshId;
        if (!this._playing) return;
        // Re-bind live: restore the old avatar's visibility, adopt the new one.
        if (this._playerMesh) { this._playerMesh.visible = this._playerPrevVisible; this._playerMesh = null; }
        const m = meshId ? (this.getAllMeshes().find(x => x.id === meshId) ?? null) : null;
        this._playerMesh = m;
        if (m && this._playController) {
            this._playerPrevVisible = m.visible;
            m.visible = this._playController.cfg.cameraMode === 'third';
            this._drivePlayerMesh(this._playController);
        }
    }
    get playerObjectId3D(): string | null { return this._playerMeshId; }

    /** Place the bound Player mesh at the controller's feet, facing its yaw (TRS — localMatrix is derived). Keeps the
     *  avatar's authored scale + pitch/roll; only position and yaw are driven. Assumes the mesh origin ≈ the feet. */
    private _drivePlayerMesh(cc: CharacterController): void {
        const m = this._playerMesh; if (!m) return;
        m.setRotation3D(m.rotationX, cc.yaw, m.rotation);
        m.setPosition3D(cc.pos[0], cc.pos[1], cc.pos[2]);   // last → single localMatrix rebuild with the new yaw
    }

    /** Third-person camera: eye behind the pivot, follow-smoothed (frame-rate independent) and pulled in when a wall
     *  sits between it and the character. Returns [eye, lookTarget]. */
    private _thirdPersonCamera(cc: CharacterController): [[number, number, number], [number, number, number]] {
        const pivot = cc.orbitPivot();
        const f = cc.forwardDir();
        const dist = cc.cfg.thirdPersonDistance;
        const desired: [number, number, number] = [pivot[0] - f[0] * dist, pivot[1] - f[1] * dist, pivot[2] - f[2] * dist];

        // Follow smoothing: trail the desired eye. First frame (or rate ≤ 0) snaps.
        const now = performance.now();
        const dt = this._camLastMs ? Math.min(0.1, (now - this._camLastMs) / 1000) : 0;
        this._camLastMs = now;
        const rate = cc.cfg.cameraFollowRate;
        let eye: [number, number, number] = this._camEye
            ? [expSmooth(this._camEye[0], desired[0], rate, dt), expSmooth(this._camEye[1], desired[1], rate, dt), expSmooth(this._camEye[2], desired[2], rate, dt)]
            : [desired[0], desired[1], desired[2]];

        // Camera-vs-wall: pull the (smoothed) eye in so it never sits inside / through a wall this frame.
        if (cc.cfg.cameraCollision) {
            const dx = eye[0] - pivot[0], dy = eye[1] - pivot[1], dz = eye[2] - pivot[2];
            const d = Math.hypot(dx, dy, dz);
            if (d > 1e-4) {
                const inv = 1 / d, rx = dx * inv, ry = dy * inv, rz = dz * inv;
                const meshes = this._regionCandidates(pivot[0] - dist, pivot[2] - dist, pivot[0] + dist, pivot[2] + dist);
                const hit = this._picker.raycastWorld([pivot[0], pivot[1], pivot[2]], [rx, ry, rz], meshes, true);
                const clamped = clampCameraDistance(d, hit ? hit.distance : Infinity, cc.cfg.cameraCollisionPadding, cc.cfg.cameraMinDistance);
                if (clamped < d) eye = [pivot[0] + rx * clamped, pivot[1] + ry * clamped, pivot[2] + rz * clamped];
            }
        }
        this._camEye = eye;
        return [eye, pivot];
    }

    /** Build the collision broadphase: snapshot the static mesh set (minus the Player avatar — you don't collide
     *  with yourself) and index their world XZ footprints into a grid. Rebuilt each Play-enter; the scene is treated
     *  as static during Play (moving city traffic isn't re-indexed — a v1 limitation, see the spec). */
    private _buildCollisionGrid(): void {
        const meshes = this.getAllMeshes().filter(m => m !== this._playerMesh);
        const aabbs: XZBounds[] = meshes.map(m => this._meshXZBounds(m));
        this._collisionMeshes = meshes;
        this._collisionGrid = SpatialGridXZ.build(aabbs);
    }

    /** World-space XZ AABB of a mesh from its OBB corners (falls back to a point at its origin if not yet computed). */
    private _meshXZBounds(m: Mesh3D): XZBounds {
        const c = m.obbCorners;
        if (!c || c.length === 0) return { minX: m.x, minZ: m.z, maxX: m.x, maxZ: m.z };
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const p of c) {
            if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
            if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
        }
        return { minX, minZ, maxX, maxZ };
    }

    /** Meshes to test for the ground under (x,z) — grid candidates, or all meshes if no grid (fallback). */
    private _groundCandidates(x: number, z: number): Mesh3D[] {
        if (!this._collisionGrid || !this._collisionMeshes) return this.getAllMeshes();
        this._collisionGrid.queryPoint(x, z, this._candIdx);
        return this._fillCandidates();
    }

    /** Meshes overlapping an XZ region — the wall-cast candidate set. */
    private _regionCandidates(minX: number, minZ: number, maxX: number, maxZ: number): Mesh3D[] {
        if (!this._collisionGrid || !this._collisionMeshes) return this.getAllMeshes();
        this._collisionGrid.query({ minX, minZ, maxX, maxZ }, this._candIdx);
        return this._fillCandidates();
    }

    /** Map the scratch index list (_candIdx) → the scratch mesh list (_candMeshes). */
    private _fillCandidates(): Mesh3D[] {
        const src = this._collisionMeshes!;
        const out = this._candMeshes;
        out.length = 0;
        for (const i of this._candIdx) out.push(src[i]);
        return out;
    }

    /** Horizontal wall collision: cast a ray from mid-body along the move direction; step up small ledges, else stop
     *  short of a wall and slide along it (cancels the into-wall component). Best-effort v1 — no capsule / step
     *  clearance beyond the ground clamp; see docs/specs/play-mode.md. */
    private _resolveWallMove(cc: CharacterController, fx: number, fz: number, tx: number, tz: number, radius: number): [number, number] {
        const dx = tx - fx, dz = tz - fz;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-6) return [tx, tz];
        // Broadphase: the meshes near the whole move segment (± radius) — reused for the step sample + both wall casts.
        const pad = radius + cc.cfg.stepHeight;
        const meshes = this._regionCandidates(Math.min(fx, tx) - pad, Math.min(fz, tz) - pad, Math.max(fx, tx) + pad, Math.max(fz, tz) + pad);

        // Step-up: if the ground at the destination only rises a little (curb/stair), it's not a wall — allow the
        // move and let the controller's ground clamp lift the feet onto it.
        const groundDest = this._picker.sampleGroundHeight(tx, tz, meshes);
        if (isClimbableStep(cc.pos[1], groundDest, cc.cfg.stepHeight)) return [tx, tz];

        const inv = 1 / dist;
        const dirX = dx * inv, dirZ = dz * inv;
        const midY = cc.pos[1] + cc.cfg.eyeHeight * 0.5;   // cast from mid-body so a knee-high step isn't a "wall"
        const hit = this._picker.raycastWorld([fx, midY, fz], [dirX, 0, dirZ], meshes, true);
        if (!hit || hit.distance >= dist + radius) return [tx, tz];   // clear path

        // Blocked → slide along the wall. Re-cast along the slide to avoid tunnelling a perpendicular wall.
        const n = hit.faceNormal;
        const [sx, sz] = slideAlongWall(fx, fz, tx, tz, hit.distance, n[0], n[2], radius);
        const sdx = sx - fx, sdz = sz - fz;
        const sdist = Math.hypot(sdx, sdz);
        if (sdist < 1e-6) return [sx, sz];
        const sdirX = sdx / sdist, sdirZ = sdz / sdist;
        const hit2 = this._picker.raycastWorld([fx, midY, fz], [sdirX, 0, sdirZ], meshes, true);
        if (hit2 && hit2.distance < sdist + radius) {
            const allowed = Math.max(0, hit2.distance - radius);
            return [fx + sdirX * allowed, fz + sdirZ * allowed];
        }
        return [sx, sz];
    }

    /** Snapshot every mesh's TRS (the source of truth — localMatrix is derived) so Play exits non-destructively.
     *  Captures position/rotation/scale because the Player mesh (and later physics/scripts) move via setPosition3D
     *  etc., which rebuild localMatrix from these fields — restoring only the matrix would be undone by any later
     *  rebuild. */
    private _snapshotTransforms(): Map<string, PlayXform> {
        const snap = new Map<string, PlayXform>();
        for (const m of this.getAllMeshes()) {
            snap.set(m.id, { x: m.x, y: m.y, z: m.z, rx: m.rotationX, ry: m.rotationY, rz: m.rotation, sx: m.scaleX, sy: m.scaleY, sz: m.scaleZ });
        }
        return snap;
    }

    /** Restore transforms captured by _snapshotTransforms (only meshes that still exist). */
    private _restoreTransforms(snap: Map<string, PlayXform>): void {
        for (const m of this.getAllMeshes()) {
            const s = snap.get(m.id);
            if (!s) continue;
            m.setRotation3D(s.rx, s.ry, s.rz);
            m.setScale3D(s.sx, s.sy, s.sz);
            m.setPosition3D(s.x, s.y, s.z);   // last → one final localMatrix rebuild with all fields restored
        }
    }

    /** Apply the DERIVED camera rules. free3D claims the camera for orbit (the 2D auto-sync backs off — same
     *  mechanism City mode uses), shows the nav gizmo, frames the content; the 2D modes release it back to the
     *  locked illustration camera at the right projection and snap the view back. */
    private _applyViewState(): void {
        const rules = deriveViewRules(this._viewState);
        const cam = this.renderer3D.getCamera();
        if (rules.freeNavigation) {
            cam.mode = 'perspective';
            this.enableOrbitControls();
            this.enableViewGizmo();
            this._armature.setMeshEditOrbitCenter([0, 0, 0]);   // any non-null center → the 2D sync stops fighting orbit
            this._armature.getOrbitController()?.syncFromCamera();
            this.renderer3D.setMeshEditModeActive(true);        // clean 3D workspace bg (drops the 2D artboard composite)
            this.renderer3D.setMeshEditBgMode(VIEW_3D_BG);      // …with a NEUTRAL backdrop, not the 'wavy' focus default
            this.frameAllMeshes(1.4);
        } else {
            // Locked 2D camera (ortho2D / perspective2D). The SCENE target has no artboard, so keep the clean 3D
            // workspace bg (no 2D composite) even in these modes; the illustration target restores its composite.
            const sceneBg = this._viewState.target === 'scene';
            this.renderer3D.setMeshEditModeActive(sceneBg);
            if (sceneBg) this.renderer3D.setMeshEditBgMode(VIEW_3D_BG);
            this.disableOrbitControls();                        // also tears down the nav gizmo
            this._armature.setMeshEditOrbitCenter(null);
            this.setIllustrationProjection(rules.projection);
            this._forceIllustrationResync();                    // snap back to the locked 2D view now
        }
        this._applyArtboardFrame();
        this._applyFly();                                       // fly camera only lives in free3D edit
    }

    /** Enter a clean ORBIT view of a SINGLE mesh (packaging box / product preview). Frames it, then CLAIMS the
     *  camera for orbit by setting `_meshEditOrbitCenter` so the 2D illustration auto-sync BACKS OFF. Without this
     *  claim, the sync locks the 3D camera to the 2D pan/zoom (a front view looking down −Z) EVERY frame, so a
     *  mesh lying in the horizontal XZ plane — the flat packaging dieline at fold 0 — renders EDGE-ON = an
     *  invisible thin line (the "box never shows" bug). Default 3/4 top-down angle makes the flat net face-on;
     *  `altOrbitOnly` keeps left-drag free (for surface painting). Pair with {@link exitMeshOrbit3D}. */
    enterMeshOrbit3D(meshId: string, opts: { azimuth?: number; elevation?: number; padding?: number } = {}): void { return this._armature.enterMeshOrbit3D(meshId, opts); }

    /** Claim the camera for external control at `center` (console/diagnostic tool): the illustration auto-sync
     *  backs off (same `_meshEditOrbitCenter` mechanism as the edit modes). Orbit state syncs if present. */
    claimCameraForOrbit3D(center: [number, number, number]): void { return this._armature.claimCameraForOrbit3D(center); }

    /** Leave the single-mesh orbit view (packaging exit): release the camera back to the 2D illustration sync. */
    exitMeshOrbit3D(): void { return this._armature.exitMeshOrbit3D(); }

    /** Like {@link enterMeshOrbit3D} but frames + orbits a whole GROUP container (the packaging box's
     *  rigid-panel hierarchy: a root MeshGroup3D over N panel meshes). Centre = mean of the panel centres. */
    enterGroupOrbit3D(groupId: string, opts: { azimuth?: number; elevation?: number; padding?: number } = {}): void { return this._armature.enterGroupOrbit3D(groupId, opts); }

    // ── Camera drift-in (Package-Creator §4.3: eased settle instead of a hard cut) ──────────────

    /** Short eased dolly/orbit settle INTO the current framing: starts slightly pulled back +
     *  rotated below the target angles and eases (cubic in-out) onto the spherical pose the orbit
     *  controller already holds (set by enterGroupOrbit3D/enterMeshOrbit3D — call AFTER framing).
     *  Never fights input: the first pointer/wheel interaction on the canvas cancels it in place
     *  (the controller state is always current, so a user drag takes over seamlessly). */
    driftOrbitIn3D(durationMs = 450): void { return this._armature.driftOrbitIn3D(durationMs); }

    /** Stop a running drift-in (listeners removed; camera stays wherever the drift left it). */
    cancelOrbitDrift3D(): void { return this._armature.cancelOrbitDrift3D(); }

    /** Remove a node and its whole subtree (the packaging box root → its panels), evicting per-mesh
     *  picker/renderer caches for every descendant mesh. Not undo-tracked (the box is a transient editor object). */
    disposePackagingSubtree(rootId: string): void {
        const node = this.ctx.sceneGraph.findNodeById(rootId);
        if (!node) return;
        const meshIds: string[] = [];
        const walk = (n: { children?: unknown[] }): void => {
            if (n instanceof Mesh3D) meshIds.push(n.id);
            for (const c of (n.children ?? []) as { children?: unknown[] }[]) walk(c);
        };
        walk(node as unknown as { children?: unknown[] });
        node.parent?.removeChild(node);
        for (const id of meshIds) { this._picker.evictMesh(id); this.renderer3D.evictMeshCaches([id]); }
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    // ── Mesh-edit / UV focus background ────────────────────────────────────────

    /** Set the mesh-edit / UV focus-mode background style. Same options as armature
     *  (`ArmatureBgOptions`): 'wavy' | 'solid' | 'gradient' | 'dim' | 'none'. */
    setMeshEditBgMode3D(opts: import('../../types/armature-3d').ArmatureBgOptions): void { return this._armature.setMeshEditBgMode3D(opts); }

    /** Current mesh-edit / UV focus-mode background style. */
    getMeshEditBgMode3D(): import('../../types/armature-3d').ArmatureBgOptions { return this._armature.getMeshEditBgMode3D(); }

    /** True when the mesh-edit/UV focus background is up AND opaque — i.e. the 2D
     *  illustration content is hidden. Used to also suppress the ephemera overlay. */
    meshEditFocusHidesContent(): boolean { return this._armature.meshEditFocusHidesContent(); }

    /** Toggle orbit controls on/off. */
    toggleOrbitControls(enabled?: boolean): void { return this._armature.toggleOrbitControls(enabled); }

    getOrbitController(): OrbitController | undefined { return this._armature.getOrbitController(); }

    // ── Mesh Creation ────────────────────────────────────────────────

    createBox(x: number, y: number, z: number, width = 1, height = 1, depth = 1, material?: Partial<Material3D>): Mesh3D {
        return this._primitives.box(x, y, z, width, height, depth, material);
    }

    createSphere(x: number, y: number, z: number, radius = 0.5, segments = 16, material?: Partial<Material3D>): Mesh3D {
        return this._primitives.sphere(x, y, z, radius, segments, material);
    }

    createPlane(x: number, y: number, z: number, width = 1, height = 1, material?: Partial<Material3D>): Mesh3D {
        return this._primitives.plane(x, y, z, width, height, material);
    }

    createCylinder(x: number, y: number, z: number, radius = 0.5, height = 1, radialSegments = 16, material?: Partial<Material3D>): Mesh3D {
        return this._primitives.cylinder(x, y, z, radius, height, radialSegments, material);
    }

    createTorus(x: number, y: number, z: number, radius = 0.5, tubeRadius = 0.2, material?: Partial<Material3D>): Mesh3D {
        return this._primitives.torus(x, y, z, radius, tubeRadius, material);
    }

    createCustomMesh(x: number, y: number, z: number, geometry: MeshGeometry, material?: Partial<Material3D>): Mesh3D {
        return this._primitives.custom(x, y, z, geometry, material);
    }

    /**
     * Add a GROUP of flat, single-colour custom meshes to the scene in one shot — used by the world/layout
     * preview (a top-down city map). World-agnostic (plain geometry + colour), so core never depends on
     * `src/world`. No per-mesh selection/undo spam; returns the group so the caller can remove it wholesale.
     */
    addFlatColorMeshGroup(name: string, layers: { name: string; geometry: MeshGeometry; color: [number, number, number]; pattern?: { color: [number, number, number]; freq: number; scale?: number; mode?: 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid' | 'windows' | 'waves'; angle?: number; spacing?: number }; ground?: { surface: GroundSurfaceName; tint?: [number, number, number]; tileMm?: number; groutMm?: number; jitter?: number; metersPerUnit?: number; weather?: 'new' | 'worn' | 'ancient' | 'mossy' | 'dirty' }; castShadow?: boolean; water?: { deep?: [number, number, number]; shallow?: [number, number, number]; waveScale?: number; waveSpeed?: number; choppy?: number; glitter?: number }; emissive?: number; opacity?: number; instanceKey?: string; excludeFromFrame?: boolean; singleSided?: boolean; metal?: { tint?: [number, number, number]; streak?: [number, number, number]; roughness?: number; streakAmount?: number; grime?: number; scale?: number }; neon?: { glow?: [number, number, number]; accent?: [number, number, number]; scanDensity?: number; flicker?: number; scroll?: number; phase?: number }; leafCard?: boolean; glass?: boolean; radialFade?: boolean; outlineRanges?: { id: number; start: number; count: number }[]; reflect?: { strength?: number; roughness?: number }; renderStyle?: 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'; rim?: boolean; wind?: FoliageWindSpec; foliageShade?: FoliageShadeSpec; instances?: { x: number; y: number; z: number; ry: number; s?: number; tint?: [number, number, number]; skin?: string }[]; arrayGroup?: boolean; garp?: { pool: string; slot: string; seed: number } }[], silent = false, parent?: MeshGroup3D): MeshGroup3D {
        const group = new MeshGroup3D(this.ctx.interactionService);
        group.name = name;
        // Build one mesh for a layer at a given transform + tint. When a layer carries `instances`, its geometry is
        // LOCAL/canonical and we spawn one mesh PER instance, all sharing the geometry via `instanceKey` (→ one pool
        // allocation + batched instanced draws). Per-instance `tint` overrides the layer colour (free — material is
        // per-instance). No `instances` → one world-baked mesh at the origin (the original behaviour).
        const makeMesh = (L: typeof layers[number], inst?: { x: number; y: number; z: number; ry: number; tint?: [number, number, number] }) => {
            const m = new Mesh3D(this.ctx.interactionService, inst?.x ?? 0, inst?.y ?? 0, inst?.z ?? 0, { primitive: 'custom', geometry: L.geometry, material: { doubleSided: !L.singleSided, roughness: 1, metalness: 0 } });
            if (inst && inst.ry) m.setRotation3D(0, inst.ry, 0);
            m.name = L.name;
            if (L.outlineRanges) this._meshOutlineRanges.set(m.id, L.outlineRanges);   // per-object sub-ranges (landmark exact-silhouette hover)
            m.pickable = false;   // the city is decoration, not individually selectable — the picker skips it (no per-mesh BVH build → hover/click stays 60fps after a regen)
            m.excludeFromDocument = true;   // procedural — regenerates from world params on load; never serialize its geometry (autosave freeze + bloat)
            if (L.excludeFromFrame) m.frameExclude = true;   // far decoration (void grid / apron) must not drag the auto-frame out
            // Shared-archetype geometry (traffic movers / instanced building detail): same key → ONE pool allocation + batched instanced draws.
            if (L.instanceKey) m.setGeometryKeyOverride('wld:' + L.instanceKey);
            const col = inst?.tint ?? L.color;
            m.setDiffuseColor(col[0], col[1], col[2], 1);
            const e = L.emissive ?? 0.45;   // half-emissive default → reads flat/even like a map; higher = glows (neon / lit windows at night)
            m.material.emissive = { r: col[0] * e, g: col[1] * e, b: col[2] * e, a: 1 };
            if (L.opacity !== undefined && L.opacity < 1) m.material.opacity = L.opacity;   // clouds → transparent pass
            if (L.leafCard) m.material.leafCard = true;   // alpha-cut leaf silhouette (foliage cards)
            if (L.glass) m.material.glassEnhance = true;   // stylized fresnel sky-reflection glass (toggle-gated)
            if (L.radialFade) m.material.radialFade = true;   // soft radial edge dissolve (lamp light-pools → glow, not sticker)
            if (L.reflect) {   // car-paint clearcoat: raise metalness + drop roughness → the base envSpecular reflects the sky hemisphere (GT sheen)
                m.material.metalness = L.reflect.strength ?? 0.4;
                m.material.roughness = L.reflect.roughness ?? 0.32;
            }
            if (L.renderStyle) m.material.renderStyle = L.renderStyle;   // per-layer style override (toon foliage)
            if (L.rim) m.material.rimEnabled = true;                     // Fresnel back-light (Ghibli leaves)
            applyFoliageLook(m.material, L.wind, L.foliageShade);        // S1 wind + S2 translucency/AO/ground blend
            if (L.metal) {
                const mt = L.metal;
                m.material.metalShade = true;
                if (mt.tint) m.material.metalTint = mt.tint;
                if (mt.streak) m.material.metalStreak = mt.streak;
                if (mt.roughness !== undefined) m.material.metalRoughness = mt.roughness;
                if (mt.streakAmount !== undefined) m.material.metalStreakAmount = mt.streakAmount;
                if (mt.grime !== undefined) m.material.metalGrime = mt.grime;
                if (mt.scale !== undefined) m.material.metalScale = mt.scale;
                m.material.metalness = 0.65;
                m.material.emissive = { r: 0, g: 0, b: 0, a: 1 };
            } else if (L.neon) {
                const nn = L.neon;
                m.material.neonShade = true;
                if (nn.glow) m.material.neonGlow = nn.glow;
                if (nn.accent) m.material.neonAccent = nn.accent;
                if (nn.scanDensity !== undefined) m.material.neonScanDensity = nn.scanDensity;
                if (nn.flicker !== undefined) m.material.neonFlicker = nn.flicker;
                if (nn.scroll !== undefined) m.material.neonScroll = nn.scroll;
                if (nn.phase !== undefined) m.material.neonPhase = nn.phase;
            } else if (L.water) {
                const w = L.water;
                m.material.waterShade = true;
                if (w.deep) m.material.waterDeep = w.deep;
                if (w.shallow) m.material.waterShallow = w.shallow;
                if (w.waveScale !== undefined) m.material.waterWaveScale = w.waveScale;
                if (w.waveSpeed !== undefined) m.material.waterWaveSpeed = w.waveSpeed;
                if (w.choppy !== undefined) m.material.waterChoppy = w.choppy;
                if (w.glitter !== undefined) m.material.waterGlitter = w.glitter;
                m.material.metalness = 0;
                // Water is lit, not emissive — the old band motif leaned on emissive to read at all.
                m.material.emissive = { r: 0, g: 0, b: 0, a: 1 };
            } else if (L.ground) {
                // ★ PROCEDURAL GROUND on a city layer (roads / pavements / plaza / parks). Same recipe
                // resolver the standalone `applyGroundMaterial3D` uses — one source of truth for the maths.
                // `groundWorldUV`: the city's ground uv is worldXZ * 0.5, i.e. a WORLD parameterisation, so
                // neighbouring meshes tile continuously; it also retargets the P2 weathering masks, which
                // would otherwise treat the whole city as one giant region border. See Material3D.
                const g = resolveGroundRecipe(L.ground.surface, {
                    tileMm: L.ground.tileMm, groutMm: L.ground.groutMm, tint: L.ground.tint, jitter: L.ground.jitter,
                });
                m.material.groundShade = true;
                // Metres per world unit — the city is a diorama (1 unit = 15 m), so without this every
                // tile and every noise frequency comes out 15× too large. Also marks the uv world-parameterised.
                m.material.groundWorldScale = L.ground.metersPerUnit ?? 1;
                m.material.groundMode = g.mode;
                m.material.groundTile = g.tile;
                m.material.groundJitter = g.jitter;
                m.material.groundGrout = { r: g.seam[0], g: g.seam[1], b: g.seam[2], a: g.groutM };
                m.material.groundWeather = GROUND_WEATHER[L.ground.weather ?? 'worn'] ?? 1;
                m.material.groundWearPath = [0, 0, 0];              // noise-only wear; no authored track in the city yet
                m.material.roughness = g.rough;
                m.material.metalness = 0;
                m.setDiffuseColor(g.tint[0], g.tint[1], g.tint[2], 1);
                // The material IS the detail now — a half-emissive base would wash the pavers flat.
                const ge = L.emissive ?? 0.15;
                m.material.emissive = { r: g.tint[0] * ge, g: g.tint[1] * ge, b: g.tint[2] * ge, a: 1 };
            } else if (L.pattern) {   // in-shader procedural pattern → windows / paving joints / awning stripes / animated waves
                m.material.patternMode = L.pattern.mode ?? 'grid';
                m.material.patternColor = { r: L.pattern.color[0], g: L.pattern.color[1], b: L.pattern.color[2], a: 1 };
                m.material.patternFreq = L.pattern.freq;
                m.material.patternScale = L.pattern.scale ?? 0.15;
                if (L.pattern.angle !== undefined) m.material.patternAngle = L.pattern.angle;
                if (L.pattern.spacing !== undefined) m.material.patternSpacing = L.pattern.spacing;
            }
            m.gpuDirty = true;
            group.addChild(m);
        };
        for (const L of layers) {
            if (L.instances && L.instances.length && L.arrayGroup) {
                // City-scale: ONE GPU-instanced ArrayGroup for all instances (1 node + 1 draw) instead of N meshes.
                this.addExplicitArrayInstances(group, { name: L.name, geometry: L.geometry, color: L.color, emissive: L.emissive,
                    pattern: L.pattern, wind: L.wind, foliageShade: L.foliageShade, leafCard: L.leafCard,
                    renderStyle: L.renderStyle, rim: L.rim, castShadow: L.castShadow, transforms: L.instances, garp: L.garp });
            } else if (L.instances && L.instances.length) {
                for (const inst of L.instances) makeMesh(L, inst);
            } else makeMesh(L);
        }
        (parent ?? this.ctx.sceneGraph.root).addChild(group);
        // `silent` (async city staging): the group is added HIDDEN and will be revealed on the swap. Skip the
        // scene-graph-changed notification so the host never processes the transient old-city + new-city ("2N")
        // state across the staging frames — that intermediate is where a host mesh cache would capture the
        // soon-to-be-removed old meshes and leak them. One notification fires at the reveal instead.
        if (!silent) this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return group;
    }

    /** GARP → dedicated-GARP-atlas layer resolver (registered by ShapeManager, which owns the GarpManager — scene3d
     *  must not depend on it). Given a pool + slot + the copy's world (x,z) + seed, it runs `pickSkin` over the
     *  RUNTIME pool (so user-added variants are eligible) and returns the skin's atlas layer; an explicit `skin`
     *  name forces that skin instead. 0 (blank) for an unknown pool. Undefined until wired. */
    private _garpLayerResolver?: (pool: string, slot: string, x: number, z: number, seed: number, skin?: string) => number;
    setGarpLayerResolver(fn: (pool: string, slot: string, x: number, z: number, seed: number, skin?: string) => number): void {
        this._garpLayerResolver = fn;
    }

    /**
     * Instance ONE canonical (local, origin) geometry at N arbitrary transforms under `parent`, as a single
     * GPU-instanced ArrayGroup — one geometry allocation + one instanced draw for ALL N copies (Tier-2 of the
     * instancing plan). Used by the Block collector to draw a whole neighborhood's juliet balconies / window trim
     * from a handful of geometries instead of thousands of meshes.
     *
     * Mechanism: the SOURCE mesh IS instance 0 (canonical geom placed at transforms[0] + yaw); the ArrayGroup adds
     * the other N-1 (offsets = their positions, per-instance yaw = `t.ry − t0.ry` via instanceOverrides — which the
     * renderer post-multiplies onto the source rotation → the exact placement). All copies share the source material
     * (so `color`/`pattern` is per-group, not per-instance). Both nodes are procedural (never serialized).
     */
    addExplicitArrayInstances(parent: MeshGroup3D, opts: {
        name: string; geometry: MeshGeometry; color: [number, number, number]; emissive?: number;
        pattern?: { color: [number, number, number]; freq: number; scale?: number; mode?: 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid' | 'windows' | 'waves'; angle?: number; spacing?: number };
        /** ★ The FOLIAGE look must survive instancing. City trees are GPU-instanced (a few canonical
         *  variants, hundreds of placements), and without these the whole S1/S2 layer — wind sway, leaf
         *  translucency, base AO, ground blend, the alpha-cut leaf silhouette — was silently dropped for
         *  exactly the meshes it was built for, leaving flat cardboard that does not move. */
        wind?: FoliageWindSpec; foliageShade?: FoliageShadeSpec; leafCard?: boolean;
        renderStyle?: 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'; rim?: boolean;
        /** Big instanced content (trees) — let the instances cast shadows. See Mesh3D. */
        castShadow?: boolean;
        /** GARP (docs/specs/city-props-garp.md §2): this instanced layer wears per-copy SKINS from the dedicated
         *  GARP atlas — the source gets `garpTex`, and each copy's skin is chosen at instantiation (the resolver
         *  runs pickSkin over the runtime pool at the copy's (x,z)+`seed`) → its textureIndex. `pool`+`slot` name
         *  the GARP pool/slot; an explicit transform `skin` overrides the position pick. */
        garp?: { pool: string; slot: string; seed: number };
        /** `s` = per-instance uniform scale (tree size variation without another geometry variant); `skin` = the
         *  GARP skin NAME for this copy (only when `garp` is set — resolved to an atlas layer, never serialized). */
        transforms: { x: number; y: number; z: number; ry: number; s?: number; skin?: string }[];
    }): void {
        const T = opts.transforms;
        if (!T.length) return;
        // GARP: resolve a copy's dedicated-GARP-atlas layer — the resolver runs pickSkin over the RUNTIME pool at
        // the copy's (x,z)+seed (an explicit t.skin forces one). 0/blank when no resolver / unknown pool.
        const garpLayer = (t: { x: number; z: number; skin?: string }): number =>
            opts.garp && this._garpLayerResolver
                ? this._garpLayerResolver(opts.garp.pool, opts.garp.slot, t.x, t.z, opts.garp.seed, t.skin)
                : 0;
        // Source mesh = instance 0 (canonical geometry at transforms[0]).
        const src = new Mesh3D(this.ctx.interactionService, T[0].x, T[0].y, T[0].z, { primitive: 'custom', geometry: opts.geometry, material: { doubleSided: true, roughness: 1, metalness: 0 } });
        if (T[0].ry) src.setRotation3D(0, T[0].ry, 0);
        src.name = opts.name;
        src.pickable = false;
        src.excludeFromDocument = true;
        src.setDiffuseColor(opts.color[0], opts.color[1], opts.color[2], 1);
        const e = opts.emissive ?? 0.45;
        src.material.emissive = { r: opts.color[0] * e, g: opts.color[1] * e, b: opts.color[2] * e, a: 1 };
        if (opts.castShadow) src.castsInstancedShadow = true;
        if (opts.leafCard) src.material.leafCard = true;
        if (opts.renderStyle) src.material.renderStyle = opts.renderStyle;
        if (opts.rim) src.material.rimEnabled = true;
        if (opts.garp) {
            // Source (instance 0) samples the dedicated GARP atlas at its own skin's layer; instances 1..N-1 get
            // their own layer via a per-instance textureIndex override below.
            src.material.hasTexture = true;
            src.material.garpTex = true;
            src.garpLayer = garpLayer(T[0]);
        }
        applyFoliageLook(src.material, opts.wind, opts.foliageShade);
        if (T[0].s !== undefined && T[0].s !== 1) src.setScale3D(T[0].s, T[0].s, T[0].s);
        if (opts.pattern) {
            src.material.patternMode = opts.pattern.mode ?? 'grid';
            src.material.patternColor = { r: opts.pattern.color[0], g: opts.pattern.color[1], b: opts.pattern.color[2], a: 1 };
            src.material.patternFreq = opts.pattern.freq;
            src.material.patternScale = opts.pattern.scale ?? 0.15;
            if (opts.pattern.angle !== undefined) src.material.patternAngle = opts.pattern.angle;
            if (opts.pattern.spacing !== undefined) src.material.patternSpacing = opts.pattern.spacing;
        }
        src.gpuDirty = true;
        parent.addChild(src);
        // ArrayGroup = the other N-1 instances (explicit offsets + per-instance yaw override).
        if (T.length > 1) {
            const offsets = T.slice(1).map(t => [t.x, t.y, t.z] as [number, number, number]);
            const arr = new ArrayGroup3D(this.ctx.interactionService, src.id, { mode: 'explicit', offsets });
            arr.name = `${opts.name} ×${T.length}`;
            const DEG = 180 / Math.PI;
            const overrides = new Map<number, InstanceOverride>();
            const s0 = T[0].s ?? 1;
            for (let i = 1; i < T.length; i++) {
                const dy = T[i].ry - T[0].ry;
                // Scale is RELATIVE to the source mesh, which already carries T[0].s.
                const ds = (T[i].s ?? 1) / s0;
                const rot = Math.abs(dy) > 1e-6 ? { rotationEulerDeg: [0, dy * DEG, 0] as [number, number, number] } : {};
                const scl = Math.abs(ds - 1) > 1e-6 ? { scale: [ds, ds, ds] as [number, number, number] } : {};
                // GARP: EVERY copy needs its own skin layer (not just those with a rot/scale delta).
                const tex = opts.garp ? { textureIndex: garpLayer(T[i]) } : {};
                if (opts.garp || Math.abs(dy) > 1e-6 || Math.abs(ds - 1) > 1e-6) overrides.set(i - 1, { ...rot, ...scl, ...tex });
            }
            if (overrides.size) arr.instanceOverrides = overrides;
            parent.addChild(arr);
        }
        this.registerRestoredArrayGroups();   // ensure the per-frame array-sync callback is active
    }

    // ── Procedural GROUND SCATTER (procedural-ground.md §7, P5) ───────────────────────────────────
    // Track scatter root groups so the distance LOD callback (below) can band-cull them.
    private _scatterGroups: MeshGroup3D[] = [];
    private _scatterLodCb: (() => boolean) | null = null;
    private _scatterLodEnabled = true;

    /**
     * Build a mask-driven SCATTER group over a ground footprint from pre-computed {@link ScatterLayer}s.
     * Each layer becomes ONE GPU-instanced ArrayGroup (source mesh = instance 0 + explicit-offset copies with
     * per-instance yaw/lean/scale overrides) under its own BAND sub-group — so a whole scatter field is a
     * handful of nodes + draws, never thousands of loose meshes. Bands are toggled by {@link _scatterLodCb}.
     */
    addGroundScatterGroup(name: string, layers: ScatterLayer[], center: [number, number, number], extent: number, host?: Mesh3D | MeshGroup3D | null): MeshGroup3D {
        const root = new MeshGroup3D(this.ctx.interactionService);
        root.name = name;
        (root as unknown as { _scatterExtent?: number; _scatterCenter?: number[] })._scatterExtent = extent;
        (root as unknown as { _scatterCenter?: number[] })._scatterCenter = center;
        for (const L of layers) {
            const T = L.transforms;
            if (!T.length) continue;
            const band = new MeshGroup3D(this.ctx.interactionService);
            band.name = L.name;
            (band as unknown as { _scatterBand?: number })._scatterBand = L.band;
            // Build ONE instanced variant (source mesh = instance 0 with its own scale/lean baked on, plus an
            // explicit-offset ArrayGroup for the rest) from a given canonical geometry, into `parent`.
            const mkVariant = (geometry: MeshGeometry, parent: MeshGroup3D, tag: string): void => {
                const mkMat = (): Partial<Material3D> => ({ doubleSided: true, roughness: 1, metalness: 0, ...(L.leafCard ? { leafCard: true } : {}) });
                const src = new Mesh3D(this.ctx.interactionService, T[0].x, T[0].y, T[0].z, { primitive: 'custom', geometry, material: mkMat() });
                // Shared foliage look (S1 wind + S2 translucency/AO): the vegetation bands sway + glow like every
                // other plant. The whole ArrayGroup shares the source material, and the per-instance wind PHASE is
                // hashed in-shader from each copy's model-matrix translation — so a field never pulses in unison.
                applyFoliageLook(src.material, L.wind, L.foliageShade);
                src.setRotation3D(T[0].rx, T[0].ry, T[0].rz);
                src.setScale3D(T[0].scale, T[0].scale, T[0].scale);
                src.name = L.name + tag;
                src.pickable = false;
                src.excludeFromDocument = true;   // procedural — regenerates from the seed, never serialized
                src.frameExclude = true;
                src.cheapBounds = true;           // scatter never re-scans its AABB per frame (§13)
                src.setDiffuseColor(L.color[0], L.color[1], L.color[2], 1);
                src.material.emissive = { r: L.color[0] * 0.35, g: L.color[1] * 0.35, b: L.color[2] * 0.35, a: 1 };
                src.gpuDirty = true;
                parent.addChild(src);
                if (T.length > 1) {
                    const offsets = T.slice(1).map(t => [t.x, t.y, t.z] as [number, number, number]);
                    const arr = new ArrayGroup3D(this.ctx.interactionService, src.id, { mode: 'explicit', offsets });
                    arr.name = `${L.name}${tag} ×${T.length}`;
                    const overrides = new Map<number, InstanceOverride>();
                    for (let i = 1; i < T.length; i++) {
                        // Overrides are RELATIVE to the source (instance 0): subtract its rotation, divide its scale.
                        overrides.set(i - 1, {
                            rotationEulerDeg: [(T[i].rx - T[0].rx), (T[i].ry - T[0].ry), (T[i].rz - T[0].rz)],
                            scale: [T[i].scale / T[0].scale, T[i].scale / T[0].scale, T[i].scale / T[0].scale],
                        });
                    }
                    arr.instanceOverrides = overrides;
                    parent.addChild(arr);
                }
            };
            if (L.lodGeometry) {
                // GEOMETRY-VARIANT LOD (foliage-quality.md §2.5): full blades near, a reduced clump past
                // SCATTER_LOD_MID — same instance transforms, so the field never visibly re-lays-out.
                const near = new MeshGroup3D(this.ctx.interactionService); near.name = `${L.name} (near)`;
                const far = new MeshGroup3D(this.ctx.interactionService); far.name = `${L.name} (far)`;
                far.visible = false;
                mkVariant(L.geometry, near, '');
                mkVariant(L.lodGeometry, far, ' lod');
                (band as unknown as { _scatterLodPair?: MeshGroup3D[] })._scatterLodPair = [near, far];
                band.addChild(near); band.addChild(far);
            } else {
                mkVariant(L.geometry, band, '');
            }
            root.addChild(band);
        }
        // ★ PARENT to the HOST ground mesh when one is given: the instance transforms are then in the mesh's own
        // LOCAL space and the scene graph composes the mesh's transform into every prop (parentChainMatrix), so
        // moving / rotating / scaling the ground carries its foliage with no re-scatter. Falls back to the scene
        // root (world-space transforms) for callers that pre-baked world placement.
        (host ?? this.ctx.sceneGraph.root).addChild(root);
        this._scatterGroups.push(root);
        this.registerRestoredArrayGroups();
        this._ensureScatterLOD();
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return root;
    }

    /** Remove a scatter group created by {@link addGroundScatterGroup}. */
    removeGroundScatterGroup(group: MeshGroup3D): void {
        const i = this._scatterGroups.indexOf(group);
        if (i >= 0) this._scatterGroups.splice(i, 1);
        this.removeFlatColorMeshGroup(group);
    }

    /** Toggle the scatter distance-LOD band cull (procedural-ground.md §13). */
    setGroundScatterLOD(enabled: boolean): void {
        this._scatterLodEnabled = enabled;
        if (!enabled) for (const root of this._scatterGroups) for (const band of root.children) {
            (band as MeshGroup3D).visible = true;
            const pair = (band as unknown as { _scatterLodPair?: MeshGroup3D[] })._scatterLodPair;
            if (pair) { pair[0].visible = true; pair[1].visible = false; }   // LOD off → always the full-blade variant
        }
        this.ctx.scheduleRender();
    }

    // Per-frame distance gate: as the camera pulls back, scatter bands drop in order — flowers(0) → twigs(1)
    // → pebbles(2) → tallGrass(3) first; bushes(4) + rocks(5) linger. v1 is a simple distance gate keyed off
    // the footprint extent; TODO tune the per-band multipliers + fold into the world city-LOD regex once
    // scatter is authored inside the world composer (procedural-ground.md §13).
    private _ensureScatterLOD(): void {
        if (this._scatterLodCb) return;
        const BAND_FAR = [3.0, 3.4, 3.8, 5.0, 8.0, 10.0];   // ×extent thresholds, band 0..5
        const LOD_MID = 1.8;                                 // ×extent: past this, blade props drop to the reduced clump
        this._scatterLodCb = () => {
            if (!this._scatterLodEnabled || !this._scatterGroups.length) return false;
            const cam = this.getCamera();
            for (const root of this._scatterGroups) {
                const meta = root as unknown as { _scatterExtent?: number; _scatterCenter?: number[] };
                const ext = meta._scatterExtent ?? 10;
                const c = meta._scatterCenter ?? [0, 0, 0];
                const metric = cam.mode === 'orthographic'
                    ? cam.orthoSize
                    : Math.hypot(cam.position[0] - c[0], cam.position[1] - c[1], cam.position[2] - c[2]);
                for (const band of root.children) {
                    const b = (band as unknown as { _scatterBand?: number })._scatterBand ?? 0;
                    const show = metric < BAND_FAR[b] * ext;
                    if ((band as MeshGroup3D).visible !== show) (band as MeshGroup3D).visible = show;
                    // Blade props additionally swap GEOMETRY VARIANTS inside the band (§2.5).
                    const pair = (band as unknown as { _scatterLodPair?: MeshGroup3D[] })._scatterLodPair;
                    if (show && pair) {
                        const near = metric < LOD_MID * ext;
                        if (pair[0].visible !== near) pair[0].visible = near;
                        if (pair[1].visible === near) pair[1].visible = !near;
                    }
                }
            }
            return false;
        };
        this.ctx.webgpuRenderer.addPreRenderCallback(this._scatterLodCb);
    }

    /** RE-ATTACH a group previously removed by {@link removeFlatColorMeshGroup} (the streamed-tile LRU cache).
     *  The group's meshes keep their draped/positioned geometry, so re-attaching skips generation entirely; the
     *  VRAM side was evicted on removal, so children re-mark gpuDirty for a fresh pool append. */
    reattachFlatColorMeshGroup(group: MeshGroup3D, parent?: MeshGroup3D, silent = false): void {
        for (const ch of group.children) if (ch instanceof Mesh3D) ch.gpuDirty = true;
        (parent ?? this.ctx.sceneGraph.root).addChild(group);
        this.registerRestoredArrayGroups();   // any ArrayGroup children need the per-frame array-sync callback live
        if (!silent) this.ctx.emitSceneGraphChanged();   // silent = the caller batches ONE notification per tile
        this.ctx.scheduleRender();
    }

    /** Remove a group previously created by {@link addFlatColorMeshGroup}. `silent` skips the host scene-graph
     *  notification — streamed-tile disposal removes ~16 groups per tile and batches ONE notification instead
     *  (each notification is an Angular change-detection pass in the host — a mid-pan storm otherwise). */
    removeFlatColorMeshGroup(group: MeshGroup3D, silent = false): void {
        // If this node (or one of its ancestors) is the selected thin wrapper, drop the gizmo target so a
        // removed City can't leave a phantom selection box floating in the scene.
        if (this._armature.getSelectedThinWrapper() === group) this._setThinWrapper(null);
        // Evict the removed meshes from the picker BVH cache + renderer per-mesh caches — otherwise every
        // regen leaks hundreds of entries (GC pressure → periodic dips) and stale picker BVHs pile up.
        const ids: string[] = [];
        for (const ch of group.children) {
            if (ch instanceof Mesh3D) { ids.push(ch.id); this._picker.evictMesh(ch.id); }
        }
        this.renderer3D.evictMeshCaches(ids);
        group.parent?.removeChild(group);
        if (!silent) this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    // ── City wrapper container (one outliner item; O(1) select + transform-as-a-unit) ──────────────────
    /** Create a THIN-WRAPPER MeshGroup3D container (e.g. the placed City). Its child groups are attached via
     *  the `parent` arg of {@link addFlatColorMeshGroup}; the host shows it as ONE outliner node. */
    /** Find an EXISTING City container in the scene root — e.g. the lightweight marker deserialized from a save —
     *  so the world manager ADOPTS it instead of creating a duplicate (no stacking "City" nodes). Matches a
     *  root-level thin-wrapper / proceduralContent MeshGroup3D by name. Re-applies the thin-wrapper flags. */
    findExistingCityContainer(name = 'City'): MeshGroup3D | null {
        for (const child of this.ctx.sceneGraph.root.children) {
            if (!(child instanceof MeshGroup3D)) continue;
            // Don't adopt a tagged sub-object marker (building / foliage) as the City — they're their own thin-wrappers
            // and coexist with the City at root (disambiguated by worldParams.kind). The City marker has no `kind`.
            if ((child.worldParams as { kind?: string } | null)?.kind) continue;
            if (child.thinWrapper || (child as unknown as { proceduralContent?: boolean }).proceduralContent || child.name === name) {
                child.thinWrapper = true;
                child.documentSkipChildren = true;
                return child;
            }
        }
        return null;
    }

    createCityContainer(name = 'City'): MeshGroup3D {
        const g = new MeshGroup3D(this.ctx.interactionService);
        g.name = name;
        g.thinWrapper = true;
        g.documentSkipChildren = true;   // the City is procedural — don't serialize its meshes into saves (autosave freeze + bloat)
        this.ctx.sceneGraph.root.addChild(g);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return g;
    }

    /** A plain child MeshGroup3D under `parent` (NOT a thin-wrapper / not root) — an internal geometry holder,
     *  e.g. a Block's swappable inner group. Not serialized when an ancestor has documentSkipChildren. */
    createChildGroup(parent: MeshGroup3D, name: string): MeshGroup3D {
        const g = new MeshGroup3D(this.ctx.interactionService);
        g.name = name;
        parent.addChild(g);
        return g;
    }

    /** Apply an absolute transform to a container node. Composes into ALL descendants via parentChainMatrix
     *  (no per-child iteration) — just re-dirty the parent chain + force one renderer re-read (children's own
     *  matrix versions don't bump when only the parent moves). Cheap: O(descendants) dirty walk, once per move. */
    setGroupTransform(group: MeshGroup3D, t: { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; s?: number }): void {
        if (t.x  !== undefined) group.x = t.x;
        if (t.y  !== undefined) group.y = t.y;
        if (t.z  !== undefined) group.z = t.z;
        if (t.rx !== undefined) group.rotationX = t.rx;
        if (t.ry !== undefined) group.rotationY = t.ry;
        if (t.rz !== undefined) group.rotation  = t.rz;
        if (t.s  !== undefined) { group.scaleX = t.s; group.scaleY = t.s; group.scaleZ = t.s; }   // uniform (buildings: metres→display units)
        group.updateParentChainMatrix();
        this.renderer3D.markInstancesDirty();
        this.ctx.scheduleRender();
    }

    /** Frame the camera to a group's descendant geometry (e.g. a newly-added building). Respects the group transform. */
    frameGroup(group: MeshGroup3D, padding = 1.3): boolean {
        const meshes: Mesh3D[] = [];
        group.forEachDeep(n => { if (n instanceof Mesh3D && !n.frameExclude) meshes.push(n); });
        return meshes.length ? this.frameMeshes(meshes, padding) : false;
    }

    /** Mark (or clear) the thin-wrapper container selected as a unit. Drives the renderer's group-target
     *  gizmo/box draw and the transform controller's move/rotate target. Idempotent. */
    private _setThinWrapper(node: MeshGroup3D | null): void { this._armature.setSelectedThinWrapper(node); }

    /** Register a callback invoked after the selected thin-wrapper is moved/rotated via the gizmo, so its
     *  owner can persist the new transform. Used by WorldManager to keep the City's saved transform in sync.
     *  Legacy single-owner setter: resets the list to just this one. */
    setThinWrapperTransformSync(fn: (container: MeshGroup3D) => void): void { return this._armature.setThinWrapperTransformSync(fn); }

    /** Add another thin-wrapper transform listener (e.g. BuildingManager alongside WorldManager). Each listener
     *  is called on every thin-wrapper move and must ignore containers it doesn't own. */
    addThinWrapperTransformSync(fn: (container: MeshGroup3D) => void): void { return this._armature.addThinWrapperTransformSync(fn); }

    /** Root-level MeshGroup3D children (City + Building thin-wrapper containers) — for restore/adoption scans. */
    getRootMeshGroups(): MeshGroup3D[] {
        return this.ctx.sceneGraph.root.children.filter((c): c is MeshGroup3D => c instanceof MeshGroup3D);
    }

    /** Cache the LOCAL-space aggregate AABB of a group's descendant geometry (for the gizmo / selection box).
     *  O(verts) — call once at build, never per frame/select. Skip `exclude`-named subgroups (e.g. moving
     *  traffic, whose transient positions shouldn't define the box). City meshes are world-baked at identity
     *  local transform, so raw geometry coords are already group-local. */
    cacheGroupBounds(group: MeshGroup3D, exclude?: (name: string) => boolean): void {
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const child of group.children) {
            if (child instanceof MeshGroup3D && exclude?.(child.name ?? '')) continue;
            child.forEachDeep(n => {
                if (!(n instanceof Mesh3D)) return;
                const v = n.geometry?.vertices;
                if (!v || v.length === 0) return;
                for (let i = 0; i < v.length; i += 12) {
                    const x = v[i], y = v[i + 1], z = v[i + 2];
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
                }
            });
        }
        group.cachedBounds = isFinite(minX) ? { minX, minY, minZ, maxX, maxY, maxZ } : null;
    }

    /**
     * Create an editable polygon mesh from a 2D silhouette in the XZ plane.
     * The mesh is created with an EditMesh pre-attached — no makeEditable() needed.
     */
    createPolygonMesh(x: number, y: number, z: number, points: [number, number][], height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
        return this._primitives.polygon(x, y, z, points, height, name, material);
    }

    /**
     * Create an editable circle (regular n-gon) mesh extruded along Y.
     * Convenience wrapper around createPolygonMesh.
     */
    createCircleMesh(x: number, y: number, z: number, radius = 0.5, segments = 8, height = 1, name?: string, material?: Partial<Material3D>): Mesh3D {
        return this._primitives.circle(x, y, z, radius, segments, height, name, material);
    }

    /**
     * Parse an OBJ string and create a Mesh3D at (x, y, z).
     * Handles missing normals/UVs, quads, and N-gons automatically.
     */
    importObjMesh(x: number, y: number, z: number, objText: string, material?: Partial<Material3D>): Mesh3D {
        return this._primitives.importObjMesh(x, y, z, objText, material);
    }

    /**
     * Read a .obj File/Blob and create a Mesh3D at (x, y, z).
     * Suitable for drag-and-drop or file-picker input.
     */
    async importObjFile(x: number, y: number, z: number, file: File | Blob, material?: Partial<Material3D>): Promise<Mesh3D> {
        return this._primitives.importObjFile(x, y, z, file, material);
    }

    /**
     * Parse a GLB ArrayBuffer and create one Mesh3D per node in the scene.
     * Node positions, rotations, and scales from the GLTF hierarchy are applied
     * relative to the given (x, y, z) origin.
     * The raw buffer is retained in the model store so the scene can be serialized.
     */
    async importGltfBuffer(x: number, y: number, z: number, buffer: ArrayBuffer, material?: Partial<Material3D>, groupName?: string): Promise<Mesh3D[]> {
        return this._import.importGltfBuffer(x, y, z, buffer, material, groupName);
    }

    /**
     * Read a .glb/.gltf File and create one Mesh3D per node.
     * Suitable for drag-and-drop or file-picker input.
     */
    async importGltfFile(x: number, y: number, z: number, file: File | Blob, material?: Partial<Material3D>): Promise<Mesh3D[]> {
        return this._import.importGltfFile(x, y, z, file, material);
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
            this._blendShapes.applyMorphTargets(mesh, r.morphTargets);
            mesh.gpuDirty = true;
            if (rawBuffer.byteLength > 0) this._modelStore.set(mesh.id, rawBuffer);

            root.addChild(mesh);
            meshes.push(mesh);
        }

        this.ctx.emitSceneGraphChanged();
        this.ctx.setSelectedNode(meshes[0].id);
        this.renderer3D.setSelectedMeshIds(new Set(meshes.map(m => m.id)));
        if (this._armature.getIllustrationSync()) this._applyIllustrationCamera();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Import skinned GLB',
            undo: () => {
                // Keep textures alive for redo (see the single-mesh import); free them in dispose() when orphaned.
                for (const m of meshes) { this._modelStore.delete(m.id); m.parent?.removeChild(m); }
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
            dispose: () => { for (const m of meshes) if (!m.parent) { this._destroyTextureIfUnshared(m.diffuseTexture, m.id); this._destroyTextureIfUnshared(m.normalMapTexture, m.id); } },
        });

        return { skeletons, meshes };
    }

    /** Private delegator kept for the skinned/character GLTF-restore path (which uploads its own node
     *  textures). See scene3d-import.ts. */
    private _applyGltfTextures(mesh: Mesh3D, r: GltfMeshResult, device: GPUDevice | null): void { this._import.applyGltfTextures(mesh, r, device); }

    // ── Blend shape API (delegates to Scene3DBlendShapes) ───────────────────────

    addBlendShape3D(meshId: string, name: string, deltaVertices: Float32Array): number {
        return this._blendShapes.add(meshId, name, deltaVertices);
    }

    setBlendWeight3D(meshId: string, shapeIndex: number, weight: number): void {
        this._blendShapes.setWeight(meshId, shapeIndex, weight);
    }

    getBlendShapes3D(meshId: string): { name: string; weight: number }[] {
        return this._blendShapes.list(meshId);
    }

    removeBlendShape3D(meshId: string, shapeIndex: number): void {
        this._blendShapes.remove(meshId, shapeIndex);
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
            if (state.keyframeTracks) clothMesh.keyframeTracks = cloneKeyframeTracks(state.keyframeTracks);
            if (state.frameLinkAnimation3D) this.setFrameLinkAnimation3D(clothMesh.id, state.frameLinkAnimation3D);

            this._cloth.registerGeometry(clothMesh.id, result);

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
            if (state.id) skinnedMesh.setId(state.id);

            skinnedMesh.name       = state.name ?? 'Skinned Mesh';
            skinnedMesh.skeletonId = state.skeletonId ?? null;
            if (state.isProceduralBody)     skinnedMesh.isProceduralBody     = true;   // re-flag a procedural body
            if (state.transformViaSkeleton) skinnedMesh.transformViaSkeleton = true;   // so a moved character reloads right
            skinnedMesh.setRotation3D(state.rotationX ?? 0, state.rotationY ?? 0, state.rotation ?? 0);
            skinnedMesh.setScale3D(state.scaleX ?? 1, state.scaleY ?? 1, state.scaleZ ?? 1);
            if (state.material) { Object.assign(skinnedMesh.material, state.material); skinnedMesh.gpuDirty = true; }
            skinnedMesh.textureLibraryId   = state.textureLibraryId   ?? null;
            skinnedMesh.normalMapLibraryId = state.normalMapLibraryId ?? null;
            if (state.keyframeTracks) skinnedMesh.keyframeTracks = cloneKeyframeTracks(state.keyframeTracks);

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

        // Procedural body saved PARAMS-ONLY (no baked geometry — it's regenerable): rebuild the geometry +
        // skinning from bodyParams via the generator. This is the LIGHT save path (~KB/character vs ~MB of baked
        // geometry). Deterministic params → the same geometry the overlays re-fit to. The skeleton is restored
        // separately (it carries IK/spring/pose state); only the body MESH is regenerated here. Old saves that
        // still carry inline geometry fall through to the branch below.
        if (state.type === 'SkinnedMesh3D' && state.isProceduralBody && state.bodyParams) {
            const result = generateBodyResult(state.bodyParams);
            const skinnedMesh = new SkinnedMesh3D(
                this.ctx.interactionService, state.x ?? 0, state.y ?? 0, state.z ?? 0,
                { geometry: result.geometry, material: state.material },
            );
            if (state.id) skinnedMesh.setId(state.id);
            skinnedMesh.name             = state.name ?? 'ProcBody';
            skinnedMesh.skeletonId       = state.skeletonId ?? null;
            skinnedMesh.isProceduralBody = true;
            if (state.transformViaSkeleton) skinnedMesh.transformViaSkeleton = true;
            skinnedMesh.setRotation3D(state.rotationX ?? 0, state.rotationY ?? 0, state.rotation ?? 0);
            skinnedMesh.setScale3D(state.scaleX ?? 1, state.scaleY ?? 1, state.scaleZ ?? 1);
            if (state.material) { Object.assign(skinnedMesh.material, state.material); skinnedMesh.gpuDirty = true; }
            skinnedMesh.jointIndices = result.skinning.jointIndices.slice();
            skinnedMesh.jointWeights = result.skinning.jointWeights.slice();
            skinnedMesh.skinDirty = true;
            if (state.keyframeTracks) skinnedMesh.keyframeTracks = cloneKeyframeTracks(state.keyframeTracks);
            // re-seed body params + generator surfaces so overlays fit + live edits merge (§5.1: owned by Scene3DCharacter)
            this._character.registerBody(skinnedMesh.id, state.bodyParams, result.armSurface, result.legSurface, result.torsoSurface);
            this.ctx.sceneGraph.root.addChild(skinnedMesh);
            this.ctx.emitSceneGraphChanged();
            skinnedMesh.stateDirty = false;
            return skinnedMesh;
        }

        // Procedural / inline-geometry SkinnedMesh3D (NO GLB — e.g. the generated body): rebuild it AS a
        // SkinnedMesh3D, not a plain custom mesh. Otherwise it restored as an un-skinned Mesh3D, so
        // `body instanceof SkinnedMesh3D` failed and EVERY overlay rig (hair/clothing/face) silently bailed
        // on restore → "only the bare body comes back" (no hair/clothes), on both refresh and .frogmarks loads.
        if (state.type === 'SkinnedMesh3D' && state.config?.geometry?.vertices?.length) {
            const geom = {
                vertices: Float32Array.from(state.config.geometry.vertices),
                indices:  Uint32Array.from(state.config.geometry.indices ?? []),
                format: '12float' as const,
            };
            const skinnedMesh = new SkinnedMesh3D(
                this.ctx.interactionService, state.x ?? 0, state.y ?? 0, state.z ?? 0,
                { geometry: geom, material: state.material },
            );
            if (state.id) skinnedMesh.setId(state.id);     // keep the id so rigs (keyed by bodyMeshId) re-attach
            skinnedMesh.name       = state.name ?? 'Skinned Mesh';
            skinnedMesh.skeletonId = state.skeletonId ?? null;    // relinkSkinnedMeshSkeletons() wires .skeleton after
            if (state.isProceduralBody)     skinnedMesh.isProceduralBody     = true;
            if (state.transformViaSkeleton) skinnedMesh.transformViaSkeleton = true;
            skinnedMesh.setRotation3D(state.rotationX ?? 0, state.rotationY ?? 0, state.rotation ?? 0);
            skinnedMesh.setScale3D(state.scaleX ?? 1, state.scaleY ?? 1, state.scaleZ ?? 1);
            if (state.material) { Object.assign(skinnedMesh.material, state.material); skinnedMesh.gpuDirty = true; }
            if (state.jointIndicesB64) skinnedMesh.jointIndices = fromBase64ToUint8(state.jointIndicesB64);
            if (state.jointWeightsB64) skinnedMesh.jointWeights = fromBase64ToFloat32(state.jointWeightsB64);
            skinnedMesh.skinDirty = true;
            skinnedMesh.textureLibraryId   = state.textureLibraryId   ?? null;
            skinnedMesh.normalMapLibraryId = state.normalMapLibraryId ?? null;
            if (state.keyframeTracks) skinnedMesh.keyframeTracks = cloneKeyframeTracks(state.keyframeTracks);
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
            // Rebuild from the FULL saved config so PARAMS-ONLY primitives survive reload: metaball
            // (blobs/resolution), revolve (profile), tube (path/radii), plus box/cylinder/etc. dimensions.
            // The old hardcoded switch had NO case for metaball/revolve/tube → those meshes were dropped
            // (state.primitive !== 'custom', no geometry, default: break → mesh stayed null), and it rebuilt
            // the cases it DID know at DEFAULT size (createBox(x,y,z) ignored the saved width/height/depth).
            const cfg = { ...(state.config ?? {}), primitive: state.primitive } as Mesh3DConfig;
            delete (cfg as { geometry?: unknown }).geometry;   // params-only branch (embedded geometry is handled above)
            mesh = this.createMesh(state.x, state.y, state.z, cfg);
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
        if (state.keyframeTracks) mesh.keyframeTracks = cloneKeyframeTracks(state.keyframeTracks);
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
            this._ribbons.registerRibbon(rd);
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
            if (rd.pathMode === 'camera-facing') this._ribbons.ensureTick();

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
    setRenderStyle(nodeId: string, style: RenderStyle): boolean { return this._materials.setRenderStyle(nodeId, style); }

    getRenderStyle(nodeId: string): RenderStyle | null { return this._materials.getRenderStyle(nodeId); }

    /** Set the render style on a whole procedural CHARACTER at once — the body + all its parts (clothing / hair /
     *  attachments; the face decal is unlit so it's skipped). Returns the number of meshes changed. */
    setCharacterRenderStyle(bodyMeshId: string, style: RenderStyle): number { return this._materials.setCharacterRenderStyle(bodyMeshId, style); }

    /** Set the render style on EVERY 3D mesh in the scene at once (face decals skipped). Returns the count changed. */
    setRenderStyleAll(style: RenderStyle): number { return this._materials.setRenderStyleAll(style); }

    /** Set a procedural geometric PATTERN on a mesh's albedo (analytic, antialiased in-shader — crisp at any zoom).
     *  Primary colour = the mesh's diffuse; `color` = the secondary. Live (read fresh each frame). Best on the
     *  default/PBR render style. Works on any mesh — garments, base layers, etc. */
    setMeshPattern(meshId: string, opts: {
        mode?: 'none' | 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid';
        color?: { r: number; g: number; b: number };
        freq?: number; angle?: number; scale?: number; spacing?: number;
    }): void { this._materials.setMeshPattern(meshId, opts); }
    /** The mesh's current pattern settings (or null). */
    getMeshPattern(meshId: string): { mode: string; color: { r: number; g: number; b: number } | null; freq: number; angle: number; scale: number; spacing: number } | null {
        return this._materials.getMeshPattern(meshId);
    }

    /** Named pattern presets (Pinstripe / Polka Dots / Argyle / Gingham / …) — a `ClothingPattern` to drop onto a
     *  garment's `pattern` field or feed to `setMeshPattern`. */
    clothingPatternPresetNames(): string[] { return patternPresetNames(); }
    clothingPatternPreset(name: string): ClothingPattern { return patternPreset(name); }

    /** Thin delegator to Scene3DPrimitives.create (the shared factory) — kept private so internal callers
     *  (ribbon host, slab/sprite helpers) are unchanged. See scene3d-primitives.ts. */
    private createMesh(x: number, y: number, z: number, config: Mesh3DConfig): Mesh3D {
        return this._primitives.create(x, y, z, config);
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
    private _allMeshesCache: Mesh3D[] | null = null;
    private _allMeshesCacheVer = -1;
    /** Flat list of every Mesh3D in the scene. Called on every pick (i.e. every pointer-move hover) — a full
     *  tree walk + fresh array each time was steady per-move CPU + GC. Cached and rebuilt only when the scene
     *  graph STRUCTURE changes (add/remove nodes bump sceneStructureVersion); transforms + mouse-move never do,
     *  so hovering over a big city reuses the same array with zero traversal and zero allocation. */
    getAllMeshes(): Mesh3D[] {
        const ver = this.ctx.sceneStructureVersion();
        if (this._allMeshesCache && this._allMeshesCacheVer === ver) return this._allMeshesCache;
        const meshes: Mesh3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep?.((n: any) => {
            if (n instanceof Mesh3D) meshes.push(n);
        });
        this._allMeshesCache = meshes;
        this._allMeshesCacheVer = ver;
        return meshes;
    }

    /**
     * Render stats for an optional perf HUD. Triangle/vertex/object counts are the VISIBLE scene geometry (the
     * render cost); `byCategory` splits the triangles so the user can see WHAT to simplify. `geometryBytes` is the
     * exact mesh vertex+index buffer size (not full VRAM — textures aren't summed here). `frameMs` = the last
     * frame's CPU encode time; `fps` = render rate over the last second (0 when idle — on-demand rendering).
     * NOTE: array-tool GPU instances aren't multiplied in yet (the base mesh is counted once) — a v2 add, like the
     * real GPU time (needs the `timestamp-query` feature). GP strokes are a separate render path → reported as a count.
     */
    getRenderStats3D(): {
        triangles: number; vertices: number; objects: number;
        byCategory: { body: number; hair: number; clothing: number; charms: number; face: number; scenery: number };
        geometryBytes: number; gpStrokes: number; frameMs: number; fps: number; gpuName: string | null;
    } {
        let triangles = 0, vertices = 0, geometryBytes = 0, objects = 0;
        const byCategory = { body: 0, hair: 0, clothing: 0, charms: 0, face: 0, scenery: 0 };
        for (const m of this.getAllMeshes()) {
            if (!m.visible) continue;                           // hidden meshes don't render
            objects++;
            const t = m.triangleCount;
            triangles += t; vertices += m.vertexCount;
            const g = m.geometry; geometryBytes += g.vertices.byteLength + g.indices.byteLength;
            if (m.isProceduralBody) byCategory.body += t;
            else if (m.isHair) byCategory.hair += t;
            else if (m.isClothing) byCategory.clothing += t;
            else if (m.isAttachment) byCategory.charms += t;
            else if (m.isFaceDecal) byCategory.face += t;
            else byCategory.scenery += t;
        }
        const timing = this.ctx.webgpuRenderer.getRenderTiming();
        return { triangles, vertices, objects, byCategory, geometryBytes, gpStrokes: this.getAllGpObjects().length, ...timing };
    }

    /** Get all Skeleton3D nodes in the scene. */
    private _allSkeletonsCache: Skeleton3D[] | null = null;
    private _allSkeletonsCacheVer = -1;
    /** Every Skeleton3D in the scene. Called EVERY frame by the spring-bone solver — a full tree walk + fresh
     *  array each time was per-frame churn. Cached + rebuilt only on scene-graph STRUCTURE change (same
     *  sceneStructureVersion key as getAllMeshes); animation/transforms never bump it. */
    getAllSkeletons(): Skeleton3D[] {
        const ver = this.ctx.sceneStructureVersion();
        if (this._allSkeletonsCache && this._allSkeletonsCacheVer === ver) return this._allSkeletonsCache;
        const skeletons: Skeleton3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep?.((n: any) => {
            if (n instanceof Skeleton3D) skeletons.push(n);
        });
        this._allSkeletonsCache = skeletons;
        this._allSkeletonsCacheVer = ver;
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
        mesh.material.metalness = 0; mesh.material.roughness = 0.72;   // SKIN: soft + matte; the env-specular grazing sheen reads as the skin highlight (vs the plasticky default 0.5)
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

        // NOTE: no default limitRotation hinges on the elbows/knees. They clamped the OFF-axes to ±20°, but a
        // natural elbow bend (e.g. hand-on-hip) lives largely on Z — so the ±20° Z clamp silently killed real
        // posing. The IK pole targets above already bias the bend direction. Add per-joint limits later via
        // addJointConstraint3D if a specific rig needs anti-hyperextension.

        // Pre-populate the Pose Library + Animation Clips with the default idle/personality set so the
        // character feels alive out of the box (breathe / shift-weight / look-around / stretch / scratch /
        // talk + recallable poses). Idempotent — see installDefaultAnimations.
        this.installDefaultAnimations(skeleton.id);

        // Default STANCE: arms relaxed at the sides (not the rest T-pose, which reads as "arms held out
        // forward"). Bakes the Relaxed shoulder/elbow rotations into localRotation so every idle clip that
        // leaves the arms alone (breathe/shift/look) shows them hanging naturally.
        await this.applyBodyPose3D(skeleton.id, 'Relaxed');

        this._character.registerBody(mesh.id, { ...DEFAULT_BODY_PARAMS, ...(params ?? {}) }, result.armSurface, result.legSurface, result.torsoSurface);
        this.ctx.sceneGraph.root.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return { meshId: mesh.id, skeletonId: skeleton.id };
    }

    // Per-body procedural params + ARM/LEG/TORSO surface caches now live in the character subsystem
    // (scene3d-character.ts); registerBody() stores them, overlays read them there.

    /** Current procedural params for a body (to seed the sliders), or null. */
    getBodyParams(bodyMeshId: string): import('./body-generator').BodyParams | null {
        return this._character.getBodyParams(bodyMeshId);
    }

    /**
     * Live-edit a procedural body: regenerate its geometry + skeleton IN PLACE (same mesh + skeleton
     * ids, so selection/rigs/persistence stay valid; the skeleton's objectTransform is preserved so a
     * moved character stays put), then re-fit every attached overlay (hair, garments, face decal) to
     * the new shape. Merges `params` over the body's current params, so a single slider change keeps
     * the rest. Call on each slider change (cheap — the same generator the preview uses).
     */
    async setBodyParams(bodyMeshId: string, params: Partial<import('./body-generator').BodyParams>, opts?: { immediateRefit?: boolean }): Promise<void> {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.isProceduralBody || !body.skeleton) return;
        const { generateBodyResult, DEFAULT_BODY_PARAMS } = await import('./body-generator');
        const prev = this._character.getBodyParams(bodyMeshId);
        const merged = { ...DEFAULT_BODY_PARAMS, ...(prev ?? {}), ...params };
        // Shallow-equality short-circuit: re-emitting the current values (slider snap-back, duplicate
        // change events) must not pay a full regenerate + overlay refit. Any pending debounced refit
        // (from a real earlier change) still fires on its own timer.
        if (prev && shallowEqualParams(prev, merged)) return;
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
        // 2b. Refresh DERIVED rest state so it reads the NEW layout (else blend shapes / edit-mode
        //     restore evaluate against the pre-regen geometry — stale-base corruption):
        //     · blend shapes: baseVertices is the rest-pose snapshot evaluateBlendShapes() rebuilds
        //       from. Same vertex count (the generator's topology is param-independent) → re-snapshot
        //       + re-apply the current weights. A count mismatch means the deltas can no longer apply
        //       to any vertex → drop them (applying them would corrupt/throw).
        //     · rest skin: the editMesh recompile source (captureRestSkin) must line up with the
        //       current indexed geometry — recapture from the freshly swapped joint arrays.
        if (body.baseVertices) {
            if (body.baseVertices.length === body.geometry.vertices.length) {
                body.baseVertices = new Float32Array(body.geometry.vertices);
                body.evaluateBlendShapes();
            } else {
                body.blendShapes = [];
                body.blendWeights = new Float32Array(0);
                body.baseVertices = null;
            }
        }
        body.captureRestSkin();
        this._character.registerBody(bodyMeshId, merged, result.armSurface, result.legSurface, result.torsoSurface);
        // The body itself updates NOW (cheap, immediate slider feedback)…
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        // 3. …but the overlay refit (clothing ×6 + hair spring-rig rebuild + charms + face decal — the
        //    dominant cost) is DEBOUNCED to the trailing edge of a slider drag. The returned promise
        //    resolves only after the refit ran, so callers that read the regenerated part ids after
        //    awaiting (ShapeManager's render-style/texture carry-over) still see the post-refit scene.
        if (opts?.immediateRefit) {
            const pending = this._refitDebounce.get(bodyMeshId);
            if (pending) { clearTimeout(pending.timer); this._refitDebounce.delete(bodyMeshId); }
            this._character.refitOverlays(bodyMeshId);
            this.ctx.emitSceneGraphChanged();
            this.ctx.scheduleRender();
            if (pending) for (const r of pending.resolvers) r();
            return;
        }
        await new Promise<void>(resolve => {
            const pending = this._refitDebounce.get(bodyMeshId);
            if (pending) clearTimeout(pending.timer);   // still mid-drag → push the refit out again
            const resolvers = pending ? pending.resolvers : [];
            resolvers.push(resolve);
            const timer = setTimeout(() => {
                this._refitDebounce.delete(bodyMeshId);
                try {
                    // Body may have been deleted while the timer was pending — the refit helpers all
                    // no-op on a missing/typeless mesh, so this is safe to call unconditionally.
                    this._character.refitOverlays(bodyMeshId);
                } finally {
                    this.ctx.emitSceneGraphChanged();
                    this.ctx.scheduleRender();
                    for (const r of resolvers) r();
                }
            }, Scene3DManager.BODY_REFIT_DEBOUNCE_MS);
            this._refitDebounce.set(bodyMeshId, { timer, resolvers });
        });
    }

    /** Trailing debounce for the post-body-edit overlay refit (§ perf: one refit per drag, not per tick). */
    private static readonly BODY_REFIT_DEBOUNCE_MS = 120;
    private _refitDebounce = new Map<string, { timer: ReturnType<typeof setTimeout>; resolvers: (() => void)[] }>();

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

    /** Serialize per-body procedural params (so the sliders can re-seed after reload). */
    serializeBodyParams(): { bodyMeshId: string; params: import('./body-generator').BodyParams }[] {
        return this._character.serializeBodyParams();
    }
    /** Restore per-body params on load — the body geometry is already restored as a node, so this just
     *  repopulates the map so a later live edit merges correctly. */
    restoreBodyParams(states: { bodyMeshId: string; params: import('./body-generator').BodyParams }[] | undefined): void {
        this._character.restoreBodyParams(states);
    }

    // ── Anime face / eye expression system — §5.1 extracted (scene3d-character.ts); these delegate. ──
    ensureFace3D(bodyMeshId: string): boolean { return this._character.ensureFace3D(bodyMeshId); }
    createFaceExpression(bodyMeshId: string, name?: string): string | null { return this._character.createFaceExpression(bodyMeshId, name); }
    deleteFaceExpression(bodyMeshId: string, exprId: string): void { this._character.deleteFaceExpression(bodyMeshId, exprId); }
    setActiveFaceExpression(bodyMeshId: string, exprId: string): void { this._character.setActiveFaceExpression(bodyMeshId, exprId); }
    renameFaceExpression(bodyMeshId: string, exprId: string, name: string): void { this._character.renameFaceExpression(bodyMeshId, exprId, name); }
    setFaceBlinkExpression(bodyMeshId: string, exprId: string | null): void { this._character.setFaceBlinkExpression(bodyMeshId, exprId); }
    setFaceBlinkConfig(bodyMeshId: string, cfg: Partial<FaceBlinkConfig>): void { this._character.setFaceBlinkConfig(bodyMeshId, cfg); }
    setAutoBlink(bodyMeshId: string, opts: Partial<FaceBlinkConfig>): void { this._character.setAutoBlink(bodyMeshId, opts); }
    getFaceExpressions(bodyMeshId: string): { expressions: FaceExpression[]; activeId: string | null; blinkId: string | null; blink: FaceBlinkConfig } | null { return this._character.getFaceExpressions(bodyMeshId); }
    getFaceExpressionTextureManager(bodyMeshId: string, exprId: string): RasterTextureManager | null { return this._character.getFaceExpressionTextureManager(bodyMeshId, exprId); }

    getDefaultEyeParams(): EyeParams { return this._character.getDefaultEyeParams(); }
    /** Eye-line world Y delegator — still used by the (not-yet-moved) attachment/clothing code. */
    private _eyeYForBody(bodyMeshId: string, head: { cy: number; ry: number }): number { return this._character.eyeYForBody(bodyMeshId, head); }
    setFaceExpressionProcedural(bodyMeshId: string, exprId: string, params: EyeParams): void { this._character.setFaceExpressionProcedural(bodyMeshId, exprId, params); }
    getFaceExpressionParams(bodyMeshId: string, exprId: string): EyeParams | null { return this._character.getFaceExpressionParams(bodyMeshId, exprId); }
    setFaceGaze(bodyMeshId: string, x: number, y: number): void { this._character.setFaceGaze(bodyMeshId, x, y); }
    getFaceDecalMeshId(bodyMeshId: string): string | null { return this._character.getFaceDecalMeshId(bodyMeshId); }
    frameFace3D(bodyMeshId: string): boolean { return this._character.frameFace3D(bodyMeshId); }
    serializeFaceRigs(): FaceRigState[] { return this._character.serializeFaceRigs(); }
    getFaceTextureExports(): { key: string; mgr: RasterTextureManager; procedural: boolean }[] { return this._character.getFaceTextureExports(); }
    async restoreFaceRigs(states: FaceRigState[] | undefined, faceBlobs: Map<string, ArrayBuffer>): Promise<void> { return this._character.restoreFaceRigs(states, faceBlobs); }

    // ── Procedural hair ──────────────────────────────────────────────────────────
    // Chunky low-poly hair (cap + bangs + side locks + tails) skinned 100% to the head joint (follows
    // poses, like the eye decal), shaded by a root→tip gradient texture (uv.v). Params are the source
    // of truth → rebuilt on load. See docs/specs/hair-generation.md.
    /** Set a body's skin tone (hex, e.g. '#e8b89a') — live. Persists via the body mesh's own material
     *  (the body is a normal saved node, so no extra rig is needed). */
    // ── Character overlays (skin/hair/clothing/attachments) — §5.1 extracted (scene3d-character.ts); delegate. ──
    setSkinTone(bodyMeshId: string, hex: string): void { this._character.setSkinTone(bodyMeshId, hex); }
    getSkinTone(bodyMeshId: string): string | null { return this._character.getSkinTone(bodyMeshId); }
    getDefaultHairParams(): HairParams { return this._character.getDefaultHairParams(); }
    getHairParams(bodyMeshId: string): HairParams | null { return this._character.getHairParams(bodyMeshId); }
    getHairMeshId(bodyMeshId: string): string | null { return this._character.getHairMeshId(bodyMeshId); }
    getEyesMeshId(bodyMeshId: string): string | null { return this._character.getEyesMeshId(bodyMeshId); }
    reapplyPartColor(meshId: string): void { this._character.reapplyPartColor(meshId); }

    // Hair / clothing / attachment rigs all live in the character subsystem (scene3d-character.ts) now.
    setHairParams(bodyMeshId: string, params: HairParams): void { this._character.setHairParams(bodyMeshId, params); }
    removeHair(bodyMeshId: string): void { this._character.removeHair(bodyMeshId); }

    getDefaultClothingParams(slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): ClothingParams { return this._character.getDefaultClothingParams(slot); }
    getClothingPresetNames(slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): string[] { return this._character.getClothingPresetNames(slot); }
    getClothingPreset(slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants', name: string): ClothingParams { return this._character.getClothingPreset(slot, name); }
    getClothingParams(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): ClothingParams | null { return this._character.getClothingParams(bodyMeshId, slot); }
    setClothingParams(bodyMeshId: string, params: ClothingParams): void { this._character.setClothingParams(bodyMeshId, params); }

    attachmentTypeNames(): AttachmentType[] { return this._character.attachmentTypeNames(); }
    getDefaultAttachmentParams(type: AttachmentType): AttachmentParams { return this._character.getDefaultAttachmentParams(type); }
    getDefaultAttachmentPlacement(type: AttachmentType): AttachmentPlacement { return this._character.getDefaultAttachmentPlacement(type); }
    addAttachment(bodyMeshId: string, type: AttachmentType, placement?: AttachmentPlacement, params?: AttachmentParams): string | null { return this._character.addAttachment(bodyMeshId, type, placement, params); }
    setAttachmentParams(id: string, params: AttachmentParams): void { this._character.setAttachmentParams(id, params); }
    setAttachmentPlacement(id: string, placement: AttachmentPlacement): void { this._character.setAttachmentPlacement(id, placement); }
    getAttachment(id: string): { id: string; type: AttachmentType; placement: AttachmentPlacement; params: AttachmentParams } | null { return this._character.getAttachment(id); }
    listAttachments(bodyMeshId: string): { id: string; type: AttachmentType; placement: AttachmentPlacement; params: AttachmentParams }[] { return this._character.listAttachments(bodyMeshId); }
    removeAttachment(id: string): void { this._character.removeAttachment(id); }
    getAttachmentMeshId(id: string): string | null { return this._character.getAttachmentMeshId(id); }
    addBeltLoops(bodyMeshId: string, count = 5, params?: AttachmentParams): string[] { return this._character.addBeltLoops(bodyMeshId, count, params); }
    setCharacterSparkle(bodyMeshId: string, on: boolean, style: 'glint' | 'star' = 'glint'): void { this._character.setCharacterSparkle(bodyMeshId, on, style); }
    serializeAttachments(): { id: string; bodyMeshId: string; placement: AttachmentPlacement; params: AttachmentParams }[] { return this._character.serializeAttachments(); }
    restoreAttachments(states: { id: string; bodyMeshId: string; placement: AttachmentPlacement; params: AttachmentParams }[] | undefined): void { this._character.restoreAttachments(states); }

    removeClothing(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): void { this._character.removeClothing(bodyMeshId, slot); }
    serializeClothingRigs(): { bodyMeshId: string; slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'; params: ClothingParams; renderStyle?: RenderStyle }[] { return this._character.serializeClothingRigs(); }
    restoreClothingRigs(states: { bodyMeshId: string; slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'; params: ClothingParams; renderStyle?: RenderStyle }[] | undefined): void { this._character.restoreClothingRigs(states); }
    clothingRigKeyForMesh(meshId: string): string | null { return this._character.clothingRigKeyForMesh(meshId); }
    getClothingMeshId(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): string | null { return this._character.getClothingMeshId(bodyMeshId, slot); }
    serializeHairRigs(): { bodyMeshId: string; params: HairParams; renderStyle?: RenderStyle }[] { return this._character.serializeHairRigs(); }
    restoreHairRigs(states: { bodyMeshId: string; params: HairParams; renderStyle?: RenderStyle }[] | undefined): void { this._character.restoreHairRigs(states); }

    /**
     * Bake a body's garment (a slot) to GLB and register it as a kitbash part so it can be swapped
     * onto any character. v1 = a session-local object URL (the GLB bytes aren't yet written to disk —
     * full library persistence is a follow-up). Returns the new part id, or null.
     */
    bakeClothingToPart(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants', name: string): string | null {
        const clothingMeshId = this._character.getClothingMeshId(bodyMeshId, slot);
        if (!clothingMeshId) return null;
        const mesh = this.getMesh(clothingMeshId);
        const body = this.getMesh(bodyMeshId);
        if (!mesh || !(body instanceof SkinnedMesh3D) || !body.skeleton) return null;
        const result = exportSceneToGlb([mesh], [body.skeleton]);
        const bakeSlot = slot === 'undershirt' ? 'top' : slot === 'underpants' ? 'bottom' : slot;   // base layers bake as their outer-slot equivalent
        return this._registerBakedPart('part_' + _nanoid(), bakeSlot, name || (slot.charAt(0).toUpperCase() + slot.slice(1)), result.blob);
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
        const hairMeshId = this._character.getHairMeshId(bodyMeshId);
        if (!hairMeshId) return null;
        const mesh = this.getMesh(hairMeshId);
        const body = this.getMesh(bodyMeshId);
        if (!mesh || !(body instanceof SkinnedMesh3D) || !body.skeleton) return null;
        const result = exportSceneToGlb([mesh], [body.skeleton]);
        return this._registerBakedPart('part_' + _nanoid(), 'hair', name || 'Hair', result.blob);
    }

    seedGarmentPaintTexture(meshId: string, mgr: RasterTextureManager): boolean { return this._character.seedGarmentPaintTexture(meshId, mgr); }
    async retintGarmentPaint(mgr: RasterTextureManager, from: ClothingParams, to: ClothingParams): Promise<boolean> { return this._character.retintGarmentPaint(mgr, from, to); }

    /**
     * Live GHOST preview of a procedural body — call on every param/slider change to show a
     * translucent hologram that updates instantly, BEFORE committing with createProceduralBody3D.
     * Reuses GhostPreviewRenderer (no scene node, no undo/selection churn). Rest-pose geometry
     * (no skinning needed for a preview). Clear with clearProceduralBodyPreview().
     */
    async previewProceduralBody3D(params?: Partial<import('./body-generator').BodyParams>): Promise<void> {
        const { generateBodyResult, BODY_POSES } = await import('./body-generator');
        const result = generateBodyResult(params);
        const geom = result.geometry, skin = result.skinning;
        // Build a THROWAWAY skeleton (not in the scene) so we can pose + idle the ghost. Same joint data the
        // real body uses, so the ghost stands exactly like the character that spawns.
        const joints: Joint3D[] = [];
        for (let ji = 0; ji < skin.jointNames.length; ji++) {
            const t = skin.jointLocalPositions.subarray(ji * 3, ji * 3 + 3);
            const q = skin.jointLocalRotations.subarray(ji * 4, ji * 4 + 4);
            const s = skin.jointLocalScales.subarray(ji * 3, ji * 3 + 3);
            joints.push({
                index: ji, name: skin.jointNames[ji], parentIndex: skin.jointParents[ji], children: [],
                localPosition: [t[0], t[1], t[2]], localRotation: [q[0], q[1], q[2], q[3]], localScale: [s[0], s[1], s[2]],
                tailOffset: [0, 0.3, 0], worldMatrix: new Float32Array(16),
                inverseBindMatrix: new Float32Array(skin.inverseBindMatrices.subarray(ji * 16, ji * 16 + 16)),
            });
        }
        for (const j of joints) if (j.parentIndex >= 0 && joints[j.parentIndex]) joints[j.parentIndex].children.push(j.index);
        const skel = new Skeleton3D({ name: 'ghost', joints });
        // Pose to Relaxed (arms down — match the spawned character, not the T-pose).
        const byName = new Map(joints.map(j => [j.name, j]));
        for (const { joint, q } of (BODY_POSES['Relaxed'] ?? [])) { const j = byName.get(joint); if (j) j.localRotation = [...q] as [number, number, number, number]; }
        // Idle base = the Relaxed rotations of the idle-driven joints (so _applyIdle layers breathing on top).
        const base = new Map<string, [number, number, number, number]>();
        for (const name of Scene3DManager._IDLE_JOINTS) { const j = byName.get(name); if (j) base.set(name, [...j.localRotation] as [number, number, number, number]); }
        this._ghostIdle = {
            skel, base, indices: geom.indices, ji: skin.jointIndices, jw: skin.jointWeights,
            rest: new Float32Array(geom.vertices), out: new Float32Array(geom.vertices.length),
            t0: this._ghostIdle?.t0 ?? performance.now(),   // preserve phase across live slider rebuilds
        };
        this._ensureGhostIdleCallback();
        if (!this._ghostHeldLive && !this.ctx.webgpuRenderer.isLive) { this.ctx.webgpuRenderer.play(); this._ghostHeldLive = true; }
        this._tickGhostIdle();   // skin one frame now so it shows immediately
        this.ctx.scheduleRender();
    }

    /** Hide the procedural-body ghost preview. */
    clearProceduralBodyPreview(): void {
        this._ghostIdle = null;
        if (this._ghostHeldLive) { this.ctx.webgpuRenderer.pause(); this._ghostHeldLive = false; }
        this.renderer3D.setGhostPreviewData(null);
        this.ctx.scheduleRender();
    }

    // ── Animated ghost (the preview breathes/sways in the Relaxed stance instead of a static T-pose) ──
    private _ghostIdle: { skel: Skeleton3D; base: Map<string, [number, number, number, number]>; rest: Float32Array; out: Float32Array; indices: Uint32Array; ji: Uint8Array; jw: Float32Array; t0: number } | null = null;
    private _ghostIdleCallback: (() => boolean) | null = null;
    private _ghostHeldLive = false;
    // Spawn REVEAL (a POST-step, NOT a replacement for createProceduralBody3D): a frozen-Relaxed body ghost,
    // matched to the spawned character's transform + drawn on top, with a line that wipes it away top→bottom.
    private _ghostReveal: { verts: Float32Array; indices: Uint32Array; bodyMeshId: string; t0: number; dur: number; topY: number; bottomY: number } | null = null;

    private _ensureGhostIdleCallback(): void {
        if (!this._ghostIdleCallback) {
            this._ghostIdleCallback = () => {
                if (this._ghostReveal) { this._tickGhostReveal(); return this._ghostReveal !== null; }   // spawn wipe
                if (this._ghostIdle)   { this._tickGhostIdle();   return true; }                          // breathing preview
                return false;
            };
        }
        this.ctx.webgpuRenderer.addPreRenderCallback(this._ghostIdleCallback);
    }

    /** Pose the throwaway skeleton (Relaxed + one idle frame), re-FK, CPU-skin the rest verts, push to the ghost. */
    private _tickGhostIdle(): void {
        const g = this._ghostIdle;
        if (!g) return;
        this._applyIdle(g.skel, { intensity: 1, base: g.base, legMode: 'none' }, (performance.now() - g.t0) / 1000);   // preview: breathing only
        g.skel.computeWorldMatrices();
        this._skinGhostVerts(g.rest, g.ji, g.jw, g.skel.skinMatrices, g.out);
        // Place the ghost's ORIGIN (feet) at the camera's look-at point — the spawned character stands
        // feet-at-origin and the look-at sits at origin too, so both read feet-at-centre and line up.
        const t = this.getCamera().target;
        this.renderer3D.setGhostPreviewData({
            vertices: g.out, indices: g.indices,
            instances: [{ x: t[0], y: t[1], z: t[2], rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }], alpha: 0.55,
        });
    }

    /** CPU linear-blend skinning: deform the 12-float-stride rest verts (pos+normal) by the skeleton's
     *  skinMatrices (column-major) weighted over 4 joints. UV + tangent copied through unchanged. */
    private _skinGhostVerts(rest: Float32Array, ji: Uint8Array, jw: Float32Array, skin: Float32Array, out: Float32Array): void {
        const STRIDE = 12;
        const vcount = (rest.length / STRIDE) | 0;
        for (let v = 0; v < vcount; v++) {
            const o = v * STRIDE, wi = v * 4;
            const px = rest[o], py = rest[o + 1], pz = rest[o + 2];
            const nx = rest[o + 3], ny = rest[o + 4], nz = rest[o + 5];
            let ox = 0, oy = 0, oz = 0, onx = 0, ony = 0, onz = 0;
            for (let k = 0; k < 4; k++) {
                const w = jw[wi + k];
                if (w === 0) continue;
                const m = ji[wi + k] * 16;   // column-major mat4
                const a = skin[m], b = skin[m + 1], c = skin[m + 2];
                const e = skin[m + 4], f = skin[m + 5], gg = skin[m + 6];
                const h = skin[m + 8], i2 = skin[m + 9], j2 = skin[m + 10];
                const tx = skin[m + 12], ty = skin[m + 13], tz = skin[m + 14];
                ox += w * (a * px + e * py + h * pz + tx);
                oy += w * (b * px + f * py + i2 * pz + ty);
                oz += w * (c * px + gg * py + j2 * pz + tz);
                onx += w * (a * nx + e * ny + h * nz);
                ony += w * (b * nx + f * ny + i2 * nz);
                onz += w * (c * nx + gg * ny + j2 * nz);
            }
            out[o] = ox; out[o + 1] = oy; out[o + 2] = oz;
            const nl = Math.hypot(onx, ony, onz) || 1;
            out[o + 3] = onx / nl; out[o + 4] = ony / nl; out[o + 5] = onz / nl;
            out[o + 6] = rest[o + 6]; out[o + 7] = rest[o + 7]; out[o + 8] = rest[o + 8];
            out[o + 9] = rest[o + 9]; out[o + 10] = rest[o + 10]; out[o + 11] = rest[o + 11];
        }
    }

    /** Sweep the reveal line top→bottom; the ghost rides the body's live transform (so it spins WITH it). */
    private _tickGhostReveal(): void {
        const g = this._ghostReveal;
        if (!g) return;
        const body = this.getMesh(g.bodyMeshId);
        if (!(body instanceof SkinnedMesh3D)) { this._ghostReveal = null; this.renderer3D.setGhostPreviewData(null); return; }
        const p = Math.min(1, (performance.now() - g.t0) / g.dur);
        const revealY = g.topY + (g.bottomY - g.topY) * p;   // top → bottom (Y-spin preserves Y, so this holds)
        this.renderer3D.setGhostPreviewData({
            vertices: g.verts, indices: g.indices,
            instances: [{ x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, matrix: body.localMatrix as unknown as Float32Array }],
            alpha: 0.6, revealY, onTop: true,
        });
        if (p >= 1) { this._ghostReveal = null; this.renderer3D.setGhostPreviewData(null); }
    }

    /**
     * SPAWN REVEAL — a POST-STEP (call AFTER your full character is assembled + scaled, like playSpawnSpin). It
     * overlays a Relaxed body ghost matched to the character's transform and on top, then sweeps a bright line
     * top→bottom that "develops" the character out of the hologram, while it spins in. Non-disruptive: takes a
     * body mesh id, never touches your Generate flow. (v1: the ghost is body-shaped; loose hair pops in.)
     */
    async playSpawnReveal(bodyMeshId: string, opts?: { turns?: number; durationSec?: number }): Promise<void> {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D)) return;
        const { generateBodyResult, BODY_POSES } = await import('./body-generator');
        const result = generateBodyResult(this.getBodyParams(bodyMeshId) ?? undefined);
        const geom = result.geometry, skin = result.skinning;
        // Throwaway Relaxed skeleton → CPU-skin the rest verts once (model space; the body's matrix places them).
        const joints: Joint3D[] = [];
        for (let ji = 0; ji < skin.jointNames.length; ji++) {
            const t = skin.jointLocalPositions.subarray(ji * 3, ji * 3 + 3);
            const q = skin.jointLocalRotations.subarray(ji * 4, ji * 4 + 4);
            const s = skin.jointLocalScales.subarray(ji * 3, ji * 3 + 3);
            joints.push({
                index: ji, name: skin.jointNames[ji], parentIndex: skin.jointParents[ji], children: [],
                localPosition: [t[0], t[1], t[2]], localRotation: [q[0], q[1], q[2], q[3]], localScale: [s[0], s[1], s[2]],
                tailOffset: [0, 0.3, 0], worldMatrix: new Float32Array(16),
                inverseBindMatrix: new Float32Array(skin.inverseBindMatrices.subarray(ji * 16, ji * 16 + 16)),
            });
        }
        for (const j of joints) if (j.parentIndex >= 0 && joints[j.parentIndex]) joints[j.parentIndex].children.push(j.index);
        const skel = new Skeleton3D({ name: 'ghostReveal', joints });
        const byName = new Map(joints.map(j => [j.name, j]));
        for (const { joint, q } of (BODY_POSES['Relaxed'] ?? [])) { const j = byName.get(joint); if (j) j.localRotation = [...q] as [number, number, number, number]; }
        skel.computeWorldMatrices();
        const verts = new Float32Array(geom.vertices.length);
        this._skinGhostVerts(new Float32Array(geom.vertices), skin.jointIndices, skin.jointWeights, skel.skinMatrices, verts);
        // WORLD-Y extent of the ghost under the body's transform (compute once — the Y-spin won't change it).
        const lm = body.localMatrix as unknown as Float32Array;
        let mn = Infinity, mx = -Infinity;
        for (let v = 0; v < verts.length; v += 12) {
            const wy = lm[1] * verts[v] + lm[5] * verts[v + 1] + lm[9] * verts[v + 2] + lm[13];   // col-major row 1
            if (wy < mn) mn = wy; if (wy > mx) mx = wy;
        }
        // The LINE sweep is intentionally quicker (0.9s) than the SPIN (1.2s) — the character is fully revealed,
        // then keeps spinning to a stop. (Both honour opts.durationSec if the host passes it.)
        this._ghostReveal = { verts, indices: geom.indices, bodyMeshId, t0: performance.now(), dur: (opts?.durationSec ?? 0.9) * 1000, topY: mx, bottomY: mn };
        this._ensureGhostIdleCallback();
        this.playSpawnSpin(bodyMeshId, opts);   // spins the character (default 1.2s) + drives the render loop for the reveal
        this.ctx.scheduleRender();
    }

    // ── Spawn spin (the character spins in + decelerates to face front on Generate) ──
    private _spawnSpins = new Map<string, { t0: number; dur: number; startAngle: number; baseRx: number; baseRy: number; baseRz: number }>();
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
            if (m) {
                m.parent?.removeChild(m); this._modelStore.delete(meshId);
                // Free picker BVH + renderer per-mesh caches (incl. skinned GPU buffers) — was leaking on every
                // kitbash character delete.
                this._picker.evictMesh(meshId); this.renderer3D.evictMeshCaches([meshId]);
            }
        }
        const skel = this.getSkeleton(charData.skeletonId);
        if (skel) skel.parent?.removeChild(skel);
    }

    // ── Grease Pencil 3D (Phase C) ────────────────────────────────────

    /** Create a new GpObject3D in the scene and return its ID. */
    createGpObject(name = 'GP Object', skeletonId?: string): string {
        return this._gp.createObject(name, skeletonId);
    }

    /** Remove a GpObject3D from the scene. */
    removeGpObject(gpId: string): void {
        this._gp.removeObject(gpId);
    }

    getGpObject(gpId: string): GpObject3D | null {
        return this._gp.get(gpId);
    }

    getAllGpObjects(): GpObject3D[] {
        return this._gp.getAll();
    }

    /** Add a layer to a GpObject3D. Returns the new layer ID. */
    addGpLayer(gpId: string, name = 'Layer'): string {
        return this._gp.addLayer(gpId, name);
    }

    /** Remove a layer from a GpObject3D. */
    removeGpLayer(gpId: string, layerId: string): void {
        this._gp.removeLayer(gpId, layerId);
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
        return this._gp.beginStroke(gpId, layerId, color, baseWidth, options);
    }

    /** Add a point to the currently active GP stroke. */
    addGpPoint(x: number, y: number, z: number, pressure = 1, opacity = 1): void {
        this._gp.addPoint(x, y, z, pressure, opacity);
    }

    /** Finalize the active GP stroke. Strokes with < 2 points are discarded. */
    endGpStroke(): void {
        this._gp.endStroke();
    }

    /**
     * Erase GP strokes within `radius` world units of `worldPos` on a layer.
     * Pass `frame` to erase from a keyframe instead of base strokes.
     */
    eraseGpStrokes(gpId: string, layerId: string, worldPos: [number, number, number], radius: number, frame?: number): void {
        this._gp.eraseStrokes(gpId, layerId, worldPos, radius, frame);
    }

    /** Snapshot the current base strokes of a layer as a keyframe. */
    setGpKeyframe(gpId: string, layerId: string, frame: number): void {
        this._gp.setKeyframe(gpId, layerId, frame);
    }

    /** Remove the keyframe snapshot at frame N for a layer. */
    clearGpKeyframe(gpId: string, layerId: string, frame: number): void {
        this._gp.clearKeyframe(gpId, layerId, frame);
    }

    /** Set draw order for a GP object within the GP pass. 0 = default; negative = background. */
    setGpRenderOrder(gpId: string, order: number): void {
        this._gp.setRenderOrder(gpId, order);
    }

    /** List all GP objects as plain descriptors (safe to pass to Frogmarks). */
    getAllGpObjectDescriptors(): { id: string; name: string; skeletonId?: string }[] {
        return this._gp.getAllDescriptors();
    }

    /** List all layers for a GP object. */
    getGpLayers(gpId: string): { id: string; name: string; visible: boolean; opacity: number }[] {
        return this._gp.getLayers(gpId);
    }

    /** Show or hide a GP layer. */
    setGpLayerVisible(gpId: string, layerId: string, visible: boolean): void {
        this._gp.setLayerVisible(gpId, layerId, visible);
    }

    /** Set the opacity of a GP layer (0–1). */
    setGpLayerOpacity(gpId: string, layerId: string, opacity: number): void {
        this._gp.setLayerOpacity(gpId, layerId, opacity);
    }

    /** Rename a GP object. */
    renameGpObject(gpId: string, name: string): void {
        this._gp.renameObject(gpId, name);
    }

    /** Rename a layer within a GP object. */
    renameGpLayer(gpId: string, layerId: string, name: string): void {
        this._gp.renameLayer(gpId, layerId, name);
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

        addZonelessListener(canvas, 'pointermove', onMove);
        addZonelessListener(canvas, 'pointerdown', onClick, { capture: true });
        this._gpFaceSelectCleanup = () => {
            removeZonelessListener(canvas, 'pointermove', onMove);
            removeZonelessListener(canvas, 'pointerdown', onClick, { capture: true } as any);
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
        if (!this._gp.has(gpId)) return;
        this._gpDrawGpId = gpId;
        this._gpDrawLayerId = layerId;
        this._gpDrawActive = true;
        if (opts) this._applyGpDrawOpts(opts);
        // Suppress transform gizmo and box-select so left-drag is free for drawing.
        this._gpDrawSavedGizmoMode = this._armature.getGizmoMode() ?? 'move';
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

    /** Public: map a 3D-canvas client point to a UV [0,1] on `meshId` (raycast + barycentric UV) — used by the
     *  decal STAMP tool (Mode B) to composite a decal image into the mesh's texture at the clicked surface point. */
    screenToMeshUV3D(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, meshId: string): { u: number; v: number } | null {
        return this._surfacePaint.screenToMeshUV3D(clientX, clientY, rect, meshId);
    }

    /**
     * Enter 3D surface-paint input for `meshId`: left-drag on the mesh in the viewport raycasts to a UV coord and
     * calls `handlers` (the UVPaintController's stroke API). Alt-drag (orbit) and middle/right (pan) pass through.
     */
    enterSurfacePaintInput(meshId: string, handlers: { begin: (u: number, v: number, p: number, s?: number) => void; move: (u: number, v: number, p: number, s?: number) => void; end: () => void; hover?: (uv: [number, number] | null) => void }): void {
        this._surfacePaint.enter(meshId, handlers);
    }

    /** Exit 3D surface-paint input. */
    exitSurfacePaintInput(): void {
        this._surfacePaint.exit();
    }

    /** Multi-mesh variant of {@link enterSurfacePaintInput}: raycast a SET of meshes (the box's panels) and
     *  paint whichever is hit. The panel ids are resolved per-event so a hierarchy rebuild (setDimensions) is safe. */
    enterSurfacePaintInputMulti(meshIds: string[], handlers: { begin: (u: number, v: number, p: number, s?: number) => void; move: (u: number, v: number, p: number, s?: number) => void; end: () => void; hover?: (uv: [number, number] | null) => void }): void {
        this._surfacePaint.enterMulti(meshIds, handlers);
    }

    // ── Surface-pinned charm placement (click a garment to drop a loop/charm exactly there) ──────────
    /** The meshes a surface-pin can land on: the body + its garments (skinned to the same skeleton), NOT the
     *  charms/hair/face. Picking the closest gives the OUTERMOST surface (the garment over bare skin). */
    private _surfacePinTargets(body: SkinnedMesh3D): Mesh3D[] {
        const skelId = body.skeletonId;
        return this.getAllMeshes().filter(m =>
            m.visible && m instanceof SkinnedMesh3D && m.skeletonId === skelId &&
            !m.isAttachment && !m.isHair && !m.isFaceDecal);
    }

    /** Resolve a raycast hit on the body/garment to a SURFACE PIN: the hit's DOMINANT skin joint + the offset from
     *  that joint's rest position to the hit point (in body-local). A charm anchored there rides the same body region
     *  as the surface it was dropped on — no xyz fiddling. Returns null if the hit isn't a skinned body/garment. */
    private _resolvePinFromHit(bodyMeshId: string, hit: { mesh: Mesh3D; triangleIndex: number; baryU: number; baryV: number; hitPoint: [number, number, number] }): { joint: string; offset: [number, number, number] } | null {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return null;
        const hm = hit.mesh;
        if (!(hm instanceof SkinnedMesh3D) || !hm.geometry || hm.jointIndices.length === 0) return null;
        const fit = this._character.buildBodyFit(body); if (!fit) return null;
        const ji = hm.jointIndices, jw = hm.jointWeights, geom = hm.geometry;
        const tri3 = hit.triangleIndex * 3;
        const v = [geom.indices[tri3], geom.indices[tri3 + 1], geom.indices[tri3 + 2]];
        const bw = [1 - hit.baryU - hit.baryV, hit.baryU, hit.baryV];
        const acc = new Map<number, number>();                       // dominant joint = bary-weighted sum of skin weights
        for (let k = 0; k < 3; k++) for (let s = 0; s < 4; s++) {
            const w = jw[v[k] * 4 + s]; if (w > 0) { const j = ji[v[k] * 4 + s]; acc.set(j, (acc.get(j) ?? 0) + bw[k] * w); }
        }
        let bestJ = -1, bestW = -1; acc.forEach((w, j) => { if (w > bestW) { bestW = w; bestJ = j; } });
        const jointName = bestJ >= 0 ? body.skeleton.data.joints[bestJ]?.name : undefined;
        const jp = jointName ? fit.joints[jointName]?.pos : undefined;
        if (!jointName || !jp) return null;
        // `hit.hitPoint` is WORLD; `fit.joints[].pos` (and the generator) work in the body's LOCAL space. Convert the
        // hit into body-local so the offset lands the charm exactly where the user tapped (regardless of body transform).
        const invLm = mat4.invert(mat4.create(), body.localMatrix as unknown as mat4);
        const lh = invLm ? vec3.transformMat4(vec3.create(), vec3.fromValues(hit.hitPoint[0], hit.hitPoint[1], hit.hitPoint[2]), invLm)
                         : vec3.fromValues(hit.hitPoint[0], hit.hitPoint[1], hit.hitPoint[2]);
        return { joint: jointName, offset: [lh[0] - jp[0], lh[1] - jp[1], lh[2] - jp[2]] };
    }

    /** Surface-pin a `type` charm at a raycast hit (its dominant joint + offset) → it rides that body region. */
    private _placeAttachmentFromHit(bodyMeshId: string, type: AttachmentType, hit: { mesh: Mesh3D; triangleIndex: number; baryU: number; baryV: number; hitPoint: [number, number, number] }, params?: AttachmentParams): string | null {
        const pin = this._resolvePinFromHit(bodyMeshId, hit);
        if (!pin) return null;
        return this.addAttachment(bodyMeshId, type, { joint: pin.joint, offset: pin.offset, scale: 1 }, params ?? defaultAttachmentParams(type));
    }

    /** Enter "click a garment/body to drop a charm there" mode. Each left-click surface-pins a new `type` charm at
     *  the tapped point (resolved to the surface's dominant joint + offset → it follows that region). Alt/right pass
     *  through (orbit/pan); a click that misses the body passes through too. Stays active (drop several) until
     *  `endAttachmentPlacePick`. `onPlaced(id)` fires per drop; `onHover(world|null)` tracks the cursor for a preview.
     *  NOTE: pin in the NEUTRAL/rest pose — picking is against the rest geometry, so a posed body mis-aligns. */
    beginAttachmentPlacePick(bodyMeshId: string, type: AttachmentType, opts?: { params?: AttachmentParams; onPlaced?: (id: string) => void; onHover?: (world: [number, number, number] | null) => void }): void {
        this.endAttachmentPlacePick();
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;
        const pickAt = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            const px = (e.clientX - rect.left) * (canvas.width / rect.width);
            const py = (e.clientY - rect.top) * (canvas.height / rect.height);
            return this._picker.pickMesh(px, py, canvas.width, canvas.height, this.renderer3D.getCamera(), this._surfacePinTargets(body));
        };
        const onDown = (e: PointerEvent) => {
            if (e.button !== 0 || e.altKey) return;                  // alt = orbit; let it through
            const hit = pickAt(e);
            if (!hit) return;                                        // missed the body → pass through (orbit/select)
            e.stopImmediatePropagation(); e.preventDefault();
            const id = this._placeAttachmentFromHit(bodyMeshId, type, hit, opts?.params);
            if (id) opts?.onPlaced?.(id);
        };
        const onMove = opts?.onHover ? (e: PointerEvent) => { const hit = pickAt(e); opts.onHover!(hit ? hit.hitPoint : null); } : null;
        addZonelessListener(canvas, 'pointerdown', onDown, { capture: true });
        if (onMove) addZonelessListener(canvas, 'pointermove', onMove, { capture: true });
        this._placePickCleanup = () => {
            removeZonelessListener(canvas, 'pointerdown', onDown, { capture: true } as any);
            if (onMove) removeZonelessListener(canvas, 'pointermove', onMove, { capture: true } as any);
        };
    }

    /** Exit surface-pin placement mode. */
    endAttachmentPlacePick(): void {
        this._placePickCleanup?.();
        this._placePickCleanup = undefined;
    }

    // ── Charm GHOST PREVIEW (a translucent charm at the pending placement; follows the cursor; "Add" commits it) ──
    private _attachmentPreview: { bodyMeshId: string; type: AttachmentType; params: AttachmentParams; placement: AttachmentPlacement; meshId: string } | null = null;
    private _previewHoverCleanup: (() => void) | null = null;

    /** Build the translucent GHOST mesh for a pending charm at `placement` — skinned 100% to the anchor joint (a
     *  STATIC preview; no spring rig is appended to the skeleton). Returns the mesh id, or null. */
    private _buildPreviewMesh(bodyMeshId: string, type: AttachmentType, params: AttachmentParams, placement: AttachmentPlacement): string | null {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return null;
        const fit = this._character.buildBodyFit(body); if (!fit) return null;
        if (fit.head) fit.eyeY = this._eyeYForBody(bodyMeshId, fit.head);   // exact eye-line Y so preview glasses track the V-pos slider
        if (type === 'chain' || type === 'pendant') fit.drapeSurface = this._character.chainDrapeSurface(bodyMeshId);   // preview chains + pendants draped on the garment too
        const result = generateAttachment(fit, placement, params);
        if (!result) return null;
        const anchorIdx = body.skeleton.data.joints.findIndex(j => j.name === placement.joint);
        if (anchorIdx < 0) return null;
        const vc = result.jointWeights.length / 4;
        const ji = new Uint8Array(vc * 4), jw = new Float32Array(vc * 4);
        for (let i = 0; i < vc; i++) { ji[i * 4] = anchorIdx; jw[i * 4] = 1; }   // every vert → the anchor joint (static ghost)
        const mesh = new SkinnedMesh3D(this.ctx.interactionService, body.x, body.y, body.z, { primitive: 'custom', geometry: result.geometry });
        mesh.name = 'CharmPreview'; mesh.isAttachment = true; mesh.visible = true; mesh.transformViaSkeleton = true;
        mesh.skeletonId = body.skeletonId; mesh.skeleton = body.skeleton;
        mesh.jointIndices = ji; mesh.jointWeights = jw; mesh.skinDirty = true;
        mesh.material.doubleSided = true;
        const col = hexToRgb01(params.color); mesh.setDiffuseColor(col.r, col.g, col.b, 1);
        const mat = attachmentMaterial(params); mesh.material.metalness = mat.metalness; mesh.material.roughness = mat.roughness;
        mesh.material.opacity = 0.5;   // ← the ghost (Material3D opacity < 1 → transparent pass)
        mesh.gpuDirty = true;
        this.ctx.sceneGraph.root.addChild(mesh);
        return mesh.id;
    }

    /** Show a TRANSLUCENT GHOST of a charm at its default placement (or `placement`) and let it FOLLOW the cursor as
     *  you hover the body — so when a charm TYPE is selected (before "Add") the user sees exactly where it'll land
     *  (e.g. select Choker → ghost at the neck). `commitAttachmentPreview()` spawns it; `hideAttachmentPreview()` cancels. */
    showAttachmentPreview(bodyMeshId: string, type: AttachmentType, params?: AttachmentParams, placement?: AttachmentPlacement): void {
        this.hideAttachmentPreview();
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const p = params ?? defaultAttachmentParams(type);
        const place = placement ?? defaultAttachmentPlacement(type);
        const meshId = this._buildPreviewMesh(bodyMeshId, type, p, place);
        if (!meshId) return;
        this._attachmentPreview = { bodyMeshId, type, params: p, placement: place, meshId };
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (canvas) {
            const onMove = (e: PointerEvent) => {
                if (e.altKey || e.buttons) return;   // don't track while orbiting / dragging
                const rect = canvas.getBoundingClientRect();
                const px = (e.clientX - rect.left) * (canvas.width / rect.width);
                const py = (e.clientY - rect.top) * (canvas.height / rect.height);
                const hit = this._picker.pickMesh(px, py, canvas.width, canvas.height, this.renderer3D.getCamera(), this._surfacePinTargets(body));
                if (!hit) return;                    // off the body → leave the ghost at its last spot
                const pin = this._resolvePinFromHit(bodyMeshId, hit);
                const pv = this._attachmentPreview;
                if (pin && pv) { pv.placement = { ...pv.placement, joint: pin.joint, offset: pin.offset }; this._refreshPreviewMesh(); }
            };
            addZonelessListener(canvas, 'pointermove', onMove);
            this._previewHoverCleanup = () => removeZonelessListener(canvas, 'pointermove', onMove);
        }
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    private _refreshPreviewMesh(): void {
        const pv = this._attachmentPreview; if (!pv) return;
        const old = this.getMesh(pv.meshId); old?.parent?.removeChild(old);
        const meshId = this._buildPreviewMesh(pv.bodyMeshId, pv.type, pv.params, pv.placement);
        if (meshId) pv.meshId = meshId; else this._attachmentPreview = null;
        this.ctx.emitSceneGraphChanged(); this.ctx.scheduleRender();
    }

    /** Live-update the pending ghost (the user tweaks colour/size, or switches type, before Add). */
    updateAttachmentPreview(params?: Partial<AttachmentParams>, type?: AttachmentType): void {
        const pv = this._attachmentPreview; if (!pv) return;
        if (type && type !== pv.type) { pv.type = type; pv.placement = defaultAttachmentPlacement(type); pv.params = { ...defaultAttachmentParams(type), ...(params ?? {}) }; }
        else if (params) pv.params = { ...pv.params, ...params } as AttachmentParams;
        this._refreshPreviewMesh();
    }

    /** Spawn the real charm at the ghost's CURRENT placement (the "Add" action), remove the ghost, return the id. */
    commitAttachmentPreview(): string | null {
        const pv = this._attachmentPreview; if (!pv) return null;
        const { bodyMeshId, type, params, placement } = pv;
        this.hideAttachmentPreview();
        return this.addAttachment(bodyMeshId, type, placement, params);
    }

    /** Remove the charm ghost + stop the hover tracking (cancel, or after a commit). */
    hideAttachmentPreview(): void {
        this._previewHoverCleanup?.(); this._previewHoverCleanup = null;
        const pv = this._attachmentPreview;
        if (pv) {
            const m = this.getMesh(pv.meshId); m?.parent?.removeChild(m);
            this._attachmentPreview = null;
            this.ctx.emitSceneGraphChanged(); this.ctx.scheduleRender();
        }
    }

    /** Enter "click two points to string a chain between them" mode — NO hoops, NO xyz offsets. Click point A then
     *  point B on ANY garment/body; each is surface-pinned to the tapped surface's dominant joint, and a swag chain
     *  is strung A→B (the generator drapes it onto the equipped garment so it rests on the cloth). Stays active for
     *  more chains until `endAttachmentPlacePick`. `onProgress('first'|'second')` drives a "click start / click end"
     *  prompt; `onHover` previews the cursor. Pin in the NEUTRAL pose (picking is against the rest geometry). */
    beginChainPick(bodyMeshId: string, opts?: { params?: AttachmentParams; onPlaced?: (id: string) => void; onProgress?: (phase: 'first' | 'second') => void; onHover?: (world: [number, number, number] | null) => void }): void {
        this.endAttachmentPlacePick();
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.skeleton) return;
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;
        let pinA: { joint: string; offset: [number, number, number] } | null = null;   // the pending first endpoint
        const pickAt = (e: PointerEvent) => {
            const rect = canvas.getBoundingClientRect();
            const px = (e.clientX - rect.left) * (canvas.width / rect.width);
            const py = (e.clientY - rect.top) * (canvas.height / rect.height);
            return this._picker.pickMesh(px, py, canvas.width, canvas.height, this.renderer3D.getCamera(), this._surfacePinTargets(body));
        };
        const onDown = (e: PointerEvent) => {
            if (e.button !== 0 || e.altKey) return;                  // alt = orbit; let it through
            const hit = pickAt(e);
            if (!hit) return;                                        // missed the body → pass through
            const pin = this._resolvePinFromHit(bodyMeshId, hit);
            if (!pin) return;
            e.stopImmediatePropagation(); e.preventDefault();
            if (!pinA) { pinA = pin; opts?.onProgress?.('second'); return; }   // first click → remember the start
            const id = this.addAttachment(bodyMeshId, 'chain', { joint: pinA.joint, offset: pinA.offset, scale: 1 },
                { ...(opts?.params ?? defaultAttachmentParams('chain')), chainMode: 'swag', endJoint: pin.joint, endOffset: pin.offset });
            pinA = null; opts?.onProgress?.('first');
            if (id) opts?.onPlaced?.(id);
        };
        const onMove = opts?.onHover ? (e: PointerEvent) => { const hit = pickAt(e); opts.onHover!(hit ? hit.hitPoint : null); } : null;
        addZonelessListener(canvas, 'pointerdown', onDown, { capture: true });
        if (onMove) addZonelessListener(canvas, 'pointermove', onMove, { capture: true });
        opts?.onProgress?.('first');
        this._placePickCleanup = () => {
            removeZonelessListener(canvas, 'pointerdown', onDown, { capture: true } as any);
            if (onMove) removeZonelessListener(canvas, 'pointermove', onMove, { capture: true } as any);
        };
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

        addZonelessListener(canvas, 'pointerdown',  onPointerDown,  { capture: true });
        addZonelessListener(canvas, 'pointermove',  onPointerMove,  { capture: true });
        addZonelessListener(canvas, 'pointerup',    onPointerUp,    { capture: true });
        addZonelessListener(canvas, 'pointerleave', onPointerLeave);

        this._gpDrawListenerCleanup = () => {
            removeZonelessListener(canvas, 'pointerdown',  onPointerDown,  { capture: true });
            removeZonelessListener(canvas, 'pointermove',  onPointerMove,  { capture: true });
            removeZonelessListener(canvas, 'pointerup',    onPointerUp,    { capture: true });
            removeZonelessListener(canvas, 'pointerleave', onPointerLeave);
            canvas.style.cursor = '';
        };
    }

    // ── GP serialization ──────────────────────────────────────────────

    getScene3DGpStates(): any[] {
        return this._gp.toStates();
    }

    restoreGpStates(states: any[]): void {
        this._gp.restoreStates(states);
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
    showBoneOverlay3D(skeletonId: string | null, meshId?: string): void { return this._armature.showBoneOverlay3D(skeletonId, meshId); }

    // ── Armature focus mode helpers ──────────────────────────────────────────

    /**
     * Set the visual style for the armature focus mode background.
     * Default is 'wavy' (blue + cream animated wave pattern).
     * Call any time — takes effect on the next frame.
     */
    setArmatureBgMode3D(opts: import('../../types/armature-3d').ArmatureBgOptions): void { return this._armature.setArmatureBgMode3D(opts); }

    /**
     * Activate the armature focus background immediately — even before a skeleton exists.
     * Frogmarks calls this as soon as the Armature panel opens (on the mesh settings panel
     * 'Armature' button click), before the user has added any bones.
     * If `meshId` is provided the camera frames that mesh right away.
     * The background is deactivated automatically by showBoneOverlay3D(null).
     */
    enterArmatureMode3D(meshId?: string): void { return this._armature.enterArmatureMode3D(meshId); }

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

    /**
     * Hide all meshes except the given one — or, if it belongs to a procedural character, except the
     * WHOLE character (body + eye decal + hair + garments, which are separate sibling meshes sharing
     * one skeleton). Without the character expansion, entering armature mode would hide every part
     * except the one passed in, so the character appears to vanish (leaving only bones). Saves each
     * hidden mesh's previous visibility so clearMeshIsolation3D() can restore it exactly.
     */
    isolateMesh3D(meshId: string): void { return this._armature.isolateMesh3D(meshId); }

    /** Restore mesh visibility saved by isolateMesh3D. No-op if not isolated. */
    clearMeshIsolation3D(): void { return this._armature.clearMeshIsolation3D(); }

    /** The mesh ID currently isolated (visible alone), or null. */
    get isolatedMeshId3D(): string | null { return this._armature.isolatedMeshId3D; }

    // ── Joint picking ────────────────────────────────────────────────

    /** The index of the currently selected joint in the active bone overlay, or null. */
    getSelectedJointIndex(): number | null { return this._armature.getSelectedJointIndex(); }

    /** True if the current joint selection was made by clicking a tail sphere (vs a head sphere).
     *  Determines Add Bone semantics: tail → extend chain; head → branch from this point. */
    getSelectedJointIsTail(): boolean { return this._armature.getSelectedJointIsTail(); }

    /** The ID of the skeleton whose bone overlay is currently active, or null. */
    getBoneOverlaySkeletonId(): string | null { return this._armature.getBoneOverlaySkeletonId(); }

    /** Switch the active armature tool ('move' repositions joints; 'rotate' applies FK rotation). */
    setArmatureToolMode(mode: 'move' | 'rotate'): void { return this._armature.setArmatureToolMode(mode); }

    getArmatureToolMode(): 'move' | 'rotate' { return this._armature.getArmatureToolMode(); }

    /** Get the current local rotation quaternion [x,y,z,w] for a joint. */
    getJointRotation(skeletonId: string, jointIndex: number): [number,number,number,number] | null { return this._armature.getJointRotation(skeletonId, jointIndex); }

    /** Reset a single joint's local rotation to the identity quaternion [0,0,0,1]. */
    resetJointRotation(skeletonId: string, jointIndex: number): void { return this._armature.resetJointRotation(skeletonId, jointIndex); }

    /** Reset all joints in a skeleton to identity rotation. */
    resetAllJointRotations(skeletonId: string): void { return this._armature.resetAllJointRotations(skeletonId); }

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
    selectJoint(jointIndex: number | null): void { return this._armature.selectJoint(jointIndex); }

    /** Clear the active joint selection without clearing the bone overlay. */
    clearJointSelection(): void { return this._armature.clearJointSelection(); }

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
    extrudeJoint3D(skeletonId: string): void { return this._armature.extrudeJoint3D(skeletonId); }

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
    enterBonePlacementMode3D(skeletonId: string): void { return this._armature.enterBonePlacementMode3D(skeletonId); }

    /** Cancel bone placement mode without placing a joint. */
    exitBonePlacementMode3D(): void { return this._armature.exitBonePlacementMode3D(); }

    /** True while waiting for the user to click a placement point. */
    isBonePlacementModeActive3D(): boolean { return this._armature.isBonePlacementModeActive3D(); }

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
    ): { index: number; name: string; x: number; y: number }[] { return this._armature.getJointScreenPositions3D(skeletonId, canvasWidth, canvasHeight); }

    // ── Mesh Grouping ───────────────────────────────────────────────

    createMeshGroup(name = '3D Group'): MeshGroup3D { return this._grouping.createMeshGroup(name); }

    /** Delete a mesh group (and un-parent its children to root). Pushes an undo command. */
    deleteMeshGroup(groupId: string): boolean { return this._grouping.deleteMeshGroup(groupId); }

    getMeshGroup(groupId: string): MeshGroup3D | null { return this._grouping.getMeshGroup(groupId); }

    getMeshGroups(): MeshGroup3D[] { return this._grouping.getMeshGroups(); }

    /**
     * When clicking a mesh inside a MeshGroup3D, bubble selection up to the group:
     * expand the provided IDs to all Mesh3D siblings in the same group and return
     * the group's ID for outliner sync. Falls through unchanged for non-group meshes.
     */

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

    isArrayGroup3D(nodeId: string): boolean { return this._arrays.isArrayGroup3D(nodeId); }

    getArrayParams3D(groupId: string): ArrayParams | null { return this._arrays.getArrayParams3D(groupId); }

    getArraySourceId(groupId: string): string | null { return this._arrays.getArraySourceId(groupId); }

    /** Return the IDs of all ArrayGroup3D nodes that use `sourceId` as their source mesh. */
    getArrayGroupsForSource(sourceId: string): string[] { return this._arrays.getArrayGroupsForSource(sourceId); }

    /** Set a per-instance override for one slot in an array group. Pushes an undo entry. */
    setInstanceOverride(groupId: string, instanceIndex: number, override: InstanceOverride): void { this._arrays.setInstanceOverride(groupId, instanceIndex, override); }

    /** Remove a per-instance override, restoring the instance to source defaults. Pushes an undo entry. */
    clearInstanceOverride(groupId: string, instanceIndex: number): void { this._arrays.clearInstanceOverride(groupId, instanceIndex); }

    /** Return all instance overrides for an array group as a plain array for UI consumption. */
    getInstanceOverrides(groupId: string): Array<{ index: number; override: InstanceOverride }> { return this._arrays.getInstanceOverrides(groupId); }

    /** Private delegator kept for internal callers (bake, gizmo drag). See scene3d-arrays.ts. */
    private _getArrayGroup(groupId: string): ArrayGroup3D | null { return this._arrays.getGroup(groupId); }

    // ── Geometry Modifier Stack ────────────────────────────────────────────────
    // These operate on Mesh3D.modifiers (CPU geometry transforms applied before GPU upload).
    // Distinct from the EditMesh modifier stack (meshEdit.addMirrorModifier etc.) which only
    // works on edit-mode meshes and modifies the EditMesh topology in place.

    /** Append a geometry modifier to any Mesh3D's modifier stack. Pushes undo. */
    addGeomModifier(meshId: string, mod: Modifier): void { this._modifiers.add(meshId, mod); }

    /** Remove the geometry modifier at `index` from the mesh's stack. Pushes undo. */
    removeGeomModifier(meshId: string, index: number): void { this._modifiers.remove(meshId, index); }

    /** Merge `partial` fields into the geometry modifier at `index`. Pushes undo. */
    updateGeomModifier(meshId: string, index: number, partial: Partial<Modifier>): void { this._modifiers.update(meshId, index, partial); }

    /** Return a snapshot of the mesh's geometry modifier stack. */
    getGeomModifiers(meshId: string): Modifier[] { return this._modifiers.list(meshId); }

    /** Private delegator kept for the gizmo drag path (spacing/sibling sync). See scene3d-arrays.ts. */
    private _getGroupSiblingArrays(groupId: string): ArrayGroup3D[] { return this._arrays.getGroupSiblingArrays(groupId); }

    /**
     * Create a linear array from an existing mesh.
     * The source mesh stays in place; only generated copies are added to the ArrayGroup3D.
     */
    createLinearArray3D(sourceId: string, count = 3, spacing?: [number, number, number]): ArrayGroup3D {
        return this._arrays.createLinearArray3D(sourceId, count, spacing);
    }

    /**
     * Create a grid (NxM) array from an existing mesh.
     * The source stays in place; only generated copies belong to the ArrayGroup3D.
     */
    createGridArray3D(sourceId: string, countX = 2, spacingX?: [number, number, number], countY = 2, spacingY?: [number, number, number], diagonalOnly = false): ArrayGroup3D {
        return this._arrays.createGridArray3D(sourceId, countX, spacingX, countY, spacingY, diagonalOnly);
    }

    /**
     * Create a radial array from an existing mesh.
     * The source stays at its current position; `count` ring copies are placed around it.
     */
    createRadialArray3D(sourceId: string, count = 6, radius?: number, axis: 'x' | 'y' | 'z' = 'y', arcDeg = 360): ArrayGroup3D {
        return this._arrays.createRadialArray3D(sourceId, count, radius, axis, arcDeg);
    }

    /**
     * Live-update array parameters during gizmo drag or panel change.
     * Rebuilds copy positions and schedules a render — no undo step.
     */
    updateArrayParams3D(groupId: string, params: Partial<ArrayParams>): void { this._arrays.updateArrayParams3D(groupId, params); }

    /**
     * Convert an ArrayGroup3D to a plain MeshGroup3D with independent geometry per copy.
     * Creates new Mesh3D objects from the computed instance positions (GPU instancing model —
     * no Mesh3D copies exist until bake). Pushes an undo command.
     */
    bakeArray3D(groupId: string): MeshGroup3D | null { return this._arrayBake.bakeArray3D(groupId); }

    /**
     * Bake an ArrayGroup3D into a single unified Mesh3D (transform-to-world, optional gap-fill bridge boxes,
     * weld). The resulting mesh sits at the world origin. Pushes an undoable command. See scene3d-array-bake.ts.
     */
    bakeArrayMerged3D(groupId: string): Mesh3D | null { return this._arrayBake.bakeArrayMerged3D(groupId); }

    /**
     * Delete a mesh by node ID. Pushes an undo command.
     *
     * Memory note: the undo closure keeps the Mesh3D object (and its GPU vertex/index
     * buffers) alive until the command is evicted from the undo stack. This is
     * intentional — it enables undo without re-uploading geometry — but bounds GPU
     * memory retention to at most UndoManager3D.maxDepth (50) deleted meshes.
     */
    /**
     * All PART mesh IDs of the procedural character whose body is `bodyMeshId` — every non-body mesh skinned to
     * the SAME skeleton: hair, clothing (all slots), the face/eye decal, and attachments. The host uses this to
     * collapse a character to ONE "Character" outliner item (hide the parts) and to cascade-delete them with the
     * body. Excludes the body itself and the skeleton rig; returns [] if `bodyMeshId` isn't a procedural body.
     */
    getProceduralBodyParts(bodyMeshId: string): string[] {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.isProceduralBody) return [];
        const skelId = body.skeletonId ?? body.skeleton?.id ?? null;
        if (!skelId) return [];
        const ids: string[] = [];
        for (const m of this.getAllMeshes()) {
            if (m.id === bodyMeshId) continue;
            if (m instanceof SkinnedMesh3D && (m.skeletonId ?? m.skeleton?.id) === skelId) ids.push(m.id);
        }
        return ids;
    }

    /**
     * Fully delete a procedural CHARACTER: its body mesh, all part meshes (hair / clothing / face decal /
     * attachments), the skeleton rig, AND every piece of per-body state (params, arm/leg/torso surfaces,
     * hair / clothing / face / attachment rigs, idle-break / idle-rig / squash / spawn-spin animation state,
     * spring + skel-sync trackers). ONE undoable op — undo restores the whole character (captured value refs
     * keep the rig data alive in the closure). Returns false if `bodyMeshId` isn't a procedural body.
     * (Painted UV textures for the body + parts are dropped by the shape-manager wrapper `deleteProceduralBody3D`.)
     */
    deleteProceduralBody(bodyMeshId: string): boolean {
        const body = this.getMesh(bodyMeshId);
        if (!(body instanceof SkinnedMesh3D) || !body.isProceduralBody) return false;
        const root = this.ctx.sceneGraph.root;
        const partIds = this.getProceduralBodyParts(bodyMeshId);
        const skelId = body.skeletonId ?? body.skeleton?.id ?? null;
        const skel = skelId ? this.getSkeleton(skelId) : null;

        // Scene nodes to remove — parts, then the body, then the skeleton (so the body outlives its rig) — with
        // parents captured for undo.
        const nodes: { node: any; parent: any }[] = [];
        for (const id of partIds) { const m = this.getMesh(id); if (m) nodes.push({ node: m, parent: m.parent ?? root }); }
        nodes.push({ node: body, parent: body.parent ?? root });
        if (skel) nodes.push({ node: skel, parent: skel.parent ?? root });

        // Per-body state to drop. The captured value is held by the closure, so undo re-sets it intact.
        const drops: (() => void)[] = [], restores: (() => void)[] = [];
        const cap = (map: Map<string, any>, key: string) => {
            if (!map.has(key)) return;
            const v = map.get(key);
            drops.push(() => map.delete(key)); restores.push(() => map.set(key, v));
        };
        for (const m of [this._squashStretch, this._idleBreaks, this._idleRigs, this._spawnSpins,
                         this._legIdleModes] as Map<string, any>[])
            cap(m, bodyMeshId);
        cap(this._charSkelSyncVer, bodyMeshId);
        for (const id of partIds) cap(this._charSkelSyncVer, id);
        if (skelId) { cap(this._springActiveUntil as unknown as Map<string, any>, skelId); cap(this._nlaBindPoses as unknown as Map<string, any>, skelId); }
        // Overlay rigs (hair/clothing/attachments/body params + surfaces) live in the character subsystem now.
        const overlayDel = this._character.captureBodyOverlaysForDeletion(bodyMeshId);
        drops.push(overlayDel.drop); restores.push(overlayDel.restore);
        // Face rig: stop its blink timer on delete (don't fire on a removed decal); restart it on undo.
        const faceDel = this._character.prepareFaceRigDeletion(bodyMeshId);
        if (faceDel) { drops.push(faceDel.drop); restores.push(faceDel.restore); }

        const evictIds = [...partIds, bodyMeshId];   // mesh ids (not the skeleton) whose GPU/CPU caches to free
        const doDelete = () => {
            for (const { node } of nodes) node.parent?.removeChild(node);
            for (const d of drops) d();
            // Free the removed meshes' picker BVHs + renderer per-mesh caches incl. skinned GPU buffers (VRAM).
            // deleteProceduralBody never did this → every character create/delete cycle leaked GPU memory.
            // (Rebuilt lazily on the next render if undo restores the character.)
            for (const id of evictIds) this._picker.evictMesh(id);
            this.renderer3D.evictMeshCaches(evictIds);
            this.ctx.emitSceneGraphChanged(); this.ctx.scheduleRender();
        };
        const doRestore = () => {
            for (const { node, parent } of nodes) { parent.addChild(node); (node as any).gpuDirty = true; }
            for (const r of restores) r();
            this.ctx.emitSceneGraphChanged(); this.ctx.scheduleRender();
        };
        doDelete();
        this._undoManager.push({ description: 'Delete character', undo: doRestore, redo: doDelete });
        return true;
    }

    deleteMesh(nodeId: string): boolean {
        const mesh = this.getMesh(nodeId);
        if (!mesh) return false;
        // Deleting a camera drops any cuts that reference it (+ its transient fov). Snapshot the cuts so undo of the
        // delete brings them back with the camera.
        const cutsBefore = mesh.isCamera ? this._cameraCuts : null;
        if (mesh.isCamera) { this._cameraCuts = pruneCuts(this._cameraCuts, nodeId); this._animatedCamFov.delete(nodeId); this._cameraMarkerSprites.delete(nodeId); }   // marker sprite rides the camera subtree → removed with it
        const cutsAfter = this._cameraCuts;
        if (cutsBefore && cutsAfter !== cutsBefore) this.onCameraCutsChanged.emit();   // a camera delete dropped some cuts
        const savedParent = mesh.parent ?? this.ctx.sceneGraph.root;
        const evict = () => { this._picker.evictMesh(mesh.id); this.renderer3D.evictMeshCaches([mesh.id]); };
        mesh.parent?.removeChild(mesh);
        evict();   // free picker BVH + renderer per-mesh caches (incl. skinned GPU buffers); rebuilt on undo
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();

        this._undoManager.push({
            description: 'Delete mesh',
            undo: () => {
                savedParent.addChild(mesh);
                mesh.gpuDirty = true;
                if (cutsBefore) { this._cameraCuts = cutsBefore; this.onCameraCutsChanged.emit(); }
                this.ctx.emitSceneGraphChanged();
            },
            redo: () => {
                mesh.parent?.removeChild(mesh);
                evict();
                if (cutsBefore) { this._cameraCuts = cutsAfter; this.onCameraCutsChanged.emit(); }
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

        // Deep copy keyframe tracks and submeshes so they are independent (typed clones — a JSON
        // round-trip here serialized every track + submesh material per duplicate).
        copy.keyframeTracks = cloneKeyframeTracks(src.keyframeTracks);
        copy.submeshes = src.submeshes.map(cloneSubmesh3D);

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

    setMaterial(nodeId: string, material: Partial<Material3D>): void { this._materials.setMaterial(nodeId, material); }

    setDiffuseColor(nodeId: string, r: number, g: number, b: number, a = 1): void { this._materials.setDiffuseColor(nodeId, r, g, b, a); }

    setOpacity(nodeId: string, opacity: number): void { this._materials.setOpacity(nodeId, opacity); }

    setPrimitive(nodeId: string, primitive: MeshPrimitive, config?: Partial<Mesh3DConfig>): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setPrimitive(primitive, config); this.ctx.scheduleRender(); }
    }

    setGeometry(nodeId: string, geometry: MeshGeometry): void {
        const mesh = this.getMesh(nodeId);
        if (mesh) { mesh.setGeometry(geometry); this.ctx.scheduleRender(); }
    }

    // ── Textures ────────────────────────────────────────────────────

    async setMeshTexture(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> { return this._textures.setMeshTexture(nodeId, source); }

    /** Private delegator kept for the GLTF-import dispose paths (which free per-mesh textures). See scene3d-textures.ts. */
    private _destroyTextureIfUnshared(tex: GPUTexture | null | undefined, exceptMeshId?: string): void { this._textures.destroyTextureIfUnshared(tex, exceptMeshId); }

    clearMeshTexture(nodeId: string): boolean { return this._textures.clearMeshTexture(nodeId); }

    // ── Global Scene Settings (serializable snapshot) ────────────────

    getGlobalScene3DSettings(): GlobalScene3DSettings {
        const dl = this.renderer3D.lightConfig, al = this.renderer3D.ambientConfig;
        return {
            projection:    this._armature.illustrationProjection,
            ps1:           { ...this.renderer3D.ps1Config },
            lighting: {
                // DEEP-COPY (not the live config by reference, unlike the old code) — otherwise a later light edit
                // mutates a snapshot a caller still holds, so e.g. WorldManager's pre-city lighting snapshot would
                // get overwritten by the city look and "restore" would hand back the city lighting, not the original.
                directional: { direction: [dl.direction[0], dl.direction[1], dl.direction[2]], color: [dl.color[0], dl.color[1], dl.color[2]], intensity: dl.intensity },
                ambient:     { color: [al.color[0], al.color[1], al.color[2]], intensity: al.intensity },
            },
            bg:            { ...this.renderer3D.sceneBgOptions },
            fog:           { ...this.renderer3D.fogConfig },
            ibl:           { enabled: this.renderer3D.iblEnabled, intensity: this._envMapIntensity, specularIntensity: this.renderer3D.iblSpecularIntensity, ...(this._envMapDataUrl ? { image: this._envMapDataUrl } : {}) },
            sky:           this._environment.serialize().sky,   // deep-copied authorable sky preset (round-trips via normalize)
            iblSpecular:   this.renderer3D.iblSpecularEnabled,   // re-baked from sky+sun on restore (cube isn't serialized)
            reflections:   { ...this._environment.state.reflections },   // SSR params (P2)
            textureFilter: this.renderer3D.textureFilterMode,
            postProcess:   this.renderer3D.getPostProcessConfig(),
            ssao:          { ...this.renderer3D.ssaoConfig },
            wind:          { ...this.renderer3D.sceneWind },
            shadows: {
                enabled:    this.renderer3D.shadowsEnabled,
                mapSize:    this.renderer3D.shadowMapSize,
                halfExtent: this.renderer3D.shadowHalfExtent,
                bias:       this.renderer3D.shadowBias,
                strength:   this.renderer3D.shadowStrength,
                softness:   this.renderer3D.shadowSoftness,
            },
            snap: this.snapMode,
            snapGridSize:   this.snapGridSize,
            snapRotateStep: this.snapAngle,
            snapScaleStep:  this.snapScaleStep,
            grid: { visible: this._gridVisible, color: this.gridColor, opacity: this._gridOpacity },
            viewState: { ...this._viewState },
        };
    }

    restoreGlobalScene3DSettings(s: Partial<GlobalScene3DSettings>): void {
        if (s.projection !== undefined) {
            this._armature.illustrationProjection = s.projection;
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
        // Mirror the restored lighting/fog into the environment owner (no re-apply — the renderer was just set above).
        if (s.lighting?.directional) this._environment.recordSun(s.lighting.directional.direction, s.lighting.directional.color, s.lighting.directional.intensity);
        if (s.lighting?.ambient)     this._environment.recordAmbient(s.lighting.ambient.color, s.lighting.ambient.intensity);
        if (s.fog)                   this._environment.recordFog(s.fog);
        // Restore the authorable sky preset (the SH-diffuse baked look came back via `ibl.image`; this keeps the params
        // editable). Then, if crisp specular IBL was active, re-bake the prefiltered cube from the sky + restored sun
        // (the cube itself isn't serialized — it's cheap to recompute from params).
        if (s.sky)                   this._environment.setSky(s.sky);
        if (s.iblSpecular && s.sky) {
            const sd = this._environment.state.sun.direction;
            this.renderer3D.bakeSpecularIBL(this._environment.state.sky, [-sd[0], -sd[1], -sd[2]]);
        }
        if (s.ibl?.specularIntensity !== undefined) this.renderer3D.setIBLSpecularIntensity(s.ibl.specularIntensity);
        if (s.reflections) {
            // Restore the INTENT (on/off + artistic knobs) but NOT the ray-march tuning (maxSteps/stride/thickness):
            // tuning is engine-owned and has been re-tuned since older saves — persisted values from old builds
            // re-created banding/ghost artifacts on reload, silently overriding fixed defaults. Deliberately dropped.
            const r = s.reflections;
            this.setSSR3D({ ssr: r.ssr, ssrIntensity: r.ssrIntensity, ssrMaxRoughness: r.ssrMaxRoughness, cubemapRes: r.cubemapRes });
        }
        // IBL: re-apply via the PUBLIC env-map path (no private poke). Priority for the source image:
        //   1. a live cached ImageData from THIS session (e.g. a city-mode enter/exit round-trip) — upload immediately;
        //   2. else a serialized data URL from a reloaded document (§2.3) — decode async, then apply.
        // The old code set a private `_iblIntensity` that did nothing (iblEnabled stayed false).
        if (s.ibl) {
            this._envMapIntensity = s.ibl.intensity ?? 1.0;
            if (s.ibl.enabled) {
                if (this._envMapImage) this.renderer3D.setEnvironmentMap3D(this._envMapImage, this._envMapIntensity);
                else if (s.ibl.image) void this._restoreEnvMapFromDataUrl(s.ibl.image, this._envMapIntensity);
            } else {
                this.renderer3D.clearEnvironmentMap3D();
            }
        }
        if (s.textureFilter !== undefined) this.renderer3D.setTextureFilterMode(s.textureFilter);
        if (s.postProcess)  this.renderer3D.setPostProcessing(s.postProcess);
        if (s.ssao)         this.renderer3D.setSSAO(!!s.ssao.enabled, s.ssao);
        if (s.wind)         this.renderer3D.setSceneWind(s.wind);
        if (s.shadows) {
            if (s.shadows.enabled) {
                this.renderer3D.enableShadows(s.shadows.mapSize, s.shadows.halfExtent, s.shadows.bias);
            } else {
                this.renderer3D.disableShadows();
            }
            if (typeof s.shadows.strength === 'number') this.renderer3D.setShadowStrength(s.shadows.strength);
            if (typeof s.shadows.softness === 'number') this.renderer3D.setShadowSoftness(s.shadows.softness);
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
        if (s.viewState) {
            // Restore the target × camera mode (+ poses). normalizeViewState coerces legacy/partial blobs; older
            // saves have no viewState → left at the illustration/ortho2D default (loaded unchanged).
            this._viewState = normalizeViewState(s.viewState);
            this._applyViewState();
            this.onViewStateChanged.emit();
            void this._refreshArtboardTexture();   // capture the artboard texture if restored into illustration × free3D
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
        this._environment.recordSun([dx, dy, dz], [r, g, b], intensity);   // mirror into the environment owner (no behavior change)
        this.ctx.scheduleRender();
    }

    setAmbientLight(r: number, g: number, b: number, intensity = 1): void {
        this.renderer3D.setAmbientLight(r, g, b, intensity);
        this._environment.recordAmbient([r, g, b], intensity);
        this.ctx.scheduleRender();
    }

    setFog3D(config: Partial<FogConfig>): void { this.renderer3D.setFog(config); this._environment.recordFog(config); this.ctx.scheduleRender(); }
    getFog3D(): FogConfig { return { ...this.renderer3D.fogConfig }; }

    setSceneBg3D(opts: ArmatureBgOptions): void { this.renderer3D.setSceneBg(opts); this.ctx.scheduleRender(); }
    getSceneBg3D(): ArmatureBgOptions { return this.renderer3D.sceneBgOptions; }

    setTextureFilterMode3D(mode: 'nearest' | 'linear'): void { this.renderer3D.setTextureFilterMode(mode); this.ctx.scheduleRender(); }

    // Cached env-map source so a within-session global-settings restore can re-upload it (the renderer only keeps the
    // derived SH coeffs, not the image). `_envMapDataUrl` is the same image encoded once so it can ALSO be serialized
    // into the document (§2.3) and re-decoded after a fresh reload.
    private _envMapImage: ImageData | null = null;
    private _envMapDataUrl: string | null = null;
    private _envMapIntensity = 1.0;
    setEnvironmentMap3D(imageData: ImageData | null, intensity = 1.0): void {
        this._envMapImage = imageData; this._envMapIntensity = intensity;
        this._envMapDataUrl = imageData ? Scene3DManager._imageDataToDataUrl(imageData) : null;
        if (!imageData) { this.renderer3D.clearEnvironmentMap3D(); }
        else { this.renderer3D.setEnvironmentMap3D(imageData, intensity); }
        this.ctx.scheduleRender();
    }
    clearEnvironmentMap3D(): void { this._envMapImage = null; this._envMapDataUrl = null; this.renderer3D.clearEnvironmentMap3D(); this.renderer3D.clearSpecularIBL(); this.ctx.scheduleRender(); }

    // Snapshot of sun/ambient/IBL taken JUST BEFORE the first procedural-sky application this session, so
    // `resetSky3D()` is a TRUE undo back to the scene's pre-preset look (city keeps its city lighting, a character
    // scene keeps its key light) rather than a generic default. Null = no preset applied yet (or already reset).
    private _preSkyEnv: {
        sun: { direction: [number, number, number]; color: [number, number, number]; intensity: number };
        ambient: { color: [number, number, number]; intensity: number };
        iblEnabled: boolean; iblImage: ImageData | null; iblIntensity: number;
    } | null = null;

    /** Capture the pre-preset environment ONCE (idempotent). Call before any preset mutates sun/ambient/IBL. */
    private _captureEnvSnapshotIfNeeded(): void {
        if (this._preSkyEnv) return;
        const l = this.renderer3D.lightConfig, a = this.renderer3D.ambientConfig;
        this._preSkyEnv = {
            sun: { direction: [...l.direction], color: [...l.color], intensity: l.intensity },
            ambient: { color: [...a.color], intensity: a.intensity },
            iblEnabled: this.renderer3D.iblEnabled, iblImage: this._envMapImage, iblIntensity: this._envMapIntensity,
        };
    }

    /** Undo the procedural sky/preset: restore the sun/ambient/IBL captured before the first preset (a true undo to
     *  the scene's own look); if nothing was captured, fall back to the engine DEFAULT sun/ambient + IBL off. Also
     *  resets the sky params to the default preset. This is what a "Clear sky" / "Reset atmosphere" button calls. */
    resetSky3D(): void {
        const snap = this._preSkyEnv;
        if (snap) {
            this.setDirectionalLight(snap.sun.direction[0], snap.sun.direction[1], snap.sun.direction[2], snap.sun.color[0], snap.sun.color[1], snap.sun.color[2], snap.sun.intensity);
            this.setAmbientLight(snap.ambient.color[0], snap.ambient.color[1], snap.ambient.color[2], snap.ambient.intensity);
            if (snap.iblEnabled && snap.iblImage) this.setEnvironmentMap3D(snap.iblImage, snap.iblIntensity);
            else this.clearEnvironmentMap3D();
            this._preSkyEnv = null;
        } else {
            const d = DEFAULT_ENVIRONMENT;
            this.setDirectionalLight(d.sun.direction[0], d.sun.direction[1], d.sun.direction[2], d.sun.color[0], d.sun.color[1], d.sun.color[2], d.sun.intensity);
            this.setAmbientLight(d.ambient.color[0], d.ambient.color[1], d.ambient.color[2], d.ambient.intensity);
            this.clearEnvironmentMap3D();
        }
        this.renderer3D.clearSpecularIBL();   // presets baked a specular cube; the pre-preset look had none
        this._environment.setSky({ ...DEFAULT_SKY });
    }

    /** Bake the CURRENT procedural-sky preset (`environment3D.state.sky`) into BOTH IBL paths — the SH DIFFUSE ambient
     *  (via the env-map machinery, so it persists like an imported HDRI) AND the prefiltered SPECULAR cubemap (crisp,
     *  roughness-aware reflections, P1b). Both come from the one sky, so lighting + reflections stay coherent. The sun
     *  disk follows the directional light. Opt-in P1 (environment-and-reflections.md): NOTHING calls this
     *  automatically, so default scenes are unchanged until the host invokes it. */
    applyProceduralSkyIBL(intensity = 1.0): void {
        this._captureEnvSnapshotIfNeeded();
        const st = this._environment.state;
        const s = st.sun.direction;
        const sunDir: [number, number, number] = [-s[0], -s[1], -s[2]];   // light travels FROM the sun, so the sun is the opposite way
        const { width, height, data } = bakeSkyEquirect(st.sky, sunDir);
        const img = new ImageData(width, height);   // build then copy — avoids the ArrayBufferLike vs ArrayBuffer ctor mismatch
        img.data.set(data);
        this.setEnvironmentMap3D(img, intensity);        // SH diffuse — caches + persists + applies + schedules
        this.renderer3D.bakeSpecularIBL(st.sky, sunDir); // prefiltered specular cube (crisp reflections)
        this.ctx.scheduleRender();
    }

    /** Patch the procedural-sky preset and immediately re-bake it into IBL. */
    setSky3D(sky: Partial<SkyState>, intensity = 1.0): void {
        this._environment.setSky(sky);
        this.applyProceduralSkyIBL(intensity);
    }

    /** The current procedural-sky preset. */
    getSky3D(): SkyState { return { ...this._environment.state.sky }; }

    /** Balance reflections against ambient: `0` = no cubemap reflections (diffuse ambient unaffected), `1` = full.
     *  Independent of diffuse — no re-bake needed. */
    setIBLSpecularIntensity3D(v: number): void { this.renderer3D.setIBLSpecularIntensity(v); this.ctx.scheduleRender(); }
    /** Scale the DIFFUSE sky ambient independently of reflections. */
    setIBLDiffuseIntensity3D(v: number): void { this.renderer3D.setIBLDiffuseIntensity(v); this.ctx.scheduleRender(); }
    /** Current (diffuse, specular) IBL intensities — for initialising two sliders. */
    getIBLIntensities3D(): { diffuse: number; specular: number } { return { diffuse: this.renderer3D.iblDiffuseIntensity, specular: this.renderer3D.iblSpecularIntensity }; }
    /** Bake ONLY the specular cube from the current sky (leaves the diffuse SH ambient as-is). */
    bakeSpecularOnlyIBL(): void {
        const s = this._environment.state.sun.direction;
        this.renderer3D.bakeSpecularIBL(this._environment.state.sky, [-s[0], -s[1], -s[2]]);
        this.ctx.scheduleRender();
    }
    /** Turn OFF crisp cubemap reflections (revert to the soft SH-probe) WITHOUT touching the diffuse ambient. */
    clearSpecularIBL3D(): void { this.renderer3D.clearSpecularIBL(); this.ctx.scheduleRender(); }

    /** Patch the SSR / reflections config (P2). `ssr:true` makes reflective surfaces reflect the actual on-screen
     *  SCENE (composited over the cubemap). Enabling runs the world-position prepass. See environment-and-reflections.md. */
    setSSR3D(reflections: Partial<ReflectionsState>): void {
        this._environment.setReflections(reflections);
        const r = this._environment.state.reflections;
        this.renderer3D.setSSRParams(r.ssrMaxSteps, r.ssrStride, r.ssrThickness, r.ssrIntensity, r.ssrMaxRoughness);
        this.renderer3D.setSSREnabled(r.ssr);
        this.ctx.scheduleRender();
    }
    /** Current reflections config (SSR params + cubemap res). */
    getReflections3D(): ReflectionsState { return { ...this._environment.state.reflections }; }

    /** SSR DEBUG view: reflective fragments show the ray-hit UV (red=u, green=v) instead of the reflected colour, so
     *  the reflection mapping is visible for diagnosing a direction/sign bug. */
    setSSRDebug3D(on: boolean): void { this.renderer3D.setSSRDebug(on); this.ctx.scheduleRender(); }

    /** Apply a named atmosphere PRESET: set the sky params, optionally aim + tint the key light, then bake into IBL —
     *  one-tap golden-hour/sunset/night/etc. Opt-in (P1) — nothing calls this automatically. */
    applySkyPreset3D(name: SkyPresetName, intensity = 1.0): void {
        this._captureEnvSnapshotIfNeeded();   // snapshot BEFORE the preset changes the key light (so Clear is a true undo)
        const p = SKY_PRESETS[name];
        this._environment.setSky(p.sky);
        if (p.sun) {
            // sun az/el (position the light shines FROM) → travel direction, same convention as setLightAngles3D.
            const az = p.sun.azimuthDeg * Math.PI / 180, el = p.sun.elevationDeg * Math.PI / 180, ce = Math.cos(el);
            const dx = -ce * Math.sin(az), dy = -Math.sin(el), dz = -ce * Math.cos(az);
            this.setDirectionalLight(dx, dy, dz, p.sun.color[0], p.sun.color[1], p.sun.color[2], p.sun.intensity);
        }
        this.applyProceduralSkyIBL(intensity);   // reads the sun direction we just set, so the disk lands correctly
    }

    /** All available sky-preset keys (for a picker). */
    listSkyPresets3D(): SkyPresetName[] { return skyPresetNames(); }

    /** Encode an ImageData to a data URL synchronously (so it's captured before a save can race an async encode).
     *  WebP keeps the env map small; returns null if no 2D canvas is available (e.g. a worker with no OffscreenCanvas). */
    private static _imageDataToDataUrl(img: ImageData): string | null {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            ctx.putImageData(img, 0, 0);
            return canvas.toDataURL('image/webp', 0.85);
        } catch { return null; }
    }

    /** Decode a serialized env-map data URL (from a reloaded document) back into an ImageData and apply it. Async —
     *  IBL pops in a frame later; the sync restore path can't block on image decode. */
    private async _restoreEnvMapFromDataUrl(dataUrl: string, intensity: number): Promise<void> {
        try {
            const blob = await (await fetch(dataUrl)).blob();
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.drawImage(bitmap, 0, 0);
            const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            bitmap.close?.();
            // Route through the public setter so _envMapImage/_envMapDataUrl are repopulated for a later re-save.
            this.setEnvironmentMap3D(img, intensity);
        } catch (e) {
            console.warn('Scene3DManager: failed to restore env map from saved document', e);
        }
    }
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

    /** Live-patch just these billboard meshes' instance slots (grow/spin via billboardScale/billboardSpinY + opacity)
     *  without a full instance repack — the info-card intro's 60fps fast lane. See Renderer3D.refreshBillboards. */
    refreshBillboards3D(meshes: import('../../scene-graph/shapes/mesh-3d').Mesh3D[]): void {
        this.renderer3D.refreshBillboards(meshes);
    }

    /** Create an extruded ROUNDED-rectangle SLAB (a flat card with real thickness whose silhouette is rounded) —
     *  front textured, cream back + rounded rim. Like createSprite but with depth + rounded corners; used for the
     *  3D landmark info card. `radius` is in world units (must match the card texture's corner radius fraction). */
    createRoundedSlab(x: number, y: number, z: number, width = 1, height = 1, depth = 0.1, radius = 0.1, material?: Partial<import('../../renderer/3d/material-3d').Material3D>): import('../../scene-graph/shapes/mesh-3d').Mesh3D {
        return this.createMesh(x, y, z, { primitive: 'custom', geometry: generateRoundedSlab(width, height, depth, radius), material });
    }

    static get PS1Defaults(): PS1Config { return { ...DEFAULT_PS1_CONFIG }; }
    static get FogDefaults(): FogConfig { return { ...DEFAULT_FOG_CONFIG }; }

    // ── Selection ────────────────────────────────────────────────────

    getSelected3DIds(): Set<string> { return this._armature.getSelected3DIds(); }

    setSelected3DIds(ids: Set<string>): void { return this._armature.setSelected3DIds(ids); }

    clearSelection(): void { return this._armature.clearSelection(); }

    /**
     * Called when an outliner node is clicked. Syncs the 3D renderer and gizmo
     * without calling ctx.setSelectedNode (which would cause a cycle).
     * Handles both Mesh3D and MeshGroup3D node IDs.
     */
    syncSelectionFromOutliner(nodeId: string): void { return this._armature.syncSelectionFromOutliner(nodeId); }

    // ── Hover highlight ──────────────────────────────────────────────

    /**
     * Highlight the given mesh with a thin light-blue outline on hover.
     * Pass null to clear. Safe to call from Outliner list item mouseenter/mouseleave.
     */
    // Per-object index sub-ranges within merged city meshes (landmark exact-silhouette hover). meshId → ranges.
    private _meshOutlineRanges = new Map<string, { id: number; start: number; count: number }[]>();
    private _landmarkAnimHeld = false;
    /** Trace ONE landmark's exact silhouette (from the merged world:lm-* meshes) with the hover-outline style. Pass
     *  null to clear. The city bypasses the normal hover path (city meshes are non-pickable); this is its hover. */
    outlineLandmark3D(landmarkId: number | null): void {
        let entries: { meshId: string; indexStart: number; indexCount: number }[] | null = null;
        if (landmarkId != null) {
            entries = [];
            for (const [meshId, ranges] of this._meshOutlineRanges) {
                if (!this.getMesh(meshId)) continue;   // stale (removed on a regen) — skip
                const r = ranges.find(x => x.id === landmarkId);
                if (r) entries.push({ meshId, indexStart: r.start, indexCount: r.count });
            }
            if (!entries.length) entries = null;
        }
        this.renderer3D.setHoverOutlineRanges(entries);
        const need = entries != null && this.renderer3D.hoverOutlineAnimated;   // keep frames flowing while animated
        if (need !== this._landmarkAnimHeld) {
            this._landmarkAnimHeld = need;
            if (need) this.ctx.interactionService.beginInteractive();
            else this.ctx.interactionService.endInteractive();
        }
        this.ctx.scheduleRender();
    }

    setHoveredMesh(id: string | null): void { return this._armature.setHoveredMesh(id); }

    getHoveredMeshId(): string | null { return this._armature.getHoveredMeshId(); }

    // ── Picking ──────────────────────────────────────────────────────

    /** If `meshId` is an attachment overlay (eye decal / hair / garment), return the body it belongs
     *  to — so clicking any part of a dressed character selects the body. Else return the id as-is. */
    private _resolveOverlayToBody(meshId: string): string {
        return this._character.overlayBodyOf(meshId) ?? meshId;
    }

    /** If `meshId` is a procedural-character body OR one of its parts, return the body id; else null. */

    /** All mesh ids of one character: the body + its eye decal + hair + every garment. */

    /** Expand a selection so picking ANY character part selects the WHOLE character (body + parts) —
     *  the gizmo then moves it as one unit (multi-select transform; the skeleton stays put). */

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
        includeNonPickable = false,
    ): { meshId: string; hitPoint: [number, number, number]; faceNormal: [number, number, number]; triangleIndex: number; distance: number } | null {
        const camera = this.renderer3D.getCamera();
        const meshes = this.getAllMeshes();
        const result = this._picker.pickMesh(mouseX, mouseY, canvasWidth, canvasHeight, camera, meshes, includeNonPickable);
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
        includeNonPickable = false,
    ): { meshId: string; hitPoint: [number, number, number]; faceNormal: [number, number, number]; triangleIndex: number; distance: number } | null {
        // CSS coordinates: DPR cancels in NDC = 2*(cssX/cssW)-1, so pass CSS consistently.
        return this.pick3D(clientX - canvasRect.left, clientY - canvasRect.top, canvasRect.width, canvasRect.height, includeNonPickable);
    }

    /** Raycast a SINGLE mesh from a client point (world hit + normal). Cheap — one BVH — for hovering a
     *  chosen target (the decal tool locks onto one mesh so it never re-raycasts the whole city per move). */
    pickMeshFromClient3D(
        clientX: number,
        clientY: number,
        canvasRect: { left: number; top: number; width: number; height: number },
        meshId: string,
    ): { hitPoint: [number, number, number]; faceNormal: [number, number, number] } | null {
        const mesh = this.getMesh(meshId);
        if (!mesh) return null;
        const r = this._picker.pickMesh(clientX - canvasRect.left, clientY - canvasRect.top, canvasRect.width, canvasRect.height, this.renderer3D.getCamera(), [mesh], true);
        return r ? { hitPoint: r.hitPoint, faceNormal: r.faceNormal } : null;
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
    setMeshEditModeChecker(fn: () => boolean): void { return this._armature.setMeshEditModeChecker(fn); }

    /**
     * Provide a data supplier for the mesh edit overlay renderer.
     * Called once per frame while transform controls are active; return null when not editing.
     * Typically supplied by ShapeManager after both meshEdit and scene3d are initialized.
     */
    setMeshEditDataProvider(fn: () => MeshEditDrawData | null): void { return this._armature.setMeshEditDataProvider(fn); }

    /**
     * Enable the transform gizmo + click-to-select for 3D meshes.
     * Attaches pointer event listeners to the canvas.
     */
    enableTransformControls(): void { return this._armature.enableTransformControls(); }

    /** Set up (or re-use) the canvas listeners that drive bone overlay hover, drag, and placement.
     *  Idempotent — safe to call multiple times; only registers once per canvas session. */

    disableTransformControls(): void { return this._armature.disableTransformControls(); }

    // ── Array Tool (Phase 4) ──────────────────────────────────────────────────

    enableArrayTool(mode: ArrayToolMode = 'line', initialCount = 3): void {
        this._arrayTool?.destroy();

        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;

        const gr = this._armature.getGizmoRenderer();
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

    setGizmoMode(mode: GizmoMode): void { return this._armature.setGizmoMode(mode); }

    getGizmoMode(): GizmoMode { return this._armature.getGizmoMode(); }

    setGizmoOrientation(mode: 'world' | 'local'): void { return this._armature.setGizmoOrientation(mode); }

    getGizmoOrientation(): 'world' | 'local' { return this._armature.getGizmoOrientation(); }

    // ── Snap settings ────────────────────────────────────────────────

    /** Grid size for Ctrl+drag position snapping (world units). Default 1.0. */
    get snapGridSize(): number { return this._armature.snapGridSize; }
    set snapGridSize(v: number) { this._armature.snapGridSize = v; }

    /** Angle increment for Ctrl+drag rotation snapping (radians). Default 15° (π/12). */
    get snapAngle(): number { return this._armature.snapAngle; }
    set snapAngle(v: number) { this._armature.snapAngle = v; }

    /** Scale factor increment for Ctrl+drag scale snapping. Default 0.25. */
    get snapScaleStep(): number { return this._armature.snapScaleStep; }
    set snapScaleStep(v: number) { this._armature.snapScaleStep = v; }

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
    get snapActive(): boolean { return this._armature.snapActive; }

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
    } { return this._armature.getDragInfo(); }

    // ── Viewport snapping ────────────────────────────────────────────

    /** Ctrl+drag snap mode. `'grid'` by default. */
    get snapMode(): SnapMode { return this._armature.snapMode; }
    set snapMode(m: SnapMode) { this._armature.snapMode = m; }

    /** World-space position of the active vertex snap target during a drag; null otherwise. */
    getSnapTarget(): [number, number, number] | null { return this._armature.getSnapTarget(); }

    /** Vertex-snap double-circle visualization (center + candidate squares), or null when not vertex-snapping. */
    getSnapViz(): SnapVizData | null { return this._armature.getSnapViz(); }

    /** Vertex-snap INNER radius (px) — the snap threshold + inner circle. */
    get snapVertexRadiusPx(): number { return this._armature.snapVertexRadiusPx; }
    set snapVertexRadiusPx(v: number) { this._armature.snapVertexRadiusPx = v; }
    /** Vertex-snap OUTER radius (px) — candidate squares show inside it. */
    get snapCandidateRadiusPx(): number { return this._armature.snapCandidateRadiusPx; }
    set snapCandidateRadiusPx(v: number) { this._armature.snapCandidateRadiusPx = v; }

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

    get isShortcutActive(): boolean { return this._armature.getTransformController()?.isShortcutActive ?? false; }
    get shortcutMode(): 'grab' | 'rotate' | 'scale' | null { return this._armature.getTransformController()?.shortcutMode ?? null; }
    get shortcutAxis(): 'x' | 'y' | 'z' | null { return this._armature.getTransformController()?.shortcutAxis ?? null; }
    get shortcutNumericDisplay(): string { return this._armature.getTransformController()?.shortcutNumericDisplay ?? ''; }

    beginTransform3D(mode: 'grab' | 'rotate' | 'scale'): void { return this._armature.beginTransform3D(mode); }

    constrainAxis3D(axis: 'x' | 'y' | 'z'): void {
        this._armature.getTransformController()?.constrainAxis3D(axis);
    }

    appendNumericInput(char: string): void {
        this._armature.getTransformController()?.appendNumericInput(char);
    }

    commitTransform3D(): void { return this._armature.commitTransform3D(); }

    cancelTransform3D(): void { return this._armature.cancelTransform3D(); }

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
        // Cinematic preview: the camera nodes have just been moved to their frame pose above — now point the render
        // camera through whichever one is active at this frame (runs AFTER, so it overrides the legacy camera track).
        if (this._previewThroughCameras) this._applyCameraPreviewAt(frame);
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

        // Camera nodes slerp their rotation so pans arc smoothly (euler-lerp wobbles on big turns); everything
        // else keeps the cheaper component-wise lerp (unchanged behaviour for characters/props).
        const rot = sampleTrack(tracks.rotation ?? [], frame, mesh.isCamera ? interpolateEulerSlerp : interpolateVec3);
        if (rot) { mesh.rotationX = rot[0]; mesh.rotationY = rot[1]; mesh.rotation = rot[2]; }

        // Camera nodes: sample the optional FOV track (radians) into a transient map read by the preview driver for
        // an in-shot zoom. Not persisted here — the KEYFRAMES persist on the mesh; this is just the evaluated value.
        if (mesh.isCamera) {
            const fov = sampleTrack(tracks.fov ?? [], frame, interpolateScalar);
            if (fov !== null) this._animatedCamFov.set(mesh.id, fov);
            else this._animatedCamFov.delete(mesh.id);
        }

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
            this._ribbons.startScrollAnimation(meshId);   // reset scroll counter + start the ribbon tick
        }
        return true;
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
                    this._ribbons.clearScrollFrames(child.id);
                    this._flaRestTransforms.delete(child.id);
                    any = this._frameLinkAnims3D.delete(child.id) || any;
                }
            }
            return any;
        }
        this._ribbons.clearScrollFrames(meshId);
        this._flaRestTransforms.delete(meshId);
        return this._frameLinkAnims3D.delete(meshId);
    }

    setMeshKeyframe(meshId: string, property: TrackName, frame: number, value: any, easing: KeyframeEasing = 'linear'): boolean {
        return this._keyframes.setMeshKeyframe(meshId, property, frame, value, easing);
    }

    removeMeshKeyframe(meshId: string, property: TrackName, frame: number): boolean { return this._keyframes.removeMeshKeyframe(meshId, property, frame); }

    getMeshKeyframeTracks(meshId: string): Mesh3DKeyframeTracks | null { return this._keyframes.getMeshKeyframeTracks(meshId); }

    clearMeshKeyframeTracks(meshId: string): boolean { return this._keyframes.clearMeshKeyframeTracks(meshId); }

    // ── Blend shape weight keyframes ─────────────────────────────────

    setBlendShapeKeyframe(meshId: string, shapeName: string, frame: number, weight: number, easing: KeyframeEasing = 'linear'): boolean {
        return this._keyframes.setBlendShapeKeyframe(meshId, shapeName, frame, weight, easing);
    }

    removeBlendShapeKeyframe(meshId: string, shapeName: string, frame: number): boolean { return this._keyframes.removeBlendShapeKeyframe(meshId, shapeName, frame); }

    getBlendShapeKeyframeTracks(meshId: string): Record<string, Keyframe<number>[]> | null { return this._keyframes.getBlendShapeKeyframeTracks(meshId); }

    // ── Keyframe query helpers (for timeline UI) ─────────────────────

    /**
     * Returns the set of frame numbers where ANY track on this mesh has a keyframe.
     * Use this to draw per-frame markers in the animation timeline UI.
     */
    getMeshKeyframeFrames(meshId: string): number[] { return this._keyframes.getMeshKeyframeFrames(meshId); }

    /** Returns true if the mesh has a keyframe on any track at exactly `frame`. */
    hasMeshKeyframeAtFrame(meshId: string, frame: number): boolean { return this._keyframes.hasMeshKeyframeAtFrame(meshId, frame); }

    /**
     * Returns a flat list of every Mesh3D in the scene with id and name.
     * Use this to populate the animation panel's mesh rows — it includes meshes nested inside groups.
     */
    getAllMeshesForAnimation(): { id: string; name: string }[] { return this._keyframes.getAllMeshesForAnimation(); }

    /**
     * Returns keyframe track data for every mesh in the scene.
     * Use this to build per-mesh dope-sheet rows in the animation panel.
     * Each entry's `tracks` object has the same shape as getMeshKeyframeTracks().
     */
    getAllMeshKeyframeTracks(): { meshId: string; name: string; tracks: Mesh3DKeyframeTracks }[] { return this._keyframes.getAllMeshKeyframeTracks(); }

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

    getTextureLibrary(): TextureLibrary { return this._textures.getTextureLibrary(); }

    /** Upload a texture to the library and apply it to the given mesh. Returns the library texture ID. */
    async uploadAndApplyTexture(meshId: string, source: File | Blob | ImageBitmap, name?: string): Promise<string | null> {
        return this._textures.uploadAndApplyTexture(meshId, source, name);
    }

    /** Apply an already-uploaded library texture to a mesh by ID. */
    applyLibraryTexture(meshId: string, textureId: string): boolean { return this._textures.applyLibraryTexture(meshId, textureId); }

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
            this._keepSpringsAlive(skeleton.id);   // hair jiggles during playback, settles after it stops
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
            this._keepSpringsAlive(skeleton.id);   // hair jiggles during playback, settles after it stops
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
    moveBone3D(skeletonId: string, jointIndex: number, localPos: [number, number, number]): void { return this._armature.moveBone3D(skeletonId, jointIndex, localPos); }

    /** Set the visual tail offset for a joint (in the joint's own local frame). */
    setJointTailOffset3D(skeletonId: string, jointIndex: number, offset: [number, number, number]): void { return this._armature.setJointTailOffset3D(skeletonId, jointIndex, offset); }

    /** Remove a joint and all its descendants, re-indexing remaining joints. */
    removeBone3D(skeletonId: string, jointIndex: number): void { return this._armature.removeBone3D(skeletonId, jointIndex); }

    /** Rename a joint. */
    renameBone3D(skeletonId: string, jointIndex: number, name: string): void { return this._armature.renameBone3D(skeletonId, jointIndex, name); }

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
        return this._weightPaint.enterWeightPaintMode3D(meshId, skeletonId, jointIndex);
    }

    /**
     * Switch the active weight-paint joint without re-entering the mode.
     * Refreshes the heatmap for the new joint index.
     */
    setWeightPaintJoint3D(jointIndex: number): void { this._weightPaint.setWeightPaintJoint3D(jointIndex); }

    /** Paint weights on a set of vertices. Normalizes all weights after each stroke. */
    paintWeightDab3D(meshId: string, jointIndex: number, vertexIndices: number[], targetWeight: number, brushStrength: number): void {
        this._weightPaint.paintWeightDab3D(meshId, jointIndex, vertexIndices, targetWeight, brushStrength);
    }

    /** Normalize all vertex weights so each vertex's 4 weights sum to 1.0. */
    normalizeWeights3D(meshId: string): void { this._weightPaint.normalizeWeights3D(meshId); }

    /** Exit weight-paint mode: restore saved vertex colors. */
    exitWeightPaintMode3D(): void { this._weightPaint.exitWeightPaintMode3D(); }

    setWeightPaintShowSkeleton(show: boolean): void { return this._armature.setWeightPaintShowSkeleton(show); }

    /** Declutter the armature overlay: independently hide the SPRING bones (hair/drape/charm dangle chains) and/or the
     *  regular FK skeleton bones. Both default visible. Purely a view toggle — doesn't affect posing or the sim. */
    setBoneVisibility(showSpring: boolean, showFk: boolean): void { return this._armature.setBoneVisibility(showSpring, showFk); }
    getBoneVisibility(): { spring: boolean; fk: boolean } { return this._armature.getBoneVisibility(); }

    setWeightPaintUnlit(unlit: boolean): void { return this._armature.setWeightPaintUnlit(unlit); }

    // ── IK Chain API ─────────────────────────────────────────────────────────

    /**
     * Add an IK chain to a skeleton. Returns the new chain's id.
     * The initial target is placed at the end-effector's current world position.
     */
    addIKChain(skelId: string, endJointIdx: number, chainLength: number): string { return this._armature.addIKChain(skelId, endJointIdx, chainLength); }

    removeIKChain(skelId: string, chainId: string): void { return this._armature.removeIKChain(skelId, chainId); }

    getIKChains(skelId: string): IKChain[] { return this._armature.getIKChains(skelId); }

    setIKTarget(skelId: string, chainId: string, x: number, y: number, z: number): void { return this._armature.setIKTarget(skelId, chainId, x, y, z); }

    setIKChainEnabled(skelId: string, chainId: string, enabled: boolean): void { return this._armature.setIKChainEnabled(skelId, chainId, enabled); }

    setIKChainLength(skelId: string, chainId: string, chainLength: number): void { return this._armature.setIKChainLength(skelId, chainId, chainLength); }

    /**
     * Set the FK/IK blend weight for a chain: 0 = pure FK, 1 = pure IK (default).
     * Values in between slerp localRotation → IK rotation for smooth FK/IK transitions.
     */
    setIKBlendWeight(skelId: string, chainId: string, weight: number): void { return this._armature.setIKBlendWeight(skelId, chainId, weight); }

    /**
     * Set the pole vector target world position for a chain.
     * If the chain had no pole target before, this activates the pole constraint.
     */
    setPoleTarget(skelId: string, chainId: string, x: number, y: number, z: number): void { return this._armature.setPoleTarget(skelId, chainId, x, y, z); }

    /** Remove the pole vector from a chain, reverting to unconstrained FABRIK. */
    clearPoleTarget(skelId: string, chainId: string): void { return this._armature.clearPoleTarget(skelId, chainId); }

    /**
     * Highlight a joint by index in the bone overlay (e.g. on UI list hover).
     * Pass null to clear. Does not affect canvas pointer hover state.
     */
    highlightJoint3D(jointIndex: number | null): void { return this._armature.highlightJoint3D(jointIndex); }

    /** Whether weight paint mode is currently active. */
    isWeightPainting(): boolean { return this._weightPaint.isActive(); }

    /** Configure the weight paint brush. Call whenever the UI sliders change. */
    setWeightPaintBrush(radius: number, strength: number, targetWeight: number): void { this._weightPaint.setWeightPaintBrush(radius, strength, targetWeight); }

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

    // ── Default idle animations + poses ───────────────────────────────────

    /** Resolve the skeleton id a mesh is bound to (or null). Accepts a body/skinned-mesh id. */
    getSkeletonIdForMesh(meshId: string): string | null {
        const m = this.getMesh(meshId);
        return (m instanceof SkinnedMesh3D) ? (m.skeletonId ?? null) : null;
    }

    /**
     * Pre-populate a skeleton's Animation Clips + Pose Library with the default idle/personality set
     * (breathe, shift weight, look around, stretch, scratch head, talk gesture + recallable poses).
     * Called automatically on procedural-body creation; also exposed so the host can BACKFILL an older
     * character whose skeleton predates this feature. Idempotent: skips any clip/pose whose name is
     * already present, so it never duplicates and never clobbers the animator's own authored content.
     * Accepts EITHER a skeleton id OR a body/skinned-mesh id (resolved to its skeleton). Returns the
     * number of clips + poses actually added.
     */
    installDefaultAnimations(skelOrMeshId: string): number {
        // Forgiving: try it as a skeleton id, else treat it as a mesh id and resolve the bound skeleton.
        const skel = this.getSkeleton(skelOrMeshId) ?? this.getSkeleton(this.getSkeletonIdForMesh(skelOrMeshId) ?? '');
        if (!skel) return 0;
        let added = 0;
        const clips = (skel.data.clips ??= []);
        const haveClip = new Set(clips.map(c => c.name));
        for (const clip of buildDefaultClips(skel.data.joints)) {
            if (haveClip.has(clip.name)) continue;
            clips.push(clip); added++;
        }
        const poses = (skel.data.poses ??= []);
        const havePose = new Set(poses.map(p => p.name));
        for (const pose of buildDefaultPoses(skel.data.joints)) {
            if (havePose.has(pose.name)) continue;
            poses.push(pose); added++;
        }
        if (added > 0) { this.ctx.emitSceneGraphChanged(); this.ctx.scheduleRender(); }
        return added;
    }

    /** Skeleton JSON for persistence with the UNEDITED default clips/poses stripped — they're re-installed
     *  idempotently on load (installDefaultAnimations), so the identical default anim set isn't duplicated
     *  across every procedural character. An EDITED default (or a renamed/added clip/pose) is KEPT, via a deep
     *  compare against a freshly-built default (ids ignored). */
    serializeSkeletonForSave(skel: Skeleton3D): any {
        const j = skel.toJSON();
        if (!skel.isProceduralBody || !j.skeletonData) return j;
        const pClip = new Map(buildDefaultClips(skel.data.joints).map(c => [c.name, c] as const));
        const pPose = new Map(buildDefaultPoses(skel.data.joints).map(p => [p.name, p] as const));
        const dropClip = new Set<string>();
        for (const c of (skel.data.clips ?? [])) { const p = pClip.get(c.name); if (p && Scene3DManager._eqNoId(c, p)) dropClip.add(c.id); }
        const dropPose = new Set<string>();
        for (const p of (skel.data.poses ?? [])) { const pr = pPose.get(p.name); if (pr && Scene3DManager._eqNoId(p, pr)) dropPose.add(p.id); }
        if (dropClip.size) j.skeletonData.clips = (j.skeletonData.clips ?? []).filter((c: any) => !dropClip.has(c.id));
        if (dropPose.size) j.skeletonData.poses = (j.skeletonData.poses ?? []).filter((p: any) => !dropPose.has(p.id));
        return j;
    }

    /** Structural equality ignoring `id` (arrays are order-sensitive; both operands come from the same
     *  deterministic default builder, so an unedited default compares equal to a freshly-built one). */
    private static _eqNoId(a: any, b: any): boolean {
        if (a === b) return true;
        if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b;
        if (Array.isArray(a) || Array.isArray(b)) {
            if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) if (!Scene3DManager._eqNoId(a[i], b[i])) return false;
            return true;
        }
        const ka = Object.keys(a).filter(k => k !== 'id'), kb = Object.keys(b).filter(k => k !== 'id');
        if (ka.length !== kb.length) return false;
        for (const k of ka) if (!(k in b) || !Scene3DManager._eqNoId(a[k], b[k])) return false;
        return true;
    }

    /** The clip names installDefaultAnimations adds (so the host can label/filter the built-ins). */
    getDefaultClipNames(): string[] { return [...DEFAULT_CLIP_NAMES]; }

    /** Convert a quaternion [x,y,z,w] → Euler XYZ degrees (human-readable pose export only). */
    private static _quatToEulerDeg(q: readonly number[]): [number, number, number] {
        const [x, y, z, w] = q;
        const sinr = 2 * (w * x + y * z), cosr = 1 - 2 * (x * x + y * y);
        const sinp = 2 * (w * y - z * x);
        const siny = 2 * (w * z + x * y), cosy = 1 - 2 * (y * y + z * z);
        const k = 180 / Math.PI;
        return [
            Math.atan2(sinr, cosr) * k,
            (Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp)) * k,
            Math.atan2(siny, cosy) * k,
        ];
    }

    /**
     * Export the CURRENT pose as a copy-pasteable text block — one line per joint that's rotated away from
     * rest, with its quaternion [x,y,z,w] + Euler XYZ degrees. Captures the EFFECTIVE rotation
     * (constraintRotation ?? ikRotation ?? localRotation) so it works whether the character was posed with
     * FK gizmos OR IK handles. Pass a skeleton id, or omit to use the skeleton currently in the bone overlay
     * (Edit Armature). Hand the result to an author/LLM (with a description) to bake into a named pose/clip.
     */
    exportPoseData(skelId?: string): string {
        const id = skelId ?? this.getBoneOverlaySkeletonId() ?? '';
        const skel = this.getSkeleton(id);
        if (!skel) return '(no skeleton — open Edit Armature on a character first, or pass a skeleton id)';
        const EPS = 1.5e-3;
        const lines: string[] = [];
        for (const j of skel.data.joints) {
            const q = (j.constraintRotation ?? j.ikRotation ?? j.localRotation) as [number, number, number, number];
            const [x, y, z, w] = q;
            if (Math.abs(x) < EPS && Math.abs(y) < EPS && Math.abs(z) < EPS && Math.abs(Math.abs(w) - 1) < EPS) continue; // at rest → skip
            const e = Scene3DManager._quatToEulerDeg(q);
            lines.push(`  ${j.name.padEnd(12)} [${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)}, ${w.toFixed(4)}]  euler°(${e[0].toFixed(1)}, ${e[1].toFixed(1)}, ${e[2].toFixed(1)})`);
        }
        const head = `POSE EXPORT — skeleton ${id.slice(0, 8)} — ${lines.length} posed joint(s)\n(jointName  quat[x,y,z,w]  euler XYZ°) — paste to Claude with what the pose IS:`;
        return lines.length ? `${head}\n${lines.join('\n')}` : `${head}\n  (all joints at rest — pose the character first)`;
    }

    /**
     * Export the procedural body's PROPORTIONS as a copy-pasteable block — the body params (mesh shape) plus
     * a few rest bone lengths from the skeleton — so a captured pose can be ASSOCIATED with the body it was
     * authored on (hand-on-body poses depend on hip width / arm reach). Pass a body mesh id OR a skeleton id,
     * or omit to use the procedural body bound to the bone-overlay skeleton. Pair with exportPoseData.
     */
    exportBodyData(idOrSkel?: string): string {
        const meshes = this.getAllMeshes();
        let body = idOrSkel ? this.getMesh(idOrSkel) : undefined;
        if (!(body instanceof SkinnedMesh3D) || !body.isProceduralBody) {
            const skelId = (idOrSkel && this.getSkeleton(idOrSkel)) ? idOrSkel : this.getBoneOverlaySkeletonId();
            body = meshes.find(m => m instanceof SkinnedMesh3D && m.isProceduralBody && (!skelId || m.skeletonId === skelId))
                ?? meshes.find(m => m instanceof SkinnedMesh3D && m.isProceduralBody);
        }
        if (!(body instanceof SkinnedMesh3D) || !body.isProceduralBody || !body.skeleton) {
            return '(no procedural body found — create/select a character first)';
        }
        const params = this.getBodyParams(body.id);
        const byName = new Map(body.skeleton.data.joints.map(j => [j.name, j]));
        const len = (child: string): number => { const j = byName.get(child); if (!j) return 0; const p = j.localPosition; return Math.hypot(p[0], p[1], p[2]); };
        const sumY = (...names: string[]): number => names.reduce((s, n) => s + (byName.get(n)?.localPosition[1] ?? 0), 0);
        const measures: Record<string, number> = {
            upperArm: len('lowerarm_L'), forearm: len('hand_L'),
            thigh: len('lowerleg_L'), shin: len('foot_L'),
            hipsToNeck: sumY('lowerback', 'spine', 'chest', 'neck'), neckToHead: len('head'),
        };
        const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${v.toFixed(3)}`).join('  ');
        return [
            `BODY EXPORT — body ${body.id.slice(0, 8)} (skeleton ${body.skeletonId?.slice(0, 8) ?? '?'})`,
            `params: ${params ? JSON.stringify(params) : '(none cached)'}`,
            `rest measures (world units): ${fmt(measures)}`,
            `— paste ALONGSIDE a POSE EXPORT so Claude can associate the pose with this body.`,
        ].join('\n');
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
        // Body-ADAPTIVE arm blend: slerp the captured samples by this body's girth (so a hand-on-hip pose
        // fits thin AND fat bodies). Done AFTER the base rotations (which are the fallback look).
        if (pose.adaptive?.samples.length) this._applyAdaptivePose(skel, pose.adaptive);
        skel.computeWorldMatrices();
        skel.matricesDirty = true;
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    /**
     * Blend a pose's captured arm samples by a body metric and write the result to the arm joints (LEFT mirrored
     * to RIGHT). `girth` = torsoThick + hipWidth — as it rises the shoulder abducts less + the elbow bends more.
     * Slerps between the two bracketing samples (clamped outside the range), so endpoints are exact captures and
     * in-betweens are smooth. Far more reliable than IK for redundant hand-on-body poses (no awkward solutions).
     */
    private _applyAdaptivePose(skel: Skeleton3D, adaptive: { metric: 'girth'; samples: import('../../types/armature-3d').AdaptivePoseSample[] }): void {
        const body = this.getAllMeshes().find(m => m instanceof SkinnedMesh3D && m.isProceduralBody && m.skeletonId === skel.id) as SkinnedMesh3D | undefined;
        const params = body ? this.getBodyParams(body.id) : null;
        const girth = (params?.torsoThick ?? 1) + (params?.hipWidth ?? 1);
        const s = [...adaptive.samples].sort((a, b) => a.at - b.at);
        let lo = s[0], hi = s[s.length - 1];
        for (let i = 0; i < s.length - 1; i++) { if (girth >= s[i].at && girth <= s[i + 1].at) { lo = s[i]; hi = s[i + 1]; break; } }
        const t = hi.at > lo.at ? Math.max(0, Math.min(1, (girth - lo.at) / (hi.at - lo.at))) : 0;
        const byName = new Map(skel.data.joints.map(j => [j.name, j]));
        const tmp = quat.create();
        for (const name of Object.keys(lo.left)) {
            const a = lo.left[name], b = hi.left[name] ?? a;
            quat.slerp(tmp, a as unknown as quat, b as unknown as quat, t);
            const ql: [number, number, number, number] = [tmp[0], tmp[1], tmp[2], tmp[3]];
            const jl = byName.get(name); if (jl) jl.localRotation = [...ql] as [number, number, number, number];
            const jr = byName.get(name.replace('_L', '_R'));   // mirror across the body's symmetry plane
            if (jr && name.endsWith('_L')) jr.localRotation = [ql[0], -ql[1], -ql[2], ql[3]];
        }
    }

    getPoses(skelId: string): { id: string; name: string; region?: AnimRegion }[] {
        const skel = this.getSkeleton(skelId);
        return (skel?.data.poses ?? []).map(p => ({ id: p.id, name: p.name, region: p.region }));
    }

    /** Tag a pose's spatial region (Left/Right/Top/Bottom/Center) for library filtering; null clears it. */
    setPoseRegion(skelId: string, poseId: string, region: AnimRegion | null): void {
        const pose = this.getSkeleton(skelId)?.data.poses?.find(p => p.id === poseId);
        if (pose) { if (region) pose.region = region; else delete pose.region; this.ctx.emitSceneGraphChanged(); }
    }

    /** Tag a clip's spatial region (Left/Right/Top/Bottom/Center); null clears it. */
    setClipRegion(clipId: string, region: AnimRegion | null): void {
        const found = this._findClip(clipId);
        if (found) { if (region) found.clip.region = region; else delete found.clip.region; this.ctx.emitSceneGraphChanged(); }
    }

    /** All poses + clips on a skeleton with the given region — drives the Left/Right/Top/Bottom/Center filter. */
    getAnimationsByRegion(skelId: string, region: AnimRegion): { poses: { id: string; name: string }[]; clips: SkeletonAnimClip[] } {
        const skel = this.getSkeleton(skelId);
        return {
            poses: (skel?.data.poses ?? []).filter(p => p.region === region).map(p => ({ id: p.id, name: p.name })),
            clips: (skel?.data.clips ?? []).filter(c => c.region === region),
        };
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
    getTextureLibraryData(): { entries: any[] } | null { return this._textures.getTextureLibraryData() as { entries: any[] } | null; }

    /**
     * Restore the texture library from a saved snapshot, then re-apply
     * GPU textures to any meshes whose textureLibraryId matches an entry.
     */
    async restoreTextureLibraryData(data: { entries: any[] }): Promise<void> { return this._textures.restoreTextureLibraryData(data); }

    // ── Group outliner helpers ───────────────────────────────────────

    setGroupCollapsed(groupId: string, collapsed: boolean): boolean { return this._grouping.setGroupCollapsed(groupId, collapsed); }

    isGroupCollapsed(groupId: string): boolean { return this._grouping.isGroupCollapsed(groupId); }

    // ── Outliner helpers ─────────────────────────────────────────────

    setMeshVisible(nodeId: string, visible: boolean): boolean { return this._grouping.setMeshVisible(nodeId, visible); }

    isMeshVisible(nodeId: string): boolean { return this._grouping.isMeshVisible(nodeId); }

    setGroupVisible(groupId: string, visible: boolean): boolean { return this._grouping.setGroupVisible(groupId, visible); }

    isGroupVisible(groupId: string): boolean { return this._grouping.isGroupVisible(groupId); }

    setMeshName(nodeId: string, name: string): boolean { return this._grouping.setMeshName(nodeId, name); }

    getMeshName(nodeId: string): string | null { return this._grouping.getMeshName(nodeId); }

    setGroupName(groupId: string, name: string): boolean { return this._grouping.setGroupName(groupId, name); }

    getGroupName(groupId: string): string | null { return this._grouping.getGroupName(groupId); }

    /** Lightweight hierarchy descriptor for ONE 3D mesh node (the same shape getScene3DHierarchy emits per
     *  mesh entry), so a host can incrementally push the nodes a new character added instead of re-scanning
     *  the whole hierarchy. Null if the id isn't a root-level mesh node. */
    getScene3DNode(nodeId: string): Scene3DHierarchyNode | null { return this._grouping.getScene3DNode(nodeId); }

    /**
     * Returns a snapshot hierarchy of 3D nodes for outliner display. Top-level entries are direct children of root
     * that are Mesh3D or MeshGroup3D. Groups include their Mesh3D children. Allocates a new array on every call —
     * cache the result and invalidate on scene-graph-changed events rather than calling this every frame.
     */
    getScene3DHierarchy(): Scene3DHierarchyNode[] { return this._grouping.getScene3DHierarchy(); }

    // ── Normal maps ──────────────────────────────────────────────────

    /** Upload a normal map texture and apply it to the given mesh. */
    async setMeshNormalMap(nodeId: string, source: File | Blob | ImageBitmap): Promise<boolean> { return this._textures.setMeshNormalMap(nodeId, source); }

    clearMeshNormalMap(nodeId: string): boolean { return this._textures.clearMeshNormalMap(nodeId); }

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
        x: number, y: number, z: number,
        controlPoints: RibbonControlPoint[],
        width: number,
        segments = 16,
        material?: Partial<Material3D>,
    ): Mesh3D {
        return this._ribbons.addRibbon(x, y, z, controlPoints, width, segments, material);
    }

    updateRibbonPath3D(meshId: string, controlPoints: RibbonControlPoint[]): boolean {
        return this._ribbons.updatePath(meshId, controlPoints);
    }

    updateRibbonWidth3D(meshId: string, width: number): boolean {
        return this._ribbons.updateWidth(meshId, width);
    }

    /** Returns the stored ribbon data for a mesh, or null if it is not a ribbon. */
    getRibbonData3D(meshId: string): RibbonData | null {
        return this._ribbons.getData(meshId);
    }

    /** Remove ribbon tracking data (does NOT delete the mesh). */
    removeRibbonData3D(meshId: string): boolean {
        return this._ribbons.removeData(meshId);
    }

    setRibbonControlPoint3D(meshId: string, index: number, x: number, y: number, z: number): boolean {
        return this._ribbons.setControlPoint(meshId, index, x, y, z);
    }

    setRibbonEndPadding3D(meshId: string, uvEndPadding: number): boolean {
        return this._ribbons.setEndPadding(meshId, uvEndPadding);
    }

    setRibbonPathMode3D(meshId: string, mode: RibbonPathMode): boolean {
        return this._ribbons.setPathMode(meshId, mode);
    }

    setRibbonDoubleSided3D(meshId: string, doubleSided: 'double' | 'front' | 'back' | boolean): boolean {
        return this._ribbons.setDoubleSided(meshId, doubleSided);
    }

    updateRibbonSegments3D(meshId: string, segments: number): boolean {
        return this._ribbons.updateSegments(meshId, segments);
    }

    getRibbonHandleScreenPositions3D(
        ribbonId: string,
        overlayWidth: number,
        overlayHeight: number,
    ): Array<{ x: number; y: number; index: number } | null> {
        return this._ribbons.getHandleScreenPositions(ribbonId, overlayWidth, overlayHeight);
    }

    beginRibbonHandleDrag3D(ribbonId: string, handleIndex: number, overlayWidth: number, overlayHeight: number): boolean {
        return this._ribbons.beginHandleDrag(ribbonId, handleIndex, overlayWidth, overlayHeight);
    }

    moveRibbonHandle3D(
        ribbonId: string,
        handleIndex: number,
        offsetX: number, offsetY: number,
        overlayWidth: number, overlayHeight: number,
    ): boolean {
        return this._ribbons.moveHandle(ribbonId, handleIndex, offsetX, offsetY, overlayWidth, overlayHeight);
    }

    endRibbonHandleDrag3D(ribbonId: string, handleIndex: number): void {
        this._ribbons.endHandleDrag(ribbonId, handleIndex);
    }

    setRibbonFlipRearU3D(meshId: string, flip: boolean): boolean {
        return this._ribbons.setFlipRearU(meshId, flip);
    }

    setRibbonUvTileCount3D(meshId: string, tileCount: number): boolean {
        return this._ribbons.setUvTileCount(meshId, tileCount);
    }

    setRibbonShowHandles3D(meshId: string, show: boolean): boolean {
        return this._ribbons.setShowHandles(meshId, show);
    }

    computeRibbonTextureSize3D(
        meshId: string,
        targetHeight = 128,
        maxWidth = 2048,
    ): { width: number; height: number; fontSize: number } | null {
        return this._ribbons.computeTextureSize(meshId, targetHeight, maxWidth);
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
        return this._htmlTex.set(meshId, html, width, height, options);
    }

    /**
     * Paint a mesh's diffuse texture directly with the Canvas 2D API via a draw callback.
     *
     * Same texture lifecycle as {@link setHtmlTexture3D} (reuses the per-mesh HtmlTexture3D, snapshots
     * the old texture to avoid a double-destroy), but the pixels come from an imperative 2D draw rather
     * than HTML/CSS. Use this for cards/labels whose look (rounded corners, drop shadows, rotated pills)
     * exceeds the CSS subset the HTML fallback can render, and to stay independent of the experimental
     * HTML-in-Canvas browser flag. Not persisted to the document (a draw callback isn't serializable) —
     * intended for transient overlays like the landmark hover card.
     */
    async setCanvasTexture3D(
        meshId: string,
        width: number,
        height: number,
        draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
    ): Promise<boolean> {
        return this._htmlTex.setCanvas(meshId, width, height, draw);
    }

    /**
     * Update the HTML content of an existing HTML texture without changing its size.
     * Faster than `setHtmlTexture3D` because it skips the texture recreation step.
     * Returns false if no HTML texture exists for this mesh — call setHtmlTexture3D first.
     */
    async updateHtmlTexture3D(meshId: string, html: string, options?: HtmlTexture3DOptions): Promise<boolean> {
        return this._htmlTex.update(meshId, html, options);
    }

    /**
     * Remove the HTML texture from a mesh and destroy the GPU texture.
     * The mesh reverts to its material diffuse color.
     */
    removeHtmlTexture3D(meshId: string): boolean {
        return this._htmlTex.remove(meshId);
    }

    /** Returns true if the mesh has an active HTML texture. */
    hasHtmlTexture3D(meshId: string): boolean {
        return this._htmlTex.has(meshId);
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
    // ── Cloth subsystem delegators (impl: scene3d-cloth.ts) ──────────────────────

    createClothMesh(
        x: number, y: number, z: number,
        gridConfig: Partial<ClothGridConfig> = {},
        physicsConfig: Partial<ClothPhysicsConfig> = {},
        simulatedPositions?: Float32Array,
        name?: string,
    ): ClothMesh3D {
        return this._cloth.createClothMesh(x, y, z, gridConfig, physicsConfig, simulatedPositions, name);
    }

    replaceClothMesh(
        meshId: string,
        gridConfig: ClothGridConfig,
        physicsConfig: ClothPhysicsConfig,
        simulatedPositions?: Float32Array,
        mode: 'hang' | 'drape' | 'none' = 'none',
    ): boolean {
        return this._cloth.replaceClothMesh(meshId, gridConfig, physicsConfig, simulatedPositions, mode);
    }

    getClothConfig(meshId: string): { grid: ClothGridConfig; physics: ClothPhysicsConfig } | null {
        return this._cloth.getClothConfig(meshId);
    }

    getClothGeometryResult(meshId: string): ClothGeometryResult | null {
        return this._cloth.getClothGeometryResult(meshId);
    }

    getClothVertexSlot(meshId: string, col: number, row: number): number | null {
        return this._cloth.getClothVertexSlot(meshId, col, row);
    }

    getClothVertexDenseIndex(meshId: string, col: number, row: number): number | null {
        return this._cloth.getClothVertexDenseIndex(meshId, col, row);
    }

    /** @deprecated Use getClothVertexSlot for pins, getClothVertexDenseIndex for stitches. */
    getClothVertexIndex(meshId: string, col: number, row: number): number | null {
        return this._cloth.getClothVertexIndex(meshId, col, row);
    }

    setClothConfig(
        meshId: string,
        gridConfig?: Partial<ClothGridConfig>,
        physicsConfig?: Partial<ClothPhysicsConfig>,
    ): boolean {
        return this._cloth.setClothConfig(meshId, gridConfig, physicsConfig);
    }

    setClothPhysics(meshId: string, params: Partial<ClothPhysicsConfig>): boolean {
        return this._cloth.setClothPhysics(meshId, params);
    }

    setClothPinnedVertices(meshId: string, pinnedVertices: number[]): boolean {
        return this._cloth.setClothPinnedVertices(meshId, pinnedVertices);
    }

    setClothConfigDebounced(
        meshId: string,
        gridConfig?: Partial<ClothGridConfig>,
        physicsConfig?: Partial<ClothPhysicsConfig>,
        delayMs = 150,
    ): void {
        this._cloth.setClothConfigDebounced(meshId, gridConfig, physicsConfig, delayMs);
    }

    // ── Stitch tool ───────────────────────────────────────────────────────────

    beginClothStitchTool(meshId: string, vertexA: number, restLength = 0): boolean {
        return this._cloth.beginClothStitchTool(meshId, vertexA, restLength);
    }

    previewClothStitch(meshId: string, vertexB: number): boolean {
        return this._cloth.previewClothStitch(meshId, vertexB);
    }

    commitClothStitch(meshId: string): number | null {
        return this._cloth.commitClothStitch(meshId);
    }

    cancelClothStitchTool(meshId: string): void {
        this._cloth.cancelClothStitchTool(meshId);
    }

    addClothStitch(meshId: string, a: number, b: number, restLength: number): number | null {
        return this._cloth.addClothStitch(meshId, a, b, restLength);
    }

    removeClothStitch(meshId: string, index: number): boolean {
        return this._cloth.removeClothStitch(meshId, index);
    }

    clearClothStitches(meshId: string): boolean {
        return this._cloth.clearClothStitches(meshId);
    }

    getClothStitches(meshId: string): StitchConstraint[] {
        return this._cloth.getClothStitches(meshId);
    }

    // ── Bend-stiffness painting ───────────────────────────────────────────────

    setClothBendStiffness(meshId: string, map: Float32Array | number[]): boolean {
        return this._cloth.setClothBendStiffness(meshId, map);
    }

    getClothBendStiffnessMap(meshId: string): Float32Array | null {
        return this._cloth.getClothBendStiffnessMap(meshId);
    }

    addWindZone(meshId: string, zone: Omit<WindZone, 'id'>): string | null {
        return this._cloth.addWindZone(meshId, zone);
    }

    removeWindZone(meshId: string, zoneId: string): boolean {
        return this._cloth.removeWindZone(meshId, zoneId);
    }

    updateWindZone(meshId: string, zoneId: string, patch: Partial<Omit<WindZone, 'id'>>): boolean {
        return this._cloth.updateWindZone(meshId, zoneId, patch);
    }

    getWindZones(meshId: string): WindZone[] {
        return this._cloth.getWindZones(meshId);
    }

    clearWindZones(meshId: string): boolean {
        return this._cloth.clearWindZones(meshId);
    }

    async simulateCloth(
        gridConfig:    Partial<ClothGridConfig>,
        physicsConfig: Partial<ClothPhysicsConfig>,
        mode: 'hang' | 'drape',
        proxy: DrapeProxy = { type: 'none' },
        maxSteps = 3000,
    ): Promise<Float32Array> {
        return this._cloth.simulateCloth(gridConfig, physicsConfig, mode, proxy, maxSteps);
    }

    updateClothMeshPose(
        meshId: string,
        simulatedPositions: Float32Array,
        mode: 'hang' | 'drape' | 'none' = 'none',
    ): boolean {
        return this._cloth.updateClothMeshPose(meshId, simulatedPositions, mode);
    }

    createLiveClothSim(
        grid:    Partial<ClothGridConfig>,
        physics: Partial<ClothPhysicsConfig>,
        mode:    'hang' | 'drape',
        proxy?:  DrapeProxy,
    ): LiveClothHandle | null {
        return this._cloth.createLiveClothSim(grid, physics, mode, proxy);
    }

    enableLiveCloth(meshId: string, stepsPerFrame?: number): boolean {
        return this._cloth.enableLiveCloth(meshId, stepsPerFrame);
    }

    async disableLiveCloth(meshId: string, bakeCurrentPose = false): Promise<boolean> {
        return this._cloth.disableLiveCloth(meshId, bakeCurrentPose);
    }

    getLiveClothHandle(meshId: string): LiveClothHandle | null {
        return this._cloth.getLiveClothHandle(meshId);
    }

    tickLiveCloths(frame: number): boolean {
        return this._cloth.tickLiveCloths(frame);
    }

    attachClothPreviewCanvas(
        meshId: string,
        canvas: HTMLCanvasElement,
        opts?: ClothPreviewOptions,
    ): () => void {
        return this._cloth.attachClothPreviewCanvas(meshId, canvas, opts);
    }

    /** Upload a normal map to the TextureLibrary and apply it to a mesh. Returns library ID. */
    async uploadAndApplyNormalMap(meshId: string, source: File | Blob | ImageBitmap, name?: string): Promise<string | null> {
        return this._textures.uploadAndApplyNormalMap(meshId, source, name);
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
        return this._particles.add(x, y, z, config, preset);
    }

    removeParticleEmitter(id: string): void {
        this._particles.remove(id);
    }

    getParticleEmitter(id: string): ParticleEmitter3D | null {
        return this._particles.get(id);
    }

    setParticleEmitterConfig(id: string, config: ParticleEmitterConfig): void {
        this._particles.setConfig(id, config);
    }

    getAllParticleEmitters(): ParticleEmitter3D[] {
        return this._particles.getAll();
    }

    /** Re-register a ParticleEmitter3D node that was restored from JSON. */
    registerRestoredParticleEmitter(emitter: ParticleEmitter3D): void {
        this._particles.registerRestored(emitter);
    }

    /** Ensure the GPU instance sync callback is active after ArrayGroup3D nodes are restored. */
    registerRestoredArrayGroups(): void {
        this._arrays.registerRestored();
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
