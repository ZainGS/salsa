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

import { splitPassStats, type PassSplit } from '../../renderer/3d/pass-stats';
import { STREAM_HITCH } from '../../renderer/3d/stream-hitch';
import { sceneFrameBounds, framePose } from './scene-frame';
import type { ManagerContext } from './manager-context';
import { EventEmitter } from '../../renderer/util/event-emitter';
import { deriveViewRules, normalizeViewState, DEFAULT_VIEW_STATE, type ViewState, type ViewTarget, type CameraMode } from './view-state';
import { GameLoop } from '../../game/game-loop';
import { ScriptBehaviorManager } from '../scripting/script-behavior-manager';
import { ScriptCompiler } from '../scripting/script-compiler';
import { ScriptRunner } from '../scripting/script-runner';
import type { ScriptSceneAdapter, ScriptBehavior, ScriptInput } from '../scripting/script-types';
import { SCRIPT_CONTEXT_DTS, SCRIPT_SNIPPETS, type ScriptSnippet } from '../scripting/script-context-dts';
import { CharacterController, DEFAULT_CHARACTER, PLAY_JUMP_WINDUP, type CharacterInput, type CharacterConfig } from '../../game/character-controller';
import { mergeHostPlayInput } from '../../game/play-input';
import { PlaySettings, type PlaySettingsState } from './play-settings';
import { buildLocomotionClips, playArmClearance, applyWalkStyle, LOCOMOTION_CLIP, DEFAULT_LOCOMOTION_CLIP_NAMES, JUMP_VARIANT_CLIPS } from './default-locomotion';
import { buildIdleVariantClips, GLASSES_CHARMS } from './default-idle-variants';
import { PlayDustDriver, type DustEnvironment } from './play-dust-driver';
import type { DustLighting } from '../../game/landing-dust';
import { relaxedStance } from './pose-authoring';
import { ThirdPersonCamera, avatarCameraFraming } from '../../game/third-person-camera';
import { avatarCollisionScale, clampCharacterScale, feetAnchoredY, geometryMinY, scaleFactorForHeight } from '../../game/character-scale';
import { GamepadInput, type GamepadReading } from '../../game/gamepad-input';
import { LocomotionAnimator, LocomotionLean, LocomotionSecondary, seedFromString, DEFAULT_LOCOMOTION_ANIM } from '../../game/locomotion-animator';
import { sampleClipPose, overlayPoseMasked, addPoseMasked } from '../../renderer/3d/skeleton-animator';
import { composeLocomotionPose, applyLocomotionLean, applyLocomotionSecondary, secondaryInputFor } from './locomotion-pose';
import { PlayAutoPlayer, AUTO_PLAYER_CLIPS, AUTO_PLAYER_SEED, AUTO_PLAYER_HEIGHT_M, type AutoPlayerBody } from './play-auto-player';
import { randomCharacterParams } from './character-randomizer';
import { KeyboardInput } from '../../game/keyboard-input';
import { FlyController } from '../../game/fly-controller';
import { MouseLook } from '../../game/mouse-look';
import { placePlayerLight } from '../../game/player-light';
import { sampleStandableGround, findStandableGround, resolveHorizontalMove, type RayCaster } from '../../game/collision-math';
import { LocomotionClipDriver, DEFAULT_LOCOMOTION_BLEND, type LocomotionClips, type LocomotionState, type LocomotionBlendConfig } from '../../game/locomotion';
import { TriggerVolumeSystem, type TriggerVolume, type TriggerEvent } from '../../game/trigger-volumes';
import { InteractionSystem, type Interactable } from '../../game/interaction';
import { EnvironmentManager, DEFAULT_ENVIRONMENT, type SkyState, type ReflectionsState } from './environment-manager';
import { bakeSkyEquirect, DEFAULT_SKY } from '../../renderer/3d/procedural-sky';
import { SKY_PRESETS, skyPresetNames, type SkyPresetName } from '../../renderer/3d/sky-presets';
import { SpatialGridXZ, type XZBounds } from '../../game/spatial-grid';
import { CollisionSnapshot } from '../../game/collision-snapshot';
import { isVisualOnlyMesh } from '../../game/collision-filter';
import { evaluateSceneBudget, SCENE_BUDGET_DEFAULTS, type SceneBudgetLimits } from '../../renderer/3d/scene-budget';
import { GroupBoundsJob } from './group-bounds';
import { CollisionHood } from '../../game/collision-hood';
import { classifyCameraOccluder, cameraOccluderScale, isCameraBlockMode, type CameraBlockMode, type CameraOccluderVerdict } from '../../game/camera-occluders';
import { CollisionCellManager, cellRaycast, newCellRayScratch, type CollisionCell, type CellRayPicker } from '../../game/collision-cells';
import { buildCellBvhAsync } from '../workers/near-lane';

/** Play's pre-run TRS snapshot for the non-destructive Stop restore (see _snapshotTransforms): mesh refs + 9 packed floats each (bug-hunt 2026-10-01 — one object per mesh in a big
 *  city, and a full 3-setter rebuild of every mesh on Stop, made Stop hitch). */
type PlayXformSnapshot = { meshes: Mesh3D[]; trs: Float64Array };

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
import { Material3D, type SceneWind3D, type SkinRampSettings } from '../../renderer/3d/material-3d';
import { MeshGeometry, generateRibbon, generateRoundedSlab, FLOATS_PER_VERT } from '../../renderer/3d/mesh-generators';
import { Mesh3D, Mesh3DConfig, MeshPrimitive, Submesh3D } from '../../scene-graph/shapes/mesh-3d';
import { DEFAULT_RESOLUTION_SCALE, type ResolutionScaleState } from '../../renderer/core/resolution-scaler';
import { RasterTextureManager } from '../../renderer/raster/raster-texture-manager';
import type { EyeParams } from './eye-generator';
import { HairParams } from './hair-generator';
import {
    ClothingParams, ClothingPattern, patternPresetNames, patternPreset,
} from './clothing-generator';
import { generateBodyResult } from './body-generator';
import { generateBodyAsync, generateCharacterPartsAsync } from '../workers/character-lane';
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
import type { ElementTransformRouter } from './mesh-element-transform';
import { rebase3DNodeToParent } from './transform-rebase-3d';
import { TextureLibrary } from '../texture-library';
import {
  Mesh3DKeyframeTracks, TrackName, KeyframeEasing, Keyframe,
  Camera3DKeyframeTracks, CameraTrackName,
  sampleTrack, setKeyframe, removeKeyframe,
  cloneKeyframeTracks, hasAnyKeyframes, EMPTY_TRACK,
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
export type { LegIdleMode } from './scene3d-animation';   // moved with the idle engine (Slice C)
import { solveAllConstraints, clearAllConstraintState } from '../../renderer/3d/constraint-solver';
import { solveSpringBones, resetSpringState } from '../../renderer/3d/spring-bone-solver';
import { applySkeletonClipAtFrame, evaluateNLAAtFrame, snapshotSkeletonPose, writePoseToSkeleton, type SkeletonPose } from '../../renderer/3d/skeleton-animator';
import { planTurntable, boundsCenterRadius, orbitCameraPose } from '../../renderer/3d/turntable-preview';
import { AssetReferenceStore, type DocumentAssetReference } from '../assets/asset-reference-store';
import { buildDefaultPoses, buildDefaultClips, DEFAULT_CLIP_NAMES, DEFAULT_BREAK_CLIP_NAMES } from './default-animations';
import { exportSceneToGlb, type GltfExportResult } from '../../renderer/3d/gltf-exporter';
import { sanitizeObjectStyle } from './object-style';
import { fogHorizonDiff } from '../../renderer/3d/fog-horizon';
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
import { Scene3DSurfacePaint, type SurfacePaintHandlers } from './scene3d-surface-paint';
import { Scene3DMaterials } from './scene3d-materials';
import { Scene3DArrays } from './scene3d-arrays';
import { Scene3DGrouping } from './scene3d-grouping';
import { retargetClipTracks, classifyRig, resolveRegionMask, type RegionMask } from './anim-retarget';
import { AnimationLibrary, type AnimLibraryEntry, type AnimationLibraryData } from './animation-library';
import { Scene3DKeyframes } from './scene3d-keyframes';
import { Scene3DTextures } from './scene3d-textures';
import { Scene3DImport } from './scene3d-import';
import { Scene3DArrayBake } from './scene3d-array-bake';
import { Scene3DWeightPaint } from './scene3d-weight-paint';
import { Scene3DKitbash } from './scene3d-kitbash';
import { Scene3DAnimation, IDLE_JOINTS, type LegIdleMode as _LegIdleMode } from './scene3d-animation';
import type { CharacterSlot, CharacterDefinition, CharacterData, KitbashPartMeta } from '../../types/kitbash-3d';
import { GpObject3D } from '../../scene-graph/shapes/gp-object-3d';
import { Scene3DGreasePencil } from './scene3d-grease-pencil';
import { GpDrawGesture, type GpGestureSample } from './gp-draw-gesture';
import { GpSurfacePlacer, type GpSurfaceHit } from './gp-surface-placer';
import { claimPointerEvent } from '../../renderer/util/pointer-claims';
import { Scene3DBlendShapes } from './scene3d-blend-shapes';
import { Scene3DCloth } from './scene3d-cloth';
import { Scene3DRibbons } from './scene3d-ribbons';
import { Scene3DCharacter, applyMatte } from './scene3d-character';
import { Scene3DArmature } from './scene3d-armature';
import type { GpPoint, GpStroke3D } from '../../types/grease-pencil-3d';
import { EditMesh } from '../../scene-graph/shapes/edit-mesh';
import { cloneGeneratorRecord, readGeneratorRecord } from '../../scene-graph/shapes/mesh-generator';
import { Modifier } from '../../scene-graph/shapes/modifiers';
import { ArrayToolController, ArrayToolMode } from './array-tool-controller';
import { addZonelessListener, removeZonelessListener } from '../../renderer/util/zoneless-listeners';
import { resolveArmClearance, withGarments } from './arm-clearance';
import { DEFAULT_TOON_SHADOWS, DEFAULT_RIM_LIGHT } from '../../renderer/3d/material-3d';
import type { SkinnedMeshData } from './skin-deform-metrics';
import { SimLod, newSimSlot, SIM_NEAR, type SimSlot } from '../../world/sim-lod';
import { computeFogEye } from '../../renderer/3d/fog-horizon';
import { faceOnFraming } from './edit-face-frame';
/** Edit Mesh Frame on faces: the face-on camera move (frameEditFacesOn3D). */
const EDIT_FACE_FRAME_MS = 250;
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
    /** `cascades` (persona-polish A2, optional): near shadow cascades — absent = the original single map. */
    shadows:       { enabled: boolean; mapSize: number; halfExtent: number; bias: number; strength?: number; softness?: number; cascades?: import('../../renderer/3d/shadow-cascades').ShadowCascadeSettings };
    snap:          SnapMode;
    /** Snap increments (optional for back-compat): grid cell size (world units, also the visible grid
     *  spacing), rotate step (radians), scale step (factor). */
    snapGridSize?:  number;
    snapRotateStep?: number;
    snapScaleStep?:  number;
    /** Visible ground grid — per-illustration (a character sheet wants one, a painted bg may not). */
    grid:          { visible: boolean; color: [number, number, number]; opacity: number };
    /** Global soft-lighting (wrapped/half-Lambert) strength 0..1 for softLighting materials (anime skin). Optional;
     *  absent in old saves → the renderer default (0.6). */
    softLightStrength?: number;
    /** Scene-global skin toon-ramp look (bands / softness / shadowFloor / warm shadowTint) for skinRamp materials.
     *  Optional; absent in old saves → the renderer default (a clean 2-band ramp). See character-shading spec Part A. */
    skinRamp?: SkinRampSettings;
    /** Sketch style paper amount (0 colour .. 1 paper); absent = 0.75, the original look. */
    sketchPaper?: number;
    /** E3 CHARACTER OUTLINES (persona-polish-plan.md E3): the scene's characters-only outline style, applied to every
     *  procedural character (body + clothes + hair as one silhouette) and to characters created later. null / absent =
     *  off (the default). Each body also stores its own outline, so a load restores what was drawn. */
    characterOutlines?: Partial<HighlightStyle> | null;
    /** PLAY CHARACTER OUTLINES (visual-polish item 10): while Play runs and characterOutlines is off, every procedural
     *  character without its own outline gets the default ink line (runtime only — nothing is written to the meshes).
     *  New documents: true. Absent (a save from before it existed) = false, so old documents play as they did. */
    playCharacterOutlines?: boolean;
    /** Toon-shadow look for toonShadow materials in Cel (absent = defaults). */
    toonShadows?: import('../../renderer/3d/material-3d').ToonShadowSettings;
    /** Parameterised rim light (absent = strength 0 = the original rim). */
    rimLight?: import('../../renderer/3d/material-3d').RimLightSettings;
    /** The ENVIRONMENT style (2026-09-29): the look the city / blocks / creator objects get, and new ones start with.
     *  Characters are never environment. Each object also saves its own style, so this is the default + bulk setter. */
    environmentStyle?: import('./object-style').ObjectStyle;
    /** COLOURED cast-shadow tint (null / absent = neutral grey, the original). */
    shadowTint?: [number, number, number] | null;
    /** HEIGHT FOG (city-quality P9): [density (0 = off), baseY, falloff, reach]. Absent = off. */
    heightFog?: [number, number, number, number];
    /** AERIAL HAZE (persona-polish A5): [strength (0 = off), reach, contrast, tint]. Absent = off. */
    aerialHaze?: [number, number, number, number];
    /** HARD FOG EDGE (2026-10-01): only the plain fog draws + the city leaves the fog alone. Absent = off. */
    fogHardEdge?: boolean;
    /** FOG HORIZON (docs/specs/fog-horizon.md): only the fields that differ from the defaults. Absent = the defaults. */
    fogHorizon?: Partial<import('../../renderer/3d/fog-horizon').FogHorizonSettings>;
    /** Screen-space EDGE outline (enableOutlines3D) — null/absent = off. Wasn't persisted before 2026-09-28. */
    edgeOutlines?: { color: [number, number, number, number]; threshold: number; depthFade?: { near: number; far: number; minAlpha: number } } | null;
    /** 3D ANTI-ALIASING (persona-polish A1): post FXAA on the 3D frame. Absent (older saves) = the default, FXAA medium. */
    antiAliasing?: import('../../renderer/3d/fxaa-pass').AntiAliasingSettings;
    /** PARTICLE bloom ("Bloom Glow", enableBloom3D) — null/absent = off. Wasn't persisted before 2026-09-28. */
    particleBloom?: { threshold: number; intensity: number } | null;
    /** Script Behaviors (docs/specs/script-behaviors.md) — custom per-node game logic sources. Optional; absent in old
     *  saves → none. Only the source persists (runtime state resets each Play). */
    scriptBehaviors?: ScriptBehavior[];
    /** View state — target (illustration|scene) × camera mode (ortho2D|perspective2D|free3D) + camera poses.
     *  Optional for back-compat: older saves have no viewState → load as illustration/ortho2D. See view-state.ts. */
    viewState?:    ViewState;
    /** Animation Library — reusable cross-skeleton clips/poses. Optional; absent in old saves.
     *  See docs/specs/animation-library-and-triggers.md + animation-library.ts. */
    animationLibrary?: AnimationLibraryData;
    /** Provenance links: which GLOBAL Shared Asset Library assets this document instantiated (for update-detection).
     *  See asset-reference-store.ts + docs/specs/shared-asset-library.md §2.3. Optional. */
    assetReferences?: DocumentAssetReference[];
    /** Play-mode Player binding + locomotion set (so a game's avatar + walk survive reload). Optional. */
    /** Play settings (polish-round-3 T5): first-person eye height + auto default character. Absent = defaults. */
    play?: PlaySettingsState;
    player?: { meshId?: string | null; locomotionSet?: { idle?: string; walk?: string; run?: string; jump?: string; fall?: string } | null; locomotionBlend?: LocomotionBlendConfig | null; overlay?: { clip: string; region: RegionMask; mode?: 'replace' | 'additive'; weight?: number } | null };
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
    /** A PROCEDURAL blink frame (eyeParams with closed:true — what auto-blink makes) follows the ACTIVE expression's
     *  eyes: re-drawn closed whenever they're edited or the state changes, so e.g. deco dots turned off in Neutral
     *  don't flash back during a blink. Default true. `false` = the blink frame keeps its own settings. Hand-drawn
     *  blink frames are never touched. */
    followOpenEyes?: boolean;
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
    /** FACE KIT (face-features.ts): brows / mouth / nose / shading params — the overlays regenerate from these on load
     *  (no texture is saved). ABSENT on faces saved before the kit: those load exactly as before (eyes only) until the
     *  user turns the kit on (setFaceFeatures3D). */
    features?: import('./face-features').FaceFeatureParams;
}

// HairRig / ClothingRig / AttachmentRig now live in the character subsystem (scene3d-character.ts).

const _nanoid = () => Math.random().toString(36).slice(2, 10);
/** City character-preview ghost: minimum ms between view-ray spawn casts while the camera moves (see _ghostPreviewOrigin). */
const GHOST_SPAWN_RECAST_MS = 120;

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

/** PLAY CHARACTER OUTLINES on a settings restore (visual-polish item 10). The key is always saved since it existed, so:
 *  present → its value; a FULL document save from before it (it carries the always-written characterOutlines /
 *  viewState keys) → off, so old documents play as they did; anything else (a partial lighting patch, a new / empty
 *  document) → unchanged (the session default is on). Pure. */
export function playCharacterOutlinesOnRestore(s: Partial<GlobalScene3DSettings>, current: boolean): boolean {
    if ('playCharacterOutlines' in s) return s.playCharacterOutlines === true;
    if ('characterOutlines' in s || 'viewState' in s) return false;
    return current;
}

/** Validate saved submesh slots against a mesh's restored index count (audit P8). Returns the typed clones, or null
 *  when ANY slot is out of range — a save whose geometry no longer matches must not draw garbage index ranges. */
export function validSavedSubmeshes(saved: unknown, indexCount: number): Submesh3D[] | null {
    if (!Array.isArray(saved) || saved.length === 0) return null;
    const ok = saved.every((s) => s && typeof s === 'object'
        && Number.isInteger((s as Submesh3D).indexOffset) && Number.isInteger((s as Submesh3D).indexCount)
        && (s as Submesh3D).indexOffset >= 0 && (s as Submesh3D).indexCount > 0
        && (s as Submesh3D).indexOffset + (s as Submesh3D).indexCount <= indexCount
        && (s as Submesh3D).material && typeof (s as Submesh3D).material === 'object');
    return ok ? (saved as Submesh3D[]).map(cloneSubmesh3D) : null;
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
    /** True on a VIRTUAL "Character" grouping node — a display-only wrapper (type '3DMeshGroup') whose `id` is the
     *  character's BODY mesh and whose `children` are its parts (eyes/hair/garments/attachments). The scene graph is
     *  still flat, so whole-character ops (hide/delete/select all) should fan out via `characterPartIds3D(id)`. */
    character?: boolean;
}

/** Step 3 scene budgets (Scene3DManager.getSceneBudget3D; scene-budget.ts). 0 = no limit. */
export type SceneBudgetLimits3D = SceneBudgetLimits;
export interface SceneBudget3D {
    drawnTris: number; drawCalls: number; geometryMB: number; instances: number; meshes: number; mainTris: number; shadowTris: number;
    limits: SceneBudgetLimits3D;
    over: Array<{ key: keyof SceneBudgetLimits3D; value: number; limit: number; ratio: number }>;
    ok: boolean;
    /** One line for a HUD ("Over budget: 6.1 M tris (3.0 M tris), 3.4 k draws (2.0 k draws)"), null when within. */
    warning: string | null;
}

/** One layer of addFlatColorMeshGroup (a world-built flat-colour layer). */
export type FlatColorLayer3D = { name: string; geometry: MeshGeometry; color: [number, number, number]; pattern?: { color: [number, number, number]; freq: number; scale?: number; mode?: 'stripes' | 'dots' | 'diamonds' | 'checker' | 'grid' | 'windows' | 'waves'; angle?: number; spacing?: number }; ground?: { surface: GroundSurfaceName; tint?: [number, number, number]; tileMm?: number; groutMm?: number; jitter?: number; metersPerUnit?: number; weather?: 'new' | 'worn' | 'ancient' | 'mossy' | 'dirty' }; castShadow?: boolean; water?: { deep?: [number, number, number]; shallow?: [number, number, number]; waveScale?: number; waveSpeed?: number; choppy?: number; glitter?: number }; emissive?: number; opacity?: number; instanceKey?: string; excludeFromFrame?: boolean; singleSided?: boolean; metal?: { tint?: [number, number, number]; streak?: [number, number, number]; roughness?: number; streakAmount?: number; grime?: number; scale?: number }; neon?: { glow?: [number, number, number]; accent?: [number, number, number]; scanDensity?: number; flicker?: number; scroll?: number; phase?: number }; leafCard?: boolean; glass?: boolean; radialFade?: boolean; noFog?: boolean | 'hardEdge'; outlineRanges?: { id: number; start: number; count: number }[]; reflect?: { strength?: number; roughness?: number }; renderStyle?: 'cel' | 'cel-hd' | 'sketch' | 'ink' | 'gouraud'; rim?: boolean; wind?: FoliageWindSpec; foliageShade?: FoliageShadeSpec; instances?: { x: number; y: number; z: number; ry: number; s?: number; tint?: [number, number, number]; skin?: string; sv?: [number, number, number]; cs?: [number, number, number]; pi?: number }[]; arrayGroup?: boolean; propInst?: boolean; propXf?: Float32Array; garp?: { pool: string; slot: string; seed: number; skin?: string }; groundUvSample?: MeshGeometry; nearTwin?: { key: string; role: 'near' | 'far' | 'mid' | 'xfar'; dist: number; dist2?: number; uvFromNear?: boolean }; crowdInst?: { id: string } };

/**
 * Ortho framing: the half-HEIGHT a view needs to show a dx × dy × dz box (centred) from `viewDir` (target → eye), i.e.
 * the box's extent ON SCREEN — its 8 corners on the camera's right / up axes — with the width fitted through `aspect`.
 * A straight-on view (e.g. from +Z) gives exactly max(dy / 2, dx / 2 / aspect) as before; an oblique one (the Edit
 * Mesh 3/4 entry view) fits the box's real silhouette instead of overflowing it. A view along `up` falls back to dx / dy.
 */
export function orthoFitHalfHeight(
    dx: number, dy: number, dz: number,
    viewDir: ArrayLike<number>, up: ArrayLike<number>, aspect: number,
): number {
    let halfW = dx * 0.5, halfV = dy * 0.5;
    const fwd = vec3.fromValues(-viewDir[0], -viewDir[1], -viewDir[2]);
    const right = vec3.cross(vec3.create(), fwd, vec3.fromValues(up[0], up[1], up[2]));
    if (vec3.length(right) > 1e-6) {
        vec3.normalize(right, right);
        const upv = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), right, fwd));
        halfW = 0; halfV = 0;
        for (let c = 0; c < 8; c++) {
            const ox = (c & 1 ? 0.5 : -0.5) * dx, oy = (c & 2 ? 0.5 : -0.5) * dy, oz = (c & 4 ? 0.5 : -0.5) * dz;
            halfW = Math.max(halfW, Math.abs(ox * right[0] + oy * right[1] + oz * right[2]));
            halfV = Math.max(halfV, Math.abs(ox * upv[0] + oy * upv[1] + oz * upv[2]));
        }
    }
    return Math.max(halfV, halfW / Math.max(0.0001, aspect));
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
    /** Procedural idle: bodyMeshId → the captured base pose + time origin. Drives breathing / weight-shift / sway. */
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
    /** The draw / erase pointer state machine while draw mode is on (gp-draw-gesture.ts). */
    private _gpGesture: GpDrawGesture | null = null;
    /** The gesture in progress: what it edits and the stroke list before it (its undo step). */
    private _gpGestureEdit: {
        gpId: string; layerId: string; frame: number | undefined; erase: boolean; before: GpStroke3D[];
        /** Surface placement: projects this stroke's samples onto its target mesh. */
        placer?: GpSurfacePlacer;
        /** Partial erase: the previous eraser sample (client px) — the path between samples is erased too. */
        lastErase?: { x: number; y: number };
    } | null = null;
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
    /** Where a stroke goes: ONTO the mesh under the pen ('surface', default) or on the flat sheet in front of the
     *  tapped face ('sheet'). */
    private _gpDrawPlacement: 'surface' | 'sheet' = 'surface';
    /** Surface placement: how far (world units) points are lifted off the surface along its normal. */
    private _gpSurfaceOffset = 0.01;
    /** The eraser: 'partial' cuts away only what is under it (strokes split), 'stroke' removes whole strokes. */
    private _gpDrawEraseMode: 'partial' | 'stroke' = 'partial';
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

    // Animation playback + NLA (extracted subsystem — audit C4 Slice A, scene3d-animation.ts)
    private _animation!: Scene3DAnimation;
    /** The animation subsystem, for DIRECT ShapeManager forwards of new animation APIs (audit A1: no new middle hop). */
    get animation(): Scene3DAnimation { return this._animation; }
    /** The Environment style value (persisted in the global scene settings; ShapeManager applies it). */
    private _environmentStyle: import('./object-style').ObjectStyle | undefined = undefined;
    get environmentStyle(): import('./object-style').ObjectStyle | undefined { return this._environmentStyle; }
    set environmentStyle(s: import('./object-style').ObjectStyle | undefined) { this._environmentStyle = s; }
    /** COLOURED cast shadows: the hue of the shadow floor (null = neutral grey). Persists with the document. */
    setShadowTint3D(c: [number, number, number] | null): void { this.renderer3D.setShadowTint(c); this.ctx.scheduleRender(); }
    getShadowTint3D(): [number, number, number] | null { return this.renderer3D.shadowTint; }
    /** HEIGHT FOG (city-quality P9): ground-hugging haze riding the distance fog. density 0 = off. */
    setHeightFog3D(density: number, baseY = 0, falloff = 1, reach = 0.05): void { this.renderer3D.setHeightFog(density, baseY, falloff, reach); this.ctx.scheduleRender(); }
    /** AERIAL PERSPECTIVE (persona-polish A5): contrast fade + horizon tint with distance. `strength` 0..1 (0 = off),
     *  `reach` = world distance for ~63 % build-up, `contrast` / `tint` shares 0..1. Needs fog on. Global, persisted. */
    setAerialHaze3D(strength: number, reach = 20, contrast = 0.6, tint = 0.5): void { this.renderer3D.setAerialHaze(strength, reach, contrast, tint); this.ctx.scheduleRender(); }
    get aerialHaze3D(): [number, number, number, number] { return this.renderer3D.aerialHaze; }
    getHeightFog3D(): [number, number, number, number] { return this.renderer3D.heightFog; }
    /** The materials sub-module (render style, patterns, retro-colour opt-in) — ShapeManager forwards to it directly. */
    get materials(): Scene3DMaterials { return this._materials; }

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

    // Rest-pose snapshot captured at first FLA application (oscillating types only).
    // Cleared whenever FLA is set or removed so the next frame re-captures the current pose.

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

    // Kitbash library + character assembly + baked parts + spawn spin (extracted subsystem — audit C5)
    private _kitbash!: Scene3DKitbash;

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
        this.playSettings.onChange = () => this._applyPlaySettingsLive();   // live eye height / auto-player toggle
        this._particles = new Scene3DParticles(ctx, (cmd) => this._undoManager.push(cmd));   // emitter delete = one undo step
        this._gp = new Scene3DGreasePencil(ctx);
        this._blendShapes = new Scene3DBlendShapes(ctx, { getMesh: (id) => this.getMesh(id),
            patchVertices: (m, start, count) => this.patchMeshVertices3D(m, start, count) });   // Character v2 Phase 1.5
        this._cloth = new Scene3DCloth(ctx, {
            getMesh: (id) => this.getMesh(id),
            getFrameLinkAnim: (id) => this._animation.frameLinkAnims.get(id) ?? null,
        });
        this._ribbons = new Scene3DRibbons(ctx, {
            createRibbonMesh: (x, y, z, geometry, material) => this.createMesh(x, y, z, { primitive: 'custom', geometry, material }),
            getMesh: (id) => this.getMesh(id),
            getFrameLinkAnim: (id) => this._animation.frameLinkAnims.get(id) ?? null,
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
            isPlaying: () => this._playing,
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
        this._animation = new Scene3DAnimation(ctx, {
            getSkeleton: (id) => this.getSkeleton(id),
            keepSpringsAlive: (skelId, ms) => this._keepSpringsAlive(skelId, ms),
            applyAllKeyframesAtFrame: (frame) => this.applyAllKeyframesAtFrame(frame),
            isBoneOverlayActive: () => this._armature.isBoneOverlayActive(),
            setIdleLiveHold: (on) => { this._idleHeldLive = on; this._syncCohortLiveLoop(); },
            isSkeletonAnimCulled: (skelId) => this.renderer3D.isSkeletonAnimCulled3D(skelId),
            simLodBegin: (system) => this.simLod.counter(system).begin(),
            simLodDue: (skelId, bodyMeshId) => this.simLodDue('characters', skelId, bodyMeshId),
            isSkeletonPlayDriven: (skelId) => this._isSkeletonPlayDriven(skelId),
            // Slice D (default anims + pose library) hooks:
            getMesh: (id) => this.getMesh(id),
            getAllMeshes: () => this.getAllMeshes(),
            getBodyParams: (bodyMeshId) => this.getBodyParams(bodyMeshId),
            clearArmsForSkeleton: (skel) => this.clearArmsForSkeleton(skel),
            clipFaceEvent: (skel, ev) => this._clipFaceEvent(skel, ev),
            getBoneOverlaySkeletonId: () => this.getBoneOverlaySkeletonId(),
            findClip: (clipId) => this._findClip(clipId),
            startScrollAnimation: (meshId) => this._ribbons.startScrollAnimation(meshId),
            clearScrollFrames: (meshId) => this._ribbons.clearScrollFrames(meshId),
        });
        this._kitbash = new Scene3DKitbash(ctx, {
            getMesh: (id) => this.getMesh(id),
            getSkeleton: (id) => this.getSkeleton(id),
            createSkeletonFromResult: (r) => this._createSkeletonFromResult(r),
            createSkinnedMeshForSlot: (r, skel, ox, oy, oz, def, slot) => this._createSkinnedMeshForSlot(r, skel, ox, oy, oz, def, slot),
            getModelStore: () => this._modelStore,
            pushUndo: (cmd) => this._undoManager.push(cmd),
            getPicker: () => this._picker,
            getRenderer3D: () => this.renderer3D,
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
            get isPlaying() { return self._playing; },
            get freeView3D() { return self._viewState?.cameraMode === 'free3D'; },   // (= deriveViewRules().freeNavigation, no alloc per frame)
            get gpDrawActive() { return self._gpDrawActive; },
            get autoKey3D() { return self.autoKey3D; },
            flaRestTransforms: this._animation.flaRestTransforms,
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
            ensureIdleCallback: () => this._animation.ensureIdleCallback(),
            springsActiveFor: (skelId, now) => this._springsActiveFor(skelId, now),
            simLodBegin: (system) => this.simLod.counter(system).begin(),
            simLodSpringsDue: (skelId) => this.simLodDue('springs', skelId, null),
            syncFocusBgLiveLoop: () => this._syncFocusBgLiveLoop(),
        });
        // TOUCH-3: a touch double-tap frames the tapped mesh, or everything (docs/ui/touch-controls.md).
        this._armature.touchDoubleTapHandler = (cx, cy) => { this.frameAtClient3D(cx, cy); };
        // Sync each procedural character's skeleton object-transform from its body mesh's transform
        // every frame, so the gizmo (which moves the body mesh) carries the skeleton + bones with it.
        this.ctx.webgpuRenderer.addPreRenderCallback(() => this._syncCharacterSkeletons(), 'characterSkeletonSync');
        // Keep the selected camera-node's frustum wireframe in sync as you place/aim it (cinematic cameras).
        this.ctx.webgpuRenderer.addPreRenderCallback(() => this._refreshCameraFrustum(), 'cameraFrustum');
        // ★ Keep the on-demand loop alive whenever an ANIMATED focus background ('wavy') is showing, so it animates
        // continuously instead of freezing when idle (only ticking on mouse-move). Self-evaluating each frame — robust
        // vs. the older begin/endInteractive hold in _syncFocusBgLiveLoop, which depended on EVERY enter/exit path
        // calling it and on the interactive count never desyncing (the mesh-edit "bg freezes when I stop orbiting" bug).
        this.ctx.webgpuRenderer.addPreRenderCallback(() => {
            const r = this.renderer3D;
            // 'wavy' on the focus bg showing (armature OR mesh edit — the same rule for both), unless frozen by the
            // host's switch (setFocusBgAnimate3D) or, when unset, this machine's caps (mobile: a still frame)
            return r.focusBgAnimating;
        });
        // ★ Same on-demand keep-alive for the ANIMATED hover outline. Its scrolling-pattern phase is read from
        // performance.now() each frame, so it freezes the instant frames stop scheduling — i.e. when the pointer
        // hovers a mesh but stops moving. Hold the loop live while an animated outline is actually on screen.
        this.ctx.webgpuRenderer.addPreRenderCallback(() => this.renderer3D.hoverOutlineActive, 'hoverOutline');
        // Same for a persistent per-object outline that SCROLLS (patternMode + speed): its phase reads scene time,
        // so keep frames flowing while any assigned outline animates.
        this.ctx.webgpuRenderer.addPreRenderCallback(() => this.renderer3D.hasAnimatedOutline, 'animatedOutline');
        // ★ Keep the loop alive while a TIME-ANIMATED material (water / neon) is visible. Their shader
        // phase advances with scene time, so with no other driver (e.g. no city traffic) they'd freeze until a
        // mouse-move. Throttled scan (≤5×/sec, cached between) so it's cheap even in a large scene.
        this.ctx.webgpuRenderer.addPreRenderCallback(() => this._animatedMaterialVisible(), 'animatedMaterial');
        // SIM LOD (src/world/sim-lod.ts): refresh the frame's view facts (camera, view-projection, fog eye + fog-horizon
        // cull distance) once per rendered frame, before the systems that band their updates by them.
        this.ctx.webgpuRenderer.addPreRenderCallback(() => { this._refreshSimLodView(); return false; }, 'simLod');
    }

    // ── SIM LOD (engine-roadmap step 1, performance-plan §P13) ──────────────────────────────────────────────────
    /** The simulation-LOD state shared by every simulated system (traffic, crowd, character idles, springs): the
     *  settings (the A/B switch + distance bands), this frame's view, the per-system counters. ShapeManager's
     *  getSimLodStats3D / the world LOD settings' `sim` group read and write it. */
    readonly simLod = new SimLod();
    private readonly _simSlots = new Map<string, SimSlot>();
    private readonly _simFogEye = new Float64Array(3);
    private _simSkelBodyVer = -1;
    private readonly _simSkelBody = new Map<string, string>();
    private _refreshSimLodView(): void {
        const L = this.simLod;
        if (!L.enabled) return;
        const cam = this.renderer3D.getCamera(), v = L.view;
        v.cam[0] = cam.position[0]; v.cam[1] = cam.position[1]; v.cam[2] = cam.position[2];
        v.vp = cam.getViewProjectionMatrix() as unknown as ArrayLike<number>;
        computeFogEye(cam, this._simFogEye);
        v.fogEye[0] = this._simFogEye[0]; v.fogEye[1] = this._simFogEye[1]; v.fogEye[2] = this._simFogEye[2];
        v.fogEdge = L.settings.fogFreeze ? this.renderer3D.simFogEdge : Infinity;
        // anti-stutter scale: pixels per world unit at unit distance (perspective) or everywhere (ortho)
        const h = (this.ctx.webgpuRenderer.getCanvas() as { height?: number } | null)?.height ?? 0;
        v.ortho = cam.mode === 'orthographic';
        v.pxPerUnit = h > 0 ? (v.ortho ? h / Math.max(1e-6, 2 * cam.orthoSize) : h / (2 * Math.tan(cam.fov / 2))) : 0;
    }
    /** Never throttled: the Play player, the selection, a skeleton being posed, a script behaviour's target, and any
     *  character while a timeline / clip preview plays (the user is watching it animate). */
    private _simLodExempt(skelId: string, bodyMeshId: string | null): boolean {
        const body = bodyMeshId ? this.getMesh(bodyMeshId) : null;
        if (this._playing && body && this._isPlayerPart(body)) return true;
        if (this._playing && skelId === this._playerSkeletonId()) return true;
        if (bodyMeshId && this.renderer3D.getSelectedMeshIds().has(bodyMeshId)) return true;
        if (this._armature.isBoneOverlayActive() && this._armature.getBoneOverlaySkeletonId() === skelId) return true;
        if (bodyMeshId && this._scriptManager.size > 0 && this._scriptManager.has(bodyMeshId)) return true;
        if (this._animation.hasActivePlayback()) return true;
        return false;
    }
    /** The body mesh driving a skeleton (cached per scene-structure version). */
    private _simBodyOf(skelId: string): string | null {
        const sv = this.ctx.sceneStructureVersion();
        if (sv !== this._simSkelBodyVer) {
            this._simSkelBodyVer = sv; this._simSkelBody.clear();
            for (const m of this.getAllMeshes()) if (m instanceof SkinnedMesh3D && m.skeletonId && (m.isProceduralBody || m.transformViaSkeleton) && !this._simSkelBody.has(m.skeletonId)) this._simSkelBody.set(m.skeletonId, m.id);
        }
        return this._simSkelBody.get(skelId) ?? null;
    }
    /**
     * SIM LOD for a character: should `system` ('characters' = the procedural idle, 'springs' = the spring-bone solve)
     * update this skeleton this frame? Banded by the body's world box from the last skinned cull (its centre and
     * half-diagonal). Springs run only in the NEAR band (a 10 Hz spring solve would jitter): the caller resets them
     * when they resume. With sim LOD off: always true.
     */
    simLodDue(system: 'characters' | 'springs', skelId: string, bodyMeshId: string | null): boolean {
        const L = this.simLod;
        if (!L.enabled) return true;
        const key = system + ':' + skelId;
        let slot = this._simSlots.get(key);
        if (!slot) { slot = newSimSlot(); this._simSlots.set(key, slot); }
        const counter = L.counter(system);
        const body = bodyMeshId ?? this._simBodyOf(skelId);
        if (this._simLodExempt(skelId, body)) { slot.band = SIM_NEAR; counter.count(SIM_NEAR, true); return true; }
        let x: number, y: number, z: number, r = 0;
        const box = body ? this.renderer3D.skinnedBoxOf(body) : null;
        if (box) {
            x = (box[0] + box[3]) / 2; y = (box[1] + box[4]) / 2; z = (box[2] + box[5]) / 2;
            r = 0.5 * Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
        } else {
            const skel = this.getSkeleton(skelId), t = skel?.objectTransform as unknown as ArrayLike<number> | undefined;
            if (!t) { counter.count(SIM_NEAR, true); return true; }
            x = t[12]; y = t[13]; z = t[14];
        }
        let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        const due = L.step(counter, slot, performance.now() / 1000, (h % 1000) / 1000, x, y, z, r);
        return system === 'springs' ? due && slot.band === SIM_NEAR : due;
    }

    private _animMatCache = false;
    private _animMatLastScan = 0;
    /** Whether any visible mesh carries a time-animated material (throttled ≤5×/sec). */
    private _animatedMaterialVisible(): boolean {
        const now = performance.now();
        if (now - this._animMatLastScan > 200) {
            this._animMatLastScan = now;
            this._animMatCache = this.getAllMeshes().some(m => {
                const mt = m.material as Partial<Material3D> | undefined;
                return !!(mt?.waterShade || mt?.neonShade);
            });
        }
        return this._animMatCache;
    }

    /** body meshId → last localMatrixVersion synced to its skeleton.objectTransform (cheap change check). */
    private _charSkelSyncVer = new Map<string, number>();
    private _charSkelHasBodies = false;    // per-structure-version memo: any procedural bodies in the scene at all?
    private _charSkelStructVer = -1;
    private _charSkinned: SkinnedMesh3D[] | null = null;   // Step 2: the skinned meshes of this structure version
    /** Step 2 A/B switches for the scene-manager side (all on by default; sm.setFrameScanOptions3D). */
    static readonly STEP2 = { cachedSkeletonSync: true, cachedRenderStats: true, iterativeSceneWalk: true };
    /** Step 3 A/B switches for the scene-manager side (all on by default; sm.setStep3Options3D):
     *  - cachedGroupBounds: cacheGroupBounds folds cached per-geometry boxes (group-bounds.ts) instead of every vertex;
     *  - collisionCells: Play collision rays inside a ready collision cell test its merged BVH (collision-cells.ts). */
    static readonly STEP3 = { cachedGroupBounds: true, collisionCells: true };
    /** Step 3b A/B switches (all on by default; sm.setStep3Options3D):
     *  - incrementalCollisionGrid: the Play collision broadphase follows structure changes incrementally
     *    (collision-snapshot.ts: only attached / detached / moved meshes are touched) instead of a full rebuild. */
    static readonly STEP3B = { incrementalCollisionGrid: true };
    /** Mirror each procedural body's transform onto its skeleton's objectTransform (matrix copy) so the
     *  skeleton + bones follow the character gizmo. Re-FKs only when the body's transform changed. */
    private _syncCharacterSkeletons(): boolean {
        // Structure-version-gated: a pure-city scene (no characters) paid a full O(meshes) instanceof scan EVERY
        // frame for nothing. Re-scan for bodies only when the scene structure changes; skip entirely when none.
        const sv = this.ctx.sceneStructureVersion();
        // Step 2 (performance-plan §P13): the two per-frame passes below walked getAllMeshes() (~11.5 k meshes in a
        // tiled world, instanceof each) every frame a character existed. The skinned meshes are now listed once per
        // structure version (same order: a filter of getAllMeshes) and the passes loop over those alone.
        const cached = Scene3DManager.STEP2.cachedSkeletonSync;
        if (sv !== this._charSkelStructVer || (cached && !this._charSkinned) || (!cached && this._charSkinned)) {
            this._charSkelStructVer = sv;
            const skinned = this.getAllMeshes().filter((m): m is SkinnedMesh3D => m instanceof SkinnedMesh3D);
            this._charSkinned = cached ? skinned : null;
            // A skinned mesh whose OWN transform drives its skeleton: a procedural humanoid body, OR any mesh
            // that owns a skeleton via transformViaSkeleton (a bound creature/prop). Attachments (clothing/hair/
            // charms/decals) also set transformViaSkeleton but RIDE a body-driven skeleton — excluded below.
            this._charSkelHasBodies = skinned.some(m => (m.isProceduralBody || m.transformViaSkeleton) && !!m.skeleton);
        }
        if (!this._charSkelHasBodies) return false;
        const list: readonly Mesh3D[] = this._charSkinned ?? this.getAllMeshes();
        // Pass 1: skeletons already driven by a procedural body — their attachments must NOT fight them.
        const bodyDriven = new Set<string>();
        for (const m of list) if (m instanceof SkinnedMesh3D && m.isProceduralBody && m.skeletonId) bodyDriven.add(m.skeletonId);
        let changed = false;
        for (const m of list) {
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

    // ── Procedural idle — extracted (scene3d-animation.ts Slice C); delegate. The live-loop COHORT
    // (idle + focus-bg holds) stays HERE: the subsystem flips its half via the setIdleLiveHold hook. ──

    setIdleAnimation(bodyMeshId: string, on: boolean, intensity = 1): void { this._animation.setIdleAnimation(bodyMeshId, on, intensity); }
    /** Whether a body currently has the idle animation running. */
    isIdleAnimating(bodyMeshId: string): boolean { return this._animation.isIdleAnimating(bodyMeshId); }
    /** Pause / resume every procedural idle for `reason` (nests by reason; see Scene3DAnimation.setIdleAnimationPaused). */
    setIdleAnimationPaused(reason: string, paused: boolean): void { this._animation.setIdleAnimationPaused(reason, paused); }
    isIdleAnimationPaused(): boolean { return this._animation.isIdleAnimationPaused(); }

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
        const need = r.meshEditBgAnimating;   // 'wavy' and animated on this machine (mobile caps freeze it — 7.3b P3)
        if (need === this._focusBgHeldLive) return;   // no change (keeps begin/endInteractive balanced)
        this._focusBgHeldLive = need;
        if (need) this.ctx.interactionService.beginInteractive();
        else this.ctx.interactionService.endInteractive();
        this._syncCohortLiveLoop();
        this.ctx.scheduleRender();
    }

    /** Set a character's leg idle fidelity ('fk' default / 'ik' pinned feet / 'none'). */
    setLegIdleMode(bodyMeshId: string, mode: _LegIdleMode): void { this._animation.setLegIdleMode(bodyMeshId, mode); }
    /** A character's current leg idle fidelity (default 'fk'). */
    getLegIdleMode(bodyMeshId: string): _LegIdleMode { return this._animation.getLegIdleMode(bodyMeshId); }
    /** Configure random IDLE BREAKS (one-shot personality clips between the base idle). */
    setIdleBreaks(bodyMeshId: string, opts: { enabled?: boolean; minSec?: number; maxSec?: number; clips?: string[] }): void { this._animation.setIdleBreaks(bodyMeshId, opts); }
    /** Toggle procedural SQUASH & STRETCH (volume-preserving torso scale; layers on idle + breaks). */
    setSquashStretch(bodyMeshId: string, opts: { enabled?: boolean; intensity?: number }): void { this._animation.setSquashStretch(bodyMeshId, opts); }

    private get renderer3D(): Renderer3D { return this.ctx.webgpuRenderer.getRenderer3D(); }

    // ── Undo / Redo ──────────────────────────────────────────────────

    get canUndo3D(): boolean { return this._undoManager.canUndo; }
    get canRedo3D(): boolean { return this._undoManager.canRedo; }
    get undoDescription3D(): string | null { return this._undoManager.undoDescription; }
    get redoDescription3D(): string | null { return this._undoManager.redoDescription; }

    undo3D(): boolean {
        if (this._playing) return false;   // Round 8: editor history never runs under a live Play session
        const ok = this._undoManager.undo();
        if (ok) this.ctx.scheduleRender();
        return ok;
    }

    redo3D(): boolean {
        if (this._playing) return false;
        const ok = this._undoManager.redo();
        if (ok) this.ctx.scheduleRender();
        return ok;
    }

    clearUndo3D(): void { this._undoManager.clear(); }
    pushCommand3D(cmd: import('./undo-manager-3d').Command3D): void { this._undoManager.push(cmd); }
    /** The 3D undo step that undo3D would revert next (null when none). */
    peekUndoCommand3D(): import('./undo-manager-3d').Command3D | null { return this._undoManager.peekUndo(); }
    /** Drop the top 3D undo step without running its undo (the caller restored the state) — UndoManager3D.discardUndoTop. */
    discardUndoTop3D(): boolean { return this._undoManager.discardUndoTop(); }

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

    /** Tell the host renderer that mesh VISIBILITY flipped hidden → shown by a direct `visible = true` write (zoom LOD,
     *  chat emotes, a walker leaving a building). The host's render list is rebuilt only on a structure change or a 2D
     *  pan and filters `visible` when it rebuilds, so a node that was hidden at the last rebuild stays out of the draw
     *  list after it is shown — the static crowd + walkers never appeared after zooming in (headless shots, orbit-only
     *  sessions). This marks the list dirty (the cheap viewport re-filter, not a tree re-walk) and schedules a frame. */
    notifyVisibilityChanged3D(): void { this.ctx.interactionService.requestBackgroundRender(); this.ctx.scheduleRender(); }

    /** Tell the host the 3D hierarchy changed so it re-reads getScene3DHierarchy (outliner refresh). Use after
     *  a batch of SILENT mutations (e.g. async city staging, exiting City mode) that skipped their own emit. */
    notifySceneGraphChanged3D(): void { this.ctx.emitSceneGraphChanged(); }
    /** QUIET structural change (engine-internal node churn inside the City container — the live crowd): the mesh-list
     *  caches re-walk + the render list re-filters, but the host's onSceneGraphChanged (outliner, connectors) does NOT
     *  fire. Falls back to the full notification on a host without the quiet bump. */
    notifySceneStructureChanged3D(): void {
        const r = this.ctx.webgpuRenderer as unknown as { markStructureDirty?: () => void } | undefined;
        if (this.ctx.bumpSceneStructure && r?.markStructureDirty) { this.ctx.bumpSceneStructure(); r.markStructureDirty(); }
        else this.ctx.emitSceneGraphChanged();
    }

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
    /** P14 shadow quality presets: the far map's refresh interval = the scene's own × `k` (1 = unchanged). */
    setShadowIntervalScale3D(k: number): void { this.renderer3D.setShadowIntervalScale(k); }
    /** P14: the far shadow map's resolution (keeps its box; no-op while shadows are off). */
    setShadowMapSize3D(size: number): void { this.renderer3D.setShadowMapSize(size); this.ctx.scheduleRender(); }
    get shadowMapSize3D(): number { return this.renderer3D.shadowMapSize; }
    /** 3D ANTI-ALIASING (persona-polish A1): `{ mode: 'fxaa' | 'off', quality: 'low' | 'medium' | 'high' }` (partial OK).
     *  Default FXAA medium. Global scene setting (persisted with the document). */
    setAntiAliasing3D(s: Partial<import('../../renderer/3d/fxaa-pass').AntiAliasingSettings>): void { this.renderer3D.setAntiAliasing(s); this.ctx.scheduleRender(); }
    get antiAliasing3D(): import('../../renderer/3d/fxaa-pass').AntiAliasingSettings { return this.renderer3D.antiAliasing; }
    /** CASCADED SHADOWS (persona-polish A2), partial OK: `{ cascades: 1 | 2 | 3, nearExtent (world units, 0 = auto),
     *  mapSize, blend, updateInterval }`. 1 = the original single map (default outside a city). Global scene setting. */
    setShadowCascades3D(s: Partial<import('../../renderer/3d/shadow-cascades').ShadowCascadeSettings>): void { this.renderer3D.setShadowCascades(s); this.ctx.scheduleRender(); }
    get shadowCascades3D(): import('../../renderer/3d/shadow-cascades').ShadowCascadeSettings { return this.renderer3D.shadowCascades; }
    /** Dynamic-resolution render scale (<1 = lo-res + linear upscale while the camera pans; 1 = native). */
    setDynamicResScale3D(s: number): void { this.renderer3D.setDynamicResScale(s); }
    /** Step 2 (C): what the camera-motion resolution drop needs — the resolution setting, the smoothed GPU ms and its
     *  source, whether Play runs, and the motion scale in force now. `leaseMs` keeps GPU timing on (Play 'auto'). */
    getMotionResolutionContext3D(leaseMs = 0): { settings: ResolutionScaleState; playing: boolean; engaged: number } {
        const wr = this.ctx.webgpuRenderer as unknown as { getResolutionScale?: () => ResolutionScaleState; leaseGpuTiming?: (ms: number) => void } | undefined;
        if (leaseMs > 0) wr?.leaseGpuTiming?.(leaseMs);
        const settings = wr?.getResolutionScale?.() ?? { ...DEFAULT_RESOLUTION_SCALE, current: 1, gpuMs: null, timing: 'estimate' as const };
        return { settings, playing: this._playing, engaged: this.renderer3D.motionResolutionScale };
    }
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

    // ── Persistent per-object outlines ─────────────────────────────────
    /** Default outline look (opaque black, thin, flat — no pattern). Callers pass a Partial to override. */
    private static readonly DEFAULT_OUTLINE: HighlightStyle = { color: [0, 0, 0, 1], width: 0.03, thicknessPx: 6, patternMode: 0, patternColor: [1, 1, 1], freq: 20, speed: 0, glow: 1 };
    /** Assign (or clear with null) a PERSISTENT outline on a mesh — its own colour + optional scrolling pattern
     *  (patternMode 1 stripes / 2 dots / 3 checker, secondary = patternColor, speed = scroll). Stored on the mesh
     *  (persists) and mirrored into the renderer's runtime cache. v1: regular meshes (not skinned characters). */
    /** Persistent outline (+ stacked rings) from a saved mesh state → the mesh + the renderer's draw cache. */
    private _restoreOutline(mesh: Mesh3D, state: { outline?: HighlightStyle | null; outlineRings?: HighlightStyle[] | null }): void {
        mesh.outline = state.outline ?? null;
        mesh.outlineRings = Array.isArray(state.outlineRings) && state.outlineRings.length ? state.outlineRings : null;
        this.renderer3D.setMeshOutline(mesh.id, mesh.outline, mesh.outlineRings);
    }
    /** Which mesh OWNS the outline for `meshId`: a character part (hair / garment / charm — a skinned mesh riding a
     *  procedural body's skeleton) → that BODY. A character is outlined as one silhouette anyway, and its parts are
     *  rebuilt from params on every reload / slider change, so an outline stored on a part was silently lost. */
    private _outlineOwnerId(meshId: string): string {
        const m = this.getMesh(meshId);
        if (!(m instanceof SkinnedMesh3D) || this._isCharacterBody(m) || !m.skeletonId) return meshId;
        const body = this.getAllMeshes().find(b => b instanceof SkinnedMesh3D && this._isCharacterBody(b) && b.skeletonId === m.skeletonId);
        return body?.id ?? meshId;
    }

    setMeshOutline3D(meshId: string, style: Partial<HighlightStyle> | null): boolean {
        meshId = this._outlineOwnerId(meshId);
        const m = this.getMesh(meshId);
        if (!m) return false;
        if (style === null) { m.outline = null; this.renderer3D.setMeshOutline(meshId, null, m.outlineRings); }
        else {
            const merged: HighlightStyle = { ...Scene3DManager.DEFAULT_OUTLINE, ...m.outline, ...style };
            m.outline = merged; this.renderer3D.setMeshOutline(meshId, merged, m.outlineRings);
        }
        m.stateDirty = true;   // persist (the outline rides the mesh's toJSON)
        this.ctx.scheduleRender();
        return true;
    }
    // ── E3 CHARACTER OUTLINES (persona-polish-plan.md E3) ─────────────────
    /** The characters-only outline setting (null = off). Persisted in the scene settings. */
    private _charOutlines: Partial<HighlightStyle> | null = null;
    /** Default characters-only look: a thin near-black ink line (P5 outlines its characters, not the city). */
    static readonly CHARACTER_OUTLINE_DEFAULT: Partial<HighlightStyle> = { color: [0.04, 0.03, 0.05, 1], width: 0.012, patternMode: 0, glow: 1 };
    /**
     * Outline every PROCEDURAL CHARACTER (body + clothes + hair, one union silhouette via the per-object outline
     * system) — and every character created afterwards — with `style` (merged onto CHARACTER_OUTLINE_DEFAULT); null
     * turns them off (clears the outline on every procedural body). Scenery is never touched. Returns how many
     * characters were updated. Persisted (scene settings + each body's own outline).
     */
    setCharacterOutlines3D(style: Partial<HighlightStyle> | null): number {
        this._charOutlines = style ? { ...Scene3DManager.CHARACTER_OUTLINE_DEFAULT, ...style } : null;
        let n = 0;
        for (const m of this.getAllMeshes()) {
            if (!this._isCharacterBody(m)) continue;   // v1 procedural body or Character v2 body (review fix runtime#5)
            if (this.setMeshOutline3D(m.id, this._charOutlines)) n++;
        }
        this.ctx.scheduleRender();
        return n;
    }
    /** The characters-only outline setting, or null when off. */
    getCharacterOutlines3D(): Partial<HighlightStyle> | null { return this._charOutlines ? { ...this._charOutlines } : null; }

    /** PLAY CHARACTER OUTLINES (see GlobalScene3DSettings.playCharacterOutlines). New session/doc: on. */
    private _playCharOutlines = true;
    /** Body ids given the runtime Play outline this run (renderer-only; restored on Stop). */
    private _playOutlined: string[] = [];
    /** Outline characters in Play (when the scene's character outlines are off). Persists; takes effect next Play. */
    setPlayCharacterOutlines3D(on: boolean): void { this._playCharOutlines = on; }
    getPlayCharacterOutlines3D(): boolean { return this._playCharOutlines; }
    /** Play start: draw the default ink line on every procedural character that has no outline of its own. Renderer
     *  cache only (mesh.outline untouched), so a save during Play and the editor after Stop are unchanged. */
    private _beginPlayOutlines(): void {
        this._endPlayOutlines();
        if (!this._playCharOutlines || this._charOutlines) return;
        const style: HighlightStyle = { ...Scene3DManager.DEFAULT_OUTLINE, ...Scene3DManager.CHARACTER_OUTLINE_DEFAULT };
        for (const m of this.getAllMeshes()) {
            if (!this._isCharacterBody(m) || m.outline) continue;   // v1 or Character v2 body (review fix runtime#5)
            this.renderer3D.setMeshOutline(m.id, style, null);
            this._playOutlined.push(m.id);
        }
        if (this._playOutlined.length) this.ctx.scheduleRender();
    }
    private _endPlayOutlines(): void {
        for (const id of this._playOutlined) { const m = this.getMesh(id); this.renderer3D.setMeshOutline(id, m?.outline ?? null, m?.outlineRings ?? null); }
        this._playOutlined = [];
    }

    /** The mesh's persistent outline style, or null if none / the mesh is gone. */
    getMeshOutline3D(meshId: string): HighlightStyle | null { return this.getMesh(this._outlineOwnerId(meshId))?.outline ?? null; }
    /**
     * STACKED outlines: extra rings drawn OUTSIDE the mesh's outline, inner → outer (a red outline + a white ring
     * around it = setMeshOutline3D(id, { color: red }) then setMeshOutlineRings3D(id, [{ color: white, width: 0.02 }])).
     * Each ring's `width` is its own thickness; unset fields default to the main outline's (so a ring inherits its
     * pattern/glow/merge unless given). Replaces the whole ring list; [] or null clears. Needs the main outline set to
     * draw (rings wrap it). A character (body + clothes + hair) gets the rings around its one union silhouette too.
     */
    setMeshOutlineRings3D(meshId: string, rings: Partial<HighlightStyle>[] | null): boolean {
        meshId = this._outlineOwnerId(meshId);
        const m = this.getMesh(meshId);
        if (!m) return false;
        const base: HighlightStyle = { ...Scene3DManager.DEFAULT_OUTLINE, ...m.outline };
        m.outlineRings = rings && rings.length ? rings.map(r => ({ ...base, ...r, merge: base.merge })) : null;
        this.renderer3D.setMeshOutline(meshId, m.outline, m.outlineRings);
        m.stateDirty = true;
        this.ctx.scheduleRender();
        return true;
    }
    /** The mesh's extra outline rings (inner → outer), or [] if none. */
    getMeshOutlineRings3D(meshId: string): HighlightStyle[] { return (this.getMesh(this._outlineOwnerId(meshId))?.outlineRings ?? []).map(r => ({ ...r })); }

    // ── Soft (wrapped/half-Lambert) skin lighting ─────────────────────
    /** Global soft-lighting strength 0..1 (the "skin softness" slider). Only affects materials with softLighting on
     *  (the procedural body skin by default). 0 = normal Lambert, 1 = full half-Lambert (flattest). */
    setSoftLightStrength3D(v: number): void { this.renderer3D.setSoftLightStrength(v); this.ctx.scheduleRender(); }
    getSoftLightStrength3D(): number { return this.renderer3D.softLightStrength; }
    /** Toggle soft (wrapped) diffuse lighting on a specific mesh's material. Returns false if the mesh is gone. */
    setMeshSoftLighting3D(meshId: string, on: boolean): boolean {
        const m = this.getMesh(meshId);
        if (!m) return false;
        m.material.softLighting = on;
        m.materialDirty = true;   // flags live in the instance material block → re-pack the slot
        m.stateDirty = true;      // persist (softLighting rides the material in toJSON)
        this.ctx.scheduleRender();
        return true;
    }

    // ── Skin toon-ramp (character-shading Part A) ─────────────────────
    /** Flip a body's SKIN between 'classic' (smooth (soft-)Lambert) and 'ramp' (banded anime skin). Opt-in per
     *  character, live (no reload). The ramp LOOK (bands/softness/tint) is the scene-global {@link setSkinRampSettings3D};
     *  this just marks whether this mesh's skin uses it. Returns false if the mesh is gone. */
    setSkinShadingMode3D(meshId: string, mode: 'classic' | 'ramp'): boolean {
        const m = this.getMesh(meshId);
        if (!m) return false;
        m.material.skinRamp = mode === 'ramp';
        m.materialDirty = true;   // flags live in the instance material block → re-pack the slot
        m.stateDirty = true;      // persist (skinRamp rides the material in toJSON)
        this.ctx.scheduleRender();
        return true;
    }
    /** 'ramp' if this mesh's skin toon-ramp is on, else 'classic' (default). 'classic' if the mesh is gone. */
    getSkinShadingMode3D(meshId: string): 'classic' | 'ramp' {
        return this.getMesh(meshId)?.material.skinRamp ? 'ramp' : 'classic';
    }
    /** The scene-global skin toon-ramp look (bands / softness / shadowFloor / warm shadowTint) — the anime
     *  "house style" shared by every ramp-flagged skin. Merged over the current settings + clamped. */
    setSkinRampSettings3D(patch: Partial<SkinRampSettings>): void { this.renderer3D.setSkinRamp(patch); this.ctx.scheduleRender(); }
    getSkinRampSettings3D(): SkinRampSettings { return this.renderer3D.skinRamp; }
    /** Sketch style PAPER amount 0..1 — scene-global (every Sketch mesh): 1 = off-white paper with a colour wash, 0 = the
     *  full colour with pencil hatching. Default 0.75 = the original look. Persists with the document. */
    setSketchPaper3D(amount: number): void { this.renderer3D.setSketchPaper(amount); this.ctx.scheduleRender(); }
    getSketchPaper3D(): number { return this.renderer3D.sketchPaper; }

    // ── Toon shadows + rim light (docs/specs/film-look-and-toon-shadows.md §B/§C) ──
    /** Scene-wide TOON SHADOW look (every `toonShadow` material in the Cel / Cel-HD styles): bands, softness, how
     *  bright the shadow is, its colour tint and extra saturation. Merge-style; persists with the document. */
    setToonShadows3D(patch: Partial<import('../../renderer/3d/material-3d').ToonShadowSettings>): void { this.renderer3D.setToonShadows(patch); this.ctx.scheduleRender(); }
    getToonShadows3D(): import('../../renderer/3d/material-3d').ToonShadowSettings { return this.renderer3D.toonShadows; }
    /** Scene-wide RIM LIGHT for `rimEnabled` materials: strength (0 = the original built-in rim), width, hardness
     *  (soft → crisp toon edge), colour. Merge-style; persists. */
    setRimLight3D(patch: Partial<import('../../renderer/3d/material-3d').RimLightSettings>): void { this.renderer3D.setRimLight(patch); this.ctx.scheduleRender(); }
    getRimLight3D(): import('../../renderer/3d/material-3d').RimLightSettings { return this.renderer3D.rimLight; }
    /** Opt ONE mesh into toon shadows (material flag bit 30 — visible in the Cel / Cel-HD styles). False if gone. */
    setMeshToonShadow3D(meshId: string, on: boolean): boolean {
        const m = this.getMesh(meshId);
        if (!m) return false;
        m.material.toonShadow = on;
        m.materialDirty = true; m.stateDirty = true;   // flags live in the instance material block → re-pack; persist
        this.ctx.scheduleRender();
        return true;
    }
    /** Every mesh of a character: the body + eye decal + hair + ALL garments (every clothing slot). */
    characterMeshIds3D(bodyMeshId: string): string[] { return [bodyMeshId, ...this._character.overlayMeshIds(bodyMeshId)]; }
    /** Toon shadows on a whole character (body + hair + every garment; the unlit eye decal ignores it). */
    setCharacterToonShadows3D(bodyMeshId: string, on: boolean): void {
        for (const id of this.characterMeshIds3D(bodyMeshId)) this.setMeshToonShadow3D(id, on);
    }
    /** Rim light on a whole character (body + hair + every garment). */
    setCharacterRimLight3D(bodyMeshId: string, on: boolean): void {
        for (const id of this.characterMeshIds3D(bodyMeshId)) {
            const m = this.getMesh(id);
            if (!m) continue;
            m.material.rimEnabled = on;
            m.materialDirty = true; m.gpuDirty = true; m.stateDirty = true;
        }
        this.ctx.scheduleRender();
    }
    /** MATTE on a whole character (visual-polish item 10): the skin and every garment lose their specular (matte cel
     *  skin + cloth instead of glossy plastic highlights in Cel / Cel-HD; hair keeps its sheen), now and whenever a
     *  garment is regenerated. Stored on the body (persists). False if gone. */
    setCharacterMatte3D(bodyMeshId: string, on: boolean): boolean {
        const body = this.getMesh(bodyMeshId);
        if (!body) return false;
        body.material.matte = on;
        applyMatte(body, on);   // the skin too (also marks the body for re-pack + persist)
        for (const id of this._character.overlayMeshIds(bodyMeshId)) {
            const m = this.getMesh(id);
            if (m instanceof SkinnedMesh3D && m.isClothing) applyMatte(m, on);
        }
        this.ctx.scheduleRender();
        return true;
    }
    getCharacterMatte3D(bodyMeshId: string): boolean { return this.getMesh(bodyMeshId)?.material.matte === true; }
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
    /** R6.1 DISTANCE LOD (Mesh3D.drawDistance): `bias` = world units added to every draw distance this frame (the city
     *  sets it to the camera's distance to the city volume, so an aerial overview keeps its detail while street level
     *  uses the true per-chunk distances); `enabled` = the renderer master switch; `scale` = a global multiplier. */
    setDistanceLod3D(opts: { bias?: number; enabled?: boolean; scale?: number }): void {
        const r = this.renderer3D;
        if (opts.bias !== undefined) r.distanceLodBias = Math.max(0, opts.bias);
        if (opts.enabled !== undefined) r.distanceLod = opts.enabled;
        if (opts.scale !== undefined && opts.scale > 0) r.distanceLodScale = opts.scale;
    }

    /** Diagnostic: number of registered per-frame pre-render callbacks (watch for leaks — climbs = a
     *  callback isn't being removed on teardown). */
    getPreRenderCallbackCount3D(): number { return this.ctx.webgpuRenderer.getPreRenderCallbackCount(); }
    /** Per-frame CPU profile of the pre-render callbacks (springs / IK / idle / gizmos …) + the whole frame. First call
     *  turns profiling ON and returns null; later calls return the averages; `setCallbackProfiling3D(false)` stops it. */
    getCallbackProfile3D(): ReturnType<import('../../renderer/core/webgpu-renderer').WebGPURenderer['getCallbackProfile']> {
        const p = this.ctx.webgpuRenderer.getCallbackProfile();
        if (!p) this.ctx.webgpuRenderer.setCallbackProfiling(true);
        return p;
    }
    setCallbackProfiling3D(on: boolean): void { this.ctx.webgpuRenderer.setCallbackProfiling(on); }

    /** Register / unregister a per-frame pre-render callback (e.g. WorldManager's zoom-gated detail LOD). Passthrough
     *  to the renderer's callback list. Return false from the callback (it's a "keep running" flag, not a result). */
    addPreRenderCallback3D(cb: () => boolean): void { this.ctx.webgpuRenderer.addPreRenderCallback(cb); }
    removePreRenderCallback3D(cb: () => boolean): void { this.ctx.webgpuRenderer.removePreRenderCallback(cb); }

    /** Diagnostic: geometry-pool occupancy (see Renderer3D.getGeomPoolStats). */
    getGeomPoolStats3D(): ReturnType<Renderer3D['getGeomPoolStats']> { return this.renderer3D.getGeomPoolStats(); }
    /** Request a one-time geometry-pool compaction next frame (reclaims disposed-tile dead space). Call on idle. */
    requestGeomCompaction3D(): void { this.renderer3D.requestGeomCompaction(); }
    /** P22: re-place every pooled geometry under the current packedVertices switch (tile-landing.ts) next frame. */
    repackGeometryPool3D(): void { this.renderer3D.repackGeometryPool(); this.requestRender3D(); }
    /** Re-upload `mesh.geometry.indices[start, start + count)` after an IN-PLACE edit (no pool rebuild) — see
     *  Renderer3D.patchMeshIndices. The live crowd hides / restores one person inside a merged crowd layer with it. */
    patchMeshIndices3D(mesh: Mesh3D, start: number, count: number): boolean { return this.renderer3D?.patchMeshIndices?.(mesh, start, count) ?? false; }
    /** Re-upload vertices [start, start + count) of `mesh.geometry.vertices` after an IN-PLACE edit (no pool rebuild) — see
     *  Renderer3D.patchMeshVertices. The moving contact blobs (world-mover-shadows.ts) rewrite their quads with it. */
    patchMeshVertices3D(mesh: Mesh3D, start: number, count: number): boolean { return this.renderer3D?.patchMeshVertices?.(mesh, start, count) ?? false; }
    /** mobile-parity 7.3d: after patchMeshVertices3D moved a mesh's vertex POSITIONS (the Mesh Edit drag fast path) —
     *  its cached bounds and the shadow map refresh (Renderer3D.noteMeshVerticesMoved). */
    noteMeshVerticesMoved3D(mesh: Mesh3D): void { this.renderer3D?.noteMeshVerticesMoved?.(mesh); }
    /** visual-polish #16: the Play player's feet (world space, the last rendered frame) + body height, or null outside
     *  Play. The city's moving contact blobs put one under the player. */
    get playerFeet3D(): { x: number; y: number; z: number; height: number; groundY: number } | null {
        const f = this._lastPlayerFeet, cc = this._playController;
        // groundY = the standable surface under the feet (≤ feet): the contact blob sits THERE, not at the feet — a
        // blob at the feet rose with every jump.
        return this._playing && f && cc ? { x: f[0], y: f[1], z: f[2], height: cc.cfg.eyeHeight, groundY: Math.min(f[1], cc.lastGroundY) } : null;
    }
    private _lastPlayerFeet: [number, number, number] | null = null;

    /** PRE-UPLOAD a group's geometry so a later reveal is a cheap visibility flip (async city staging). `budgetBytes`
     *  (P10.D8) caps one call's upload — false while some of the group is still not resident (call again / let the
     *  render-time append finish it). */
    warmGroupGeometry3D(group: MeshGroup3D, budgetBytes = Infinity): boolean {
        return this.renderer3D.warmGeometry(group.children as unknown as Mesh3D[], budgetBytes);
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
        this._animation.getAnimationPlayer()?.play();
    }

    pauseSyncedPlayback(): void {
        this._animation.getAnimationPlayer()?.pause();
    }

    stopSyncedPlayback(): void {
        this._animation.getAnimationPlayer()?.stop();
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

    /** True when a camera-owning 3D sub-mode (edit-mesh / surface-paint / group-orbit / city / armature) is
     *  ALREADY active. Guards the pose snapshot on sub-mode entry: a re-entry (e.g. packaging re-frames on regen,
     *  or the armature panel switches skeletons) must NOT re-capture — that would snapshot the sub-mode's own
     *  camera over the real prior mode we need to restore on exit. */
    private _inCameraSubMode(): boolean {
        return this._armature.getMeshEditOrbitCenter() !== null
            || this._armature.getBoneOverlaySkeletonId() !== null
            || this._armature.editViewOwner !== null;   // the Armature's edit camera before a skeleton is shown
    }

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
        return this.frameWorldBounds3D(bounds, padding);
    }

    /** Frame a world-space AABB from the current view direction (perspective: dolly to fit; ortho: orthoSize). In a
     *  decoupled ortho creator view (Edit Mesh / surface paint / group orbit) its own zoom is re-seeded too — that
     *  view derives orthoSize from it every frame, so before this a frame only re-targeted (TOUCH-10 Frame). */
    frameWorldBounds3D(bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, padding = 1.25): boolean {
        if (![bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ].every(Number.isFinite)) return false;
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
        // P5: the visible reference grid keeps its own floor — reframing a small scene must not clip the grid.
        cam.autoFar = true;
        cam.sceneRadius = Math.max(radius, this._gridRadiusFloor());
        this._setDollyFloor(radius);

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
            cam.orthoSize = Math.max(1e-6, orthoFitHalfHeight(dx, dy, dz, oldDir, cam.up, cam.aspect)) * padding;
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
        this._armature.reseedDecoupledZoom();
        this.ctx.scheduleRender();
        return true;
    }

    /** Edit Mesh / UV / Armature edit camera (the decoupled ortho view those modes own): is one up, Frame (the entry
     *  framing, current angle), zoom by a factor (> 1 = in), and its zoom relative to that framing (1 = 100 %). */
    isEditViewActive3D(): boolean { return this._armature.editViewOwner !== null; }
    frameEditView3D(): boolean { return this._armature.frameEditView(); }
    zoomEditView3D(factor: number): boolean { return this._armature.zoomEditView(factor); }
    getEditViewZoom3D(): number | null { return this._armature.getEditViewZoom(); }
    /** The host's Pan tool is on in an edit view: the edit tools ignore presses (the drag pans the camera). */
    isEditPanTool3D(): boolean { return this._armature.isEditPanTool(); }
    /** Animate the edit camera (~250 ms) to look straight at these WORLD-space faces (flat xyz lists): their area-weighted
     *  normal toward the camera, centred, fitted with `padding`; the minimal, roll-free turn (edit-face-frame.ts). False
     *  outside an edit view, or when the faces' normals don't mostly agree (the caller frames without turning then). */
    frameEditFacesOn3D(faces: ArrayLike<number>[], padding = 1.4, minHalf = 0, ms = EDIT_FACE_FRAME_MS): boolean {
        const orb = this._armature.getOrbitController();
        if (!this._armature.editViewOwner || !orb) return false;
        const cam = this.renderer3D.getCamera();
        const f = faceOnFraming(faces, {
            azimuth: orb.azimuth, aspect: cam.aspect, padding, minHalf, minElevation: orb.minElevation, maxElevation: orb.maxElevation,
            roll: orb.effectiveRoll,   // fit on the ROLLED screen (Frame keeps the roll)
        });
        if (!f) return false;
        return this._armature.animateEditView({ target: f.target, azimuth: f.azimuth, elevation: f.elevation, zoom: 1 / f.halfHeight }, ms);
    }

    /** TOUCH-10 "Frame selected" outside Edit Mesh: the selected meshes, else everything. In the Armature: its mesh,
     *  with the edit view's own framing (frameEditView3D). Edit Mesh frames its selection through
     *  ShapeManager.frameSelected3D. */
    frameSelection3D(padding = 1.4): boolean {
        if (this._armature.editViewOwner === 'armature') return this._armature.frameEditView();
        if (this._armature.isBoneOverlayActive()) return false;
        const meshes: Mesh3D[] = [];
        for (const id of this.renderer3D.getSelectedMeshIds()) { const m = this.getMesh(id); if (m) meshes.push(m); }
        return (meshes.length > 0 && this.frameMeshes(meshes, padding)) || this.frameAllMeshes(padding);
    }

    /** True while an armature drag (joint / tail / joint gizmo / IK handle) or a finger press about to become one owns
     *  a pointer (hosts skip per-move UI work). */
    isArmatureDragActive3D(): boolean { return this._armature.isArmatureDragActive; }

    /** True while the Armature panel is up: armature mode entered (enterArmatureMode3D, the focus background) or the
     *  bone overlay pinned (showBoneOverlay3D) — until showBoneOverlay3D(null). */
    isArmatureModeActive3D(): boolean {
        if (this._armature.isBoneOverlayActive() || this._armatureEntryCaptured) return true;
        try { return this.renderer3D?.armatureModeActive === true; } catch { return false; }
    }

    /** Pause the procedural idle on a phone / tablet (or safe-mode) GPU tier while an edit mode is up (mobile-parity
     *  TOUCH-9/10 perf): it held the render loop live every vsync for the whole session — armature posing already
     *  stops its pose work, Edit Mesh doesn't need a breathing character. Desktop tiers are unchanged. */
    private _pauseIdleForEditMode(reason: 'meshEdit' | 'armature', on: boolean): void {
        if (on) {
            const tier = this.ctx.webgpuRenderer?.getGpuTier?.().tier;
            if (tier !== 'mobile' && tier !== 'safe') return;
        }
        this.setIdleAnimationPaused(reason, on);
    }

    private computeWorldBounds(meshes: Mesh3D[]): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        const box = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
        for (const mesh of meshes) {
            const m = mesh.localMatrix;
            const v = mesh.geometry?.vertices;

            if (v && v.length >= 3) {
                // P1.3 (performance-plan.md): this ran vec4.fromValues + vec4.create + transformMat4 PER VERTEX — ~300 ms for
                // a city on the first free3D entry (frameAllMeshes). Same exact result, cheaper:
                //  - no rotation/shear (every city chunk): the extremes of an axis-aligned scale+translate ARE the
                //    transformed local box corners, which the renderer caches per mesh (O(1) per mesh);
                //  - otherwise the per-vertex transform, inlined (no allocation).
                const e = m as unknown as Float32Array;
                if (e[1] === 0 && e[2] === 0 && e[4] === 0 && e[6] === 0 && e[8] === 0 && e[9] === 0 && e[3] === 0 && e[7] === 0 && e[11] === 0 && e[15] === 1
                    && this.renderer3D.getMeshWorldAABB3D(mesh, box)) {
                    if (box.minX < minX) minX = box.minX; if (box.minY < minY) minY = box.minY; if (box.minZ < minZ) minZ = box.minZ;
                    if (box.maxX > maxX) maxX = box.maxX; if (box.maxY > maxY) maxY = box.maxY; if (box.maxZ > maxZ) maxZ = box.maxZ;
                    continue;
                }
                // Rotated: the transformed-corner box CONTAINS the exact vertex box, so when it already sits inside the
                // running bounds this mesh cannot extend them — skip its vertices (exact result either way).
                if (this.renderer3D.getMeshWorldAABB3D(mesh, box) && box.minX >= minX && box.minY >= minY && box.minZ >= minZ
                    && box.maxX <= maxX && box.maxY <= maxY && box.maxZ <= maxZ) continue;
                for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
                    const x = v[i], y = v[i + 1], z = v[i + 2];
                    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];   // = vec4.transformMat4(p, m).xyz (no w divide, as before)
                    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
                    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
                    if (wx < minX) minX = wx; if (wy < minY) minY = wy; if (wz < minZ) minZ = wz;
                    if (wx > maxX) maxX = wx; if (wy > maxY) maxY = wy; if (wz > maxZ) maxZ = wz;
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

    /** Host hide of the nav gizmo (Toggle UI / viewer mode). Sticky across the modes that create / destroy it. */
    setViewGizmoHidden(hidden: boolean): void { return this._armature.setViewGizmoHidden(hidden); }

    /** True while the nav gizmo exists and is displayed. */
    isViewGizmoVisible(): boolean { return this._armature.isViewGizmoVisible(); }

    disableOrbitControls(): void { return this._armature.disableOrbitControls(); }

    /** TOUCH-3 "Navigate" lock: true = ONE finger orbits the 3D camera in every mode (tool modes included: City / Edit
     *  Mesh / paint, where one finger otherwise stays with the tool); two fingers then pan + pinch. Persists across
     *  mode switches. Mouse input is unaffected. See docs/ui/touch-controls.md. */
    setTouchNavigate3D(on: boolean): void { this._armature.setTouchNavigate3D(on); }
    getTouchNavigate3D(): boolean { return this._armature.getTouchNavigate3D(); }

    /** Frame the mesh under client (CSS) point (x, y), or every mesh when nothing is there (the touch double-tap).
     *  Returns true when the camera was reframed. */
    frameAtClient3D(clientX: number, clientY: number): boolean {
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        let hitId: string | null = null;
        if (canvas && typeof canvas.getBoundingClientRect === 'function') {
            const rect = canvas.getBoundingClientRect();
            const sx = rect.width > 0 ? canvas.width / rect.width : 1;
            const sy = rect.height > 0 ? canvas.height / rect.height : 1;
            hitId = this.pick3D((clientX - rect.left) * sx, (clientY - rect.top) * sy, canvas.width, canvas.height)?.meshId ?? null;
        }
        return (hitId !== null && this.frameMesh(hitId, 1.4)) || this.frameAllMeshes(1.4);
    }

    /** Re-attach 3D canvas input (orbit/pan/zoom + armature bone drag) to the current canvas after a canvas swap
     *  (Shell↔illustration reinitialize). Call from the host's onCanvasReinitialized, alongside the 2D tool
     *  re-binds — else free3D navigation is dead after a route change until the camera mode is toggled. */
    reattachCanvasListeners3D(): void { return this._armature.reattachCanvasListeners(); }

    /**
     * Enable orbit for mesh edit mode. Keeps the camera at its current position —
     * no snap to front view. Sets cam.target to the mesh center and initialises the
     * ortho-offset pan accumulator so the mesh stays at exactly its current screen
     * position after orbit activates.
     */
    enableMeshEditOrbit(meshId: string): void {
        if (!this._inCameraSubMode()) this._captureCurrentPose();   // snapshot the mode we're leaving (first entry only) so exit restores it exactly
        this._armature.enableMeshEditOrbit(meshId);
        this._pauseIdleForEditMode('meshEdit', true);
    }

    /** Disable orbit and clean up mesh edit orbit state, then RESTORE the view mode the user was actually in.
     *  Edit Mesh doesn't change `_viewState`, so if it was entered from free3D the stored mode is still free3D —
     *  re-applying it rebuilds the free3D orbit camera instead of dropping to the flat 2D illustration view
     *  (the armature teardown's `_forceIllustrationResync` only handles the 2D-entry case). Idempotent for 2D. */
    disableMeshEditOrbit(): void {
        this._armature.disableMeshEditOrbit();
        this._pauseIdleForEditMode('meshEdit', false);
        this._applyViewState();
    }

    /**
     * Enter a CITY-editing MODE: alt+drag orbit around the city, a clean focus background, and the view gizmo —
     * the same workspace as Edit-Mesh / Edit-Armature, but pivoted on the world origin (where the diorama sits).
     * The orbit controller then OWNS the camera (via `_meshEditOrbitCenter`), so the 2D illustration sync backs off.
     * Pair with {@link exitCityMode3D}. World generation itself lives in `sm.world` (WorldManager).
     */
    enterCityMode3D(center: [number, number, number] = [0, 0, 0]): void {
        this._stopPlayForEditorCamera('enterCityMode3D');
        if (!this._inCameraSubMode()) this._captureCurrentPose();   // snapshot the mode we're leaving (first entry only) so exitCityMode3D restores it

        const cam = this.renderer3D.getCamera();
        const sync = this._armature.getIllustrationSync();
        if (sync) {
            const { panX, panY, zoom, canvasH } = sync;
            const cx = -panX / (canvasH * zoom), cy = panY / (canvasH * zoom);
            cam.lookAt(cx, cy, 10, cx, cy, 0);
            cam.orthoSize = 1 / zoom;
        }
        this.enableOrbitControls({ altOrbitOnly: true });
        this._configureFreeZoom();   // T7.4: no City-mode zoom-out cap (was the orbit default maxRadius = 50)
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
        this._applyViewState();   // restore the mode the user was actually in (free3D stays free3D), not a hardcoded 2D snap
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
        if (this._deferViewChangeInPlay(() => { this._viewState.cameraMode = mode; })) return;
        this._captureCurrentPose();            // remember where we were in the mode we're LEAVING
        this._viewState.cameraMode = mode;
        this._applyViewState();                // restores the entered mode's remembered pose (else frames all)
        this.onViewStateChanged.emit();
        this.ctx.scheduleRender();
        void this._refreshArtboardTexture();   // capture/clear the artboard texture for the new mode
    }

    /** Switch target. P1 stores + emits (Frogmarks hides the 2D panels / reveals the Play slot); the scene-target
     *  render changes (dropping the artboard composite) land in P2. Non-destructive either way. */
    setTarget3D(target: ViewTarget): void {
        if (this._viewState.target === target) return;
        if (this._deferViewChangeInPlay(() => { this._viewState.target = target; })) return;
        this._captureCurrentPose();            // camera mode is unchanged → keeps the vantage across the target flip
        this._viewState.target = target;
        this._applyViewState();
        this.onViewStateChanged.emit();
        this.ctx.scheduleRender();
        void this._refreshArtboardTexture();
    }

    // bug-hunt 2026-10-01 (Play): editor camera calls during Play applied at once, so the orbit controller and the Play
    // loop fought over the camera. A view-mode / target switch is RECORDED (host UI + onViewStateChanged stay in sync)
    // and lands on Stop (exitPlayMode3D's _applyViewState); an editor ORBIT mode (city / mesh / group orbit) is an exit
    // from Play, so it stops Play first.
    private _viewChangedInPlay = false;
    private _deferViewChangeInPlay(record: () => void): boolean {
        if (!this._playing) return false;
        record();   // no _captureCurrentPose: the live camera is the PLAY camera, not an editor vantage
        this._viewChangedInPlay = true;
        this.onViewStateChanged.emit();
        return true;
    }
    private _stopPlayForEditorCamera(api: string): void {
        if (!this._playing) return;
        console.debug('[scene3d] ' + api + ' during Play — stopping Play first (the editor camera and Play cannot share the camera)');
        this.exitPlayMode3D();
    }

    /** Back to the DEFAULT view for a host screen that is not the 3D editor (ShapeManager.resetTo2DEditingView,
     *  mobile-parity 7.3c). Ends Play, the armature overlay, any mesh / group orbit claim and camera look-through /
     *  preview; drops the 3D pointer controllers (select + gizmo), the hover and the selection; then sets the view
     *  state to illustration × ortho2D with no remembered poses — which releases the orbit controller, the nav gizmo
     *  and fly, clears the 3D workspace backdrop and hands pan / zoom back to the 2D view (cameraOwnsView false).
     *  The engine outlives every route: without this a free3D camera left on by the illustration editor re-attached
     *  its orbit controller to the NEXT screen's canvas (a board) and owned its pan / zoom. Idempotent. */
    resetToDefaultView3D(): void {
        this.exitPlayMode3D();                                   // (no-op when not playing)
        if (this._armature.isBoneOverlayActive() || this._armature.editViewOwner === 'armature') this.showBoneOverlay3D(null);
        if (this._previewThroughCameras) this.setPreviewThroughCameras3D(false);
        if (this._lookThroughCamId !== null) this.lookThroughCamera3D(null);
        this._armature.exitMeshOrbit3D();                        // surface-paint / group / creator orbit: hands back its cameraOwnsView claim
        this.disableTransformControls();
        this.setHoveredMesh(null);
        this.clearSelection();
        this._viewChangedInPlay = false;
        this._flyLookHeld = false;
        this._viewState = { ...DEFAULT_VIEW_STATE };
        this._applyViewState();                                  // ortho2D: orbit + gizmo off, cameraOwnsView = false, 2D composite back
        this.onViewStateChanged.emit();
        this.ctx.scheduleRender();
        void this._refreshArtboardTexture();
    }

    /** Snapshot the CURRENT mode's camera vantage into `_viewState` (free3D orbit vantage → `freeCam`;
     *  2D pan/zoom → `flatCam`) so switching modes — and reloading a saved document — returns you to where
     *  you were instead of reframing. Call BEFORE mutating the mode; also called at serialize time so a save
     *  made without switching still captures the live pose. */
    private _captureCurrentPose(): void {
        const v = this._viewState;
        if (v.cameraMode === 'free3D') {
            const orbit = this._armature.getOrbitController();
            const cam = this.renderer3D.getCamera();
            if (orbit) {
                v.freeCam = {
                    target: [cam.target[0], cam.target[1], cam.target[2]],
                    radius: orbit.radius, yaw: orbit.azimuth, pitch: orbit.elevation,
                    ...(orbit.roll !== 0 ? { roll: orbit.roll } : {}),   // the view roll (absent = level, as old saves)
                    projection: cam.mode === 'orthographic' ? 'orthographic' : 'perspective',
                };
            }
        } else {
            const is = this.ctx.interactionService;
            const pan = is.getPanOffset();
            v.flatCam = { panX: pan.x, panY: pan.y, zoom: is.getZoomFactor() };
        }
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
    /** Held true while RMB free-look is active in free3D + Scene (Unity flythrough) — enables WASD fly only for the
     *  duration of the right-drag, independent of the persistent `_flyWanted` toggle. */
    private _flyLookHeld = false;

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
        // Fly is live when the persistent toggle is on OR while RMB free-look is held (Scene flythrough) — and only
        // in free3D, not during Play (Play owns input).
        if ((this._flyWanted || this._flyLookHeld) && this._viewState.cameraMode === 'free3D' && !this._playing) fly.enable();
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
        if (this._lookThroughCamId !== null || this._previewThroughCameras || this._playing) {   // looking through a camera / playing — no frustum
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
    // Script Behaviors (docs/specs/script-behaviors.md): custom per-node game logic, Play-only + non-destructive.
    // The manager holds the sources (persisted); the runner compiles + drives the enabled ones during Play through a
    // ShapeManager-agnostic adapter. Var/emit route to the UI machine via a bridge the host injects (setScriptVarBridge).
    private readonly _scriptManager = new ScriptBehaviorManager();
    private readonly _scriptCompiler = new ScriptCompiler();
    private _scriptRunner: ScriptRunner | null = null;
    private _scriptVarBridge: { get(name: string): number | string | boolean | null; set(name: string, v: number | string | boolean): void; emit(event: string): void } | null = null;
    private _lastPlayBase: CharacterInput = { forward: 0, right: 0, look: 0, jump: false };   // merged input this tick, for ctx.input
    private _playStartMs = 0;                        // performance.now() at Play start, for ctx.time
    private readonly _scriptHidden = new Map<string, boolean>();   // nodes ctx.destroy() hid this run → their PRE-hide visibility, restored on Stop
    private _lastInteract = false;
    private _prePlayCam: { pos: [number, number, number]; target: [number, number, number]; mode: 'perspective' | 'orthographic' } | null = null;
    /** Transform snapshot captured on enter, restored on exit — the non-destructive guarantee once Play mutates the
     *  scene (physics/scripts). Camera-only Play never touches these, so restore is a safe no-op in that case. */
    private _prePlayXforms: PlayXformSnapshot | null = null;
    /** The mesh bound as the "Player" (driven by the controller each tick), if any, + its pre-play visibility. */
    private _playerMesh: Mesh3D | null = null;
    private _playerMeshId: string | null = null;
    private _playerPrevVisible = true;
    // Measured from the bound avatar's world bounding box so the Play camera frames THIS avatar (not a hardcoded
    // ~1.7-unit human). _playerFootToOrigin = how far the mesh origin sits above the geometry's lowest point, so a
    // center-origin avatar is driven at the right height instead of sinking to feet=origin. 0 when nothing bound.
    private _playerHeight = 0;
    private _playerFootToOrigin = 0;
    /** Every mesh that IS the bound Player besides its body: hair, garments, face decal, charms, anything skinned to
     *  its skeleton or parented under it / its skeleton. Excluded from the ground / wall / camera rays — the auto
     *  player always excluded its parts, a user-set Player only its body, so the third-person camera ray hit the
     *  back of its own hair / top from the shoulder pivot and parked the camera inside its head. */
    private readonly _playerPartIds = new Set<string>();
    // Collision broadphase (built on enter when collision is on): the static mesh set + an XZ grid over their
    // footprints, so per-tick ground/wall casts only test nearby meshes. Null = collision off → no grid.
    private _collisionMeshes: Mesh3D[] | null = null;
    private _collisionGrid: SpatialGridXZ | null = null;
    // P6 (performance-plan.md): short candidate list for the bounded Play rays (camera bundle, wall + headroom rays) —
    // the grid meshes that really have a triangle near the character. Rebuilt with the grid. Null = collision off.
    private _collisionHood: CollisionHood<Mesh3D> | null = null;
    private _candIdx: number[] = [];       // scratch: grid → indices
    private _candMeshes: Mesh3D[] = [];     // scratch: indices → meshes (fed to the picker)
    // Third-person follow camera (R6.2: smoothed shoulder pivot + look-ahead + sphere-cast collision with recovery) +
    // the wall-clock of the last render tick (render-rate dt for the camera + mouse / right-stick look).
    private readonly _tpCam = new ThirdPersonCamera();
    private _camLastMs = 0;
    private _prePlayFov: number | null = null;
    // Built-in gamepad (R6.2): left stick move, right stick orbit, A jump, X use, L3 / Y walk-run toggle. Polled per
    // render frame; the fixed tick reads the latest reading.
    private _gamepad: GamepadInput | null = null;
    private _padReading: GamepadReading | null = null;
    private _padRunToggles = 0;
    /** Look applied at render rate since the last fixed tick (for the script ctx.input snapshot). */
    private _lookAccumYaw = 0;
    private _lookAccumPitch = 0;
    /** Fires when the walk/run state changes (Shift / L3 / setPlayerRunning3D). */
    public readonly onPlayerRunChanged = new EventEmitter<boolean>();
    /** Walk/run state carried across Play runs (a new run starts in the last state). Round 8: Play starts WALKING (Shift
     *  toggles a true run). */
    private _playRunning = false;
    /** Sneak (Round 8): C / gamepad B toggle it, Ctrl holds it; the effective state is either. Reset each Play run. */
    private _playSneakToggle = false;
    private _playSneaking = false;
    /** Fires when the effective sneak state changes (Ctrl / C / B / setPlayerSneaking3D). */
    public readonly onPlayerSneakChanged = new EventEmitter<boolean>();
    /** Procedural lean / head-lead layer over the engine locomotion (Round 8). */
    private readonly _locoLean = new LocomotionLean();
    /** Secondary motion (follow-through, per-cycle variation, head drift) over the RUNTIME default gaits only (gait feel
     *  2026-10-03; an authored walk plays exactly as before). Seeded per character. */
    private readonly _locoSecondary = new LocomotionSecondary();
    /** True while the bound walk is a runtime default gait (the auto player / the default gait without an own Walk). */
    private _locoRuntimeGait = false;
    private _padSneakToggles = 0;
    public readonly onPlayStateChanged = new EventEmitter<void>();

    // ── Play settings + auto default player (polish-round-3 T5; docs/ui/play-mode.md §Play settings) ──────────
    /** Play settings panel state (first-person eye height, auto default character). Persisted as globalScene.play.
     *  ShapeManager forwards straight to it (setPlayerEyeHeight3D / setAutoDefaultPlayer3D). */
    public readonly playSettings = new PlaySettings();
    /** The runtime default character spawned in third-person Play when no Player is set (never saved). */
    public readonly autoPlayer = new PlayAutoPlayer({
        createBody: (x, y, z) => this._createAutoPlayerCharacter(x, y, z),
        markRuntimeBody: (id) => this._character.markRuntimeBody(id),
        attach: (n) => { this.ctx.sceneGraph.root.addChild(n); this.ctx.emitSceneGraphChanged(); },
        detach: (n) => { n.parent?.removeChild(n); this._picker.evictMesh((n as unknown as { id: string }).id); this.ctx.emitSceneGraphChanged(); },
    });
    /** The enterPlayMode3D `config` of the current run (host overrides win over the play settings). */
    private _playOptsConfig: Partial<CharacterConfig> | undefined;
    /** The host's setPlayerAnimation3D binding, parked while the auto player drives locomotion; restored on release. */
    private _autoSpawnFor: CharacterController | null = null;
    private _autoPrevAnim: { clips: LocomotionClips | null; handler: ((clipName: string) => void) | null; engineSkel: string | null; defaultGait: boolean } | null = null;

    /** The explicit controller config for a Play run: the play settings (eye height), overridden by the host's own
     *  enterPlayMode3D config. Fields left out fall back to the scale-correct defaults (_playScaleConfig) / avatar
     *  framing. */
    private _explicitPlayConfig(): Partial<CharacterConfig> {
        const eye = this.playSettings.getEyeHeight();
        const camDist = this.playSettings.getCameraDistance();   // metres → world units
        return {
            ...(eye !== null ? { eyeHeight: eye } : {}),
            ...(camDist !== null ? { thirdPersonDistance: camDist / this.getPlayMetresPerUnit3D() } : {}),
            ...(this._playOptsConfig ?? {}),
        };
    }

    // ── Scene metre scale (Round 4) ────────────────────────────────────────────────────────────────────────
    // The controller's defaults (DEFAULT_CHARACTER) are in METRES (1 unit = 1 m Creator content). A city is built at
    // cityMetresPerUnit() metres per unit (~15), so there those defaults made a 1.6-unit = 24 m tall player that walked
    // at 52 m/s. ShapeManager installs a provider returning the city's metres-per-unit when a city exists (null
    // otherwise = 1, today's behaviour); every length/speed default is divided by it.
    private _playMetresPerUnitProvider: (() => number | null) | null = null;
    /** Install the scene's metres-per-unit source for Play (ShapeManager: the city scale while a city exists). */
    setPlayMetresPerUnitProvider(fn: (() => number | null) | null): void { this._playMetresPerUnitProvider = fn; }
    /** The scene's metre scale for Play: metres per world unit, or null when the scene has none (not a city). */
    private _playMetreScale(): number | null {
        const v = this._playMetresPerUnitProvider?.() ?? null;
        return v !== null && Number.isFinite(v) && v > 0 ? v : null;
    }
    /** Metres per world unit Play uses (1 outside a city). */
    getPlayMetresPerUnit3D(): number { return this._playMetreScale() ?? 1; }

    /** Controller defaults converted to world units: every length / speed / acceleration of DEFAULT_CHARACTER ÷
     *  metresPerUnit, and the move speed from the play settings (m/s). Identity outside a city at the default speed. */
    private _playScaleConfig(): Partial<CharacterConfig> & { moveSpeed: number } {
        const u = 1 / this.getPlayMetresPerUnit3D(), d = DEFAULT_CHARACTER;
        return {
            moveSpeed: this.playSettings.getMoveSpeed() * u,
            walkSpeed: this.playSettings.getWalkSpeed() * u,
            sneakSpeed: Math.min(d.sneakSpeed, this.playSettings.getWalkSpeed()) * u,
            groundAccel: d.groundAccel * u, groundDecel: d.groundDecel * u,
            apexHangSpeed: d.apexHangSpeed * u, maxFallSpeed: d.maxFallSpeed * u,
            jumpSpeed: d.jumpSpeed * u, gravity: d.gravity * u, eyeHeight: d.eyeHeight * u,
            radius: d.radius * u, stepHeight: d.stepHeight * u,
            thirdPersonDistance: d.thirdPersonDistance * u, thirdPersonHeight: d.thirdPersonHeight * u,
            cameraCollisionPadding: d.cameraCollisionPadding * u, cameraMinDistance: d.cameraMinDistance * u,
            cameraCollisionRadius: d.cameraCollisionRadius * u, cameraShoulderOffset: (d.cameraShoulderOffset ?? 0) * u,
            thirdPersonFovDeg: this.playSettings.getFov(),
            jumpWindup: PLAY_JUMP_WINDUP,   // item 13: a ~60 ms anticipation crouch before a ground jump (a time: unscaled)
        };
    }

    /** The eye height Play uses when no height is set: 0.9 × the bound avatar's measured height, else 1.6 m (in world
     *  units: 1.6 outside a city, 1.6 / cityMetresPerUnit in one). */
    getDefaultPlayerEyeHeight3D(): number {
        if (this._playing && this._playerHeight > 0) return this._playerHeight * 0.9;
        // Outside Play: the bound Player's CURRENT size (it may have been scaled / regenerated since the last run).
        const m = this._playerMeshId ? this.getMesh(this._playerMeshId) : null;
        const h = m ? this._meshStandingHeight(m) : 0;
        if (h > 0) return h * 0.9;
        return this._playerHeight > 0 ? this._playerHeight * 0.9 : DEFAULT_CHARACTER.eyeHeight / this.getPlayMetresPerUnit3D();
    }

    /** For a HOST-owned clip handler (setPlayerAnimation3D + the discrete LocomotionClipDriver): the planar speed
     *  re-expressed on the R6.2 reference scale — the controller's walk speed reads as 1.5 and its run speed as 3.5 —
     *  so the driver's walk/run threshold (2.2) follows the gait speeds, the move-speed settings AND the scene scale:
     *  a full-input walk walks, a run runs. (The engine animator reads real speeds: _driveLocomotionAnimator.) */
    private _locoForAnim(cc: CharacterController, loco: LocomotionState): LocomotionState {
        const walk = cc.walkTopSpeed(), run = cc.cfg.moveSpeed, s = loco.planarSpeed;
        if (!(walk > 0) || !(run > walk)) return loco;
        const mapped = s <= walk ? (s * 1.5) / walk : 1.5 + ((s - walk) / (run - walk)) * 2.0;
        return mapped === s ? loco : { ...loco, planarSpeed: mapped };
    }

    /** Build the auto default player (Round 4): the SEEDED random character (character-randomizer, the same look as
     *  sm.randomCharacterParams3D(AUTO_PLAYER_SEED)): body + face/procedural eyes + hair + top/bottom/socks/shoes +
     *  skin tone + rim light, assembled straight on the character subsystem (no ShapeManager wrappers, so no undo and
     *  no paint-carry registries). The body is excluded + marked runtime BEFORE any overlay is generated, so no rig
     *  of it is ever serializable. Each dressing step is guarded: a failure leaves a plainer character, never none. */
    private async _createAutoPlayerCharacter(x: number, y: number, z: number): Promise<AutoPlayerBody | null> {
        const p = randomCharacterParams(AUTO_PLAYER_SEED);
        // Garments in the order they are applied below: shoes BEFORE the bottom (it piles onto them — applied after,
        // the shoes would re-pile i.e. regenerate the bottom; the final result is the same), then hair (fitted against
        // all of them). Body + garments + hair are generated in ONE worker job and primed (P3.2d).
        const garments = [p.top, p.socks, p.shoes, p.bottom];
        // sceneScale off: PlayAutoPlayer measures the GENERATED size and scales per acquire (the cache outlives the
        // document, so a city-baked scale would leak into a non-city scene).
        const r = await this.createProceduralCharacter3D({ body: p.body, garments, hair: p.hair }, x, y, z, { sceneScale: false });
        try { return this._dressAutoPlayerCharacter(r, p, garments); } finally { this._character.clearPrimedParts(r.meshId); }
    }
    private _dressAutoPlayerCharacter(r: { meshId: string; skeletonId: string }, p: ReturnType<typeof randomCharacterParams>, garments: ClothingParams[]): AutoPlayerBody | null {
        const mesh = this.getMesh(r.meshId), skeleton = this.getSkeleton(r.skeletonId);
        if (!mesh || !skeleton) return null;
        mesh.excludeFromDocument = true; skeleton.excludeFromDocument = true;
        this._character.markRuntimeBody(mesh.id);
        const step = (what: string, fn: () => void) => { try { fn(); } catch (e) { console.warn(`[Play] auto default player: ${what} failed`, e); } };
        step('face', () => {
            if (!this._character.ensureFace3D(mesh.id)) return;
            const expr = this._character.createFaceExpression(mesh.id, 'Neutral');
            if (expr) this._character.setFaceExpressionProcedural(mesh.id, expr, p.eyes);
        });
        // Garments BEFORE hair: the hair is fitted (collision) against the clothes, and a garment added after hair
        // regenerates the hair each time.
        for (const c of garments) step(c.slot, () => this._character.setClothingParams(mesh.id, c));
        step('hair', () => this._character.setHairParams(mesh.id, p.hair));
        step('skin', () => this._character.setSkinTone(mesh.id, p.skinTone));
        step('face kit', () => { this._character.setFaceFeatures(mesh.id, p.face); });
        step('rim light', () => this.setCharacterRimLight3D(mesh.id, p.rimLight));
        const parts: Mesh3D[] = [];
        for (const id of this._character.overlayMeshIds(mesh.id)) {
            const m = this.getMesh(id);
            if (m) { m.excludeFromDocument = true; parts.push(m); }
        }
        return { mesh, skeleton, parts };
    }

    /** Re-apply the play settings to the running controller (live slider / checkbox). */
    private _applyPlaySettingsLive(): void {
        const cc = this._playController;
        if (!cc || !this._playing) return;
        const explicit = this._explicitPlayConfig();
        cc.cfg.eyeHeight = explicit.eyeHeight ?? this.getDefaultPlayerEyeHeight3D();
        const scaled = this._playScaleConfig();
        cc.cfg.moveSpeed = explicit.moveSpeed ?? scaled.moveSpeed;   // live move-speed (run) slider
        cc.cfg.walkSpeed = explicit.walkSpeed ?? scaled.walkSpeed!;  // live walk-speed slider
        cc.cfg.sneakSpeed = explicit.sneakSpeed ?? scaled.sneakSpeed!;
        cc.cfg.thirdPersonDistance = explicit.thirdPersonDistance ?? scaled.thirdPersonDistance!;   // live camera-distance slider
        cc.cfg.thirdPersonFovDeg = explicit.thirdPersonFovDeg ?? scaled.thirdPersonFovDeg!;         // live FOV slider
        this._applyAvatarCameraFraming(cc, explicit);
        this._applyPlayFov(cc);
        // Auto default player toggled mid-play: spawn / remove it to match.
        const wantAuto = PlayAutoPlayer.shouldSpawn({ enabled: this.playSettings.autoDefaultPlayer, cameraMode: cc.cfg.cameraMode, hasPlayer: this._playerMesh !== null && !this._isAutoPlayerMesh(this._playerMesh) });
        if (wantAuto && !this._playerMesh) void this._spawnAutoPlayer(cc);
        else if (!wantAuto && this._isAutoPlayerMesh(this._playerMesh)) this._releaseAutoPlayer();
        this.ctx.scheduleRender();
    }

    private _isAutoPlayerMesh(m: Mesh3D | null): boolean { return !!m && this.autoPlayer.isRuntimeNode(m.id); }

    /** Spawn (or re-attach the cached) auto default player at the controller's feet and bind it as the driven avatar —
     *  WITHOUT touching the persisted player binding (_playerMeshId / locomotion set). Async on first use (body
     *  generation); a Stop before it's ready drops the result. */
    private async _spawnAutoPlayer(cc: CharacterController): Promise<void> {
        if (this._autoSpawnFor === cc) return;   // already spawning for this run (e.g. repeated live-settings changes)
        this._autoSpawnFor = cc;
        let body: Awaited<ReturnType<PlayAutoPlayer['acquire']>>;
        // In a city: real human size (1.7 m in city units). Elsewhere: the generated size (unchanged behaviour).
        const mpu = this._playMetreScale();
        try { body = await this.autoPlayer.acquire(cc.pos[0], cc.pos[1], cc.pos[2], mpu !== null ? { height: AUTO_PLAYER_HEIGHT_M / mpu } : undefined); }
        finally { if (this._autoSpawnFor === cc) this._autoSpawnFor = null; }
        if (!body) return;
        // Stale: Play stopped / restarted, a user Player got bound, or the setting was switched off meanwhile.
        if (!this._playing || this._playController !== cc || (this._playerMesh && !this._isAutoPlayerMesh(this._playerMesh)) || !this.playSettings.autoDefaultPlayer) {
            if (!this._isAutoPlayerMesh(this._playerMesh)) this.autoPlayer.release();
            return;
        }
        const m = body.mesh;
        this._playerMesh = m;
        this._playerPrevVisible = true;
        m.visible = true;
        this._measureBoundAvatar(m);
        this._applyAvatarCameraFraming(cc, this._explicitPlayConfig());
        this._drivePlayerMesh(cc);
        this._tpCam.reset();   // re-frame onto the new body (first frame snaps)
        // Locomotion: Breathe / Walk / Run on the auto body. Park the host's own binding (if any) and restore it later.
        if (!this._autoPrevAnim) this._autoPrevAnim = { clips: this._playerClips, handler: this._playerAnimHandler, engineSkel: this._locoEngineSkelId, defaultGait: this._locoDefaultGait };
        this._bindEngineLocomotion(body.skeleton.id, { ...AUTO_PLAYER_CLIPS });
        this._locoRuntimeGait = true;
        this._bindIdleVariants(body.skeleton.id);   // idle variety over its runtime Stand (2026-10-04)
        this.ctx.scheduleRender();
    }

    /** Unbind + remove the auto default player (kept cached), restoring the host's animation binding. */
    private _releaseAutoPlayer(): void {
        if (this._isAutoPlayerMesh(this._playerMesh)) {
            this._playerMesh = null;
            this._playerHeight = 0; this._playerFootToOrigin = 0; this._playerPartIds.clear();
            this._restoreLocoRest();
        }
        if (this._autoPrevAnim) {
            const prev = this._autoPrevAnim;
            this._autoPrevAnim = null;
            this.setPlayerAnimation3D(prev.clips, prev.handler);
            this._locoEngineSkelId = prev.engineSkel; this._locoDefaultGait = prev.defaultGait;
        }
        this.autoPlayer.release();
    }

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
        if (input.interact !== undefined) this._playInput.interact = input.interact;   // TOUCH-4: the Use button (was dropped)
    }

    /** Register the avatar's locomotion clip names (idle/walk/run?/jump?/fall?) + a handler the Play loop calls with
     *  a clip name whenever the locomotion state transitions — the host plays that clip on the avatar. Pass null
     *  clips to disable. See game/locomotion.ts. */
    setPlayerAnimation3D(clips: LocomotionClips | null, handler: ((clipName: string) => void) | null): void {
        this._playerClips = clips;
        this._playerAnimHandler = handler;
        this._locoDriver.reset();
        // A host-owned binding: the engine locomotion animator steps aside (the host plays the clips).
        this._locoEngineSkelId = null; this._locoDefaultGait = false;
    }

    // ── Player movement params → UI variables (§4.3) ─────────────────
    /** Handler fed the player's locomotion state each Play tick — ShapeManager wires it to publish
     *  `player.speed/moving/grounded/airborne/rising` into the active UI state machine. */
    private _playerParamHandler: ((loco: import('../../game/locomotion').LocomotionState) => void) | null = null;
    setPlayerParamHandler(fn: ((loco: import('../../game/locomotion').LocomotionState) => void) | null): void { this._playerParamHandler = fn; }

    // ── Locomotion set from the Animation Library (§4.4) ─────────────
    // Bind the five locomotion slots to LIBRARY entries (or existing clip names/ids); the engine self-wires
    // setPlayerAnimation3D with a CROSSFADING handler so binding a character animates its walk with no host code.
    private _locoSet: { idle?: string; walk?: string; run?: string; jump?: string; fall?: string; jumps?: string[] } | null = null;
    // ENGINE-driven locomotion (R6.2): the LocomotionAnimator state machine (idle ⇄ walk ⇄ run, jump / fall, crossfades)
    // samples the clips against the avatar's REST pose and blends them per tick. Used for the auto default player, a
    // setPlayerLocomotionSet3D set, and a user Player with the default gait; a host-owned setPlayerAnimation3D handler
    // opts out (the host plays the clips). `_locoEngineSkelId` = the skeleton it drives (null = host-owned / none).
    private _locoEngineSkelId: string | null = null;
    private readonly _locoAnim = new LocomotionAnimator();
    /** The pose captured when the engine took the rig (restored on Stop / unbind), and the joints' fallback pose. */
    private _locoRest: { skelId: string; pose: import('../../renderer/3d/skeleton-animator').SkeletonPose } | null = null;
    /** Runtime-only gait clips (default Walk / Run) for a user Player that has none — NEVER written to the skeleton,
     *  so they can't reach a saved document. */
    private _locoRuntimeClips: SkeletonAnimClip[] = [];
    /** True while the current engine binding is the automatic default gait (cleared on Stop). */
    private _locoDefaultGait = false;
    /** Name of the synthetic "rest pose" idle used when a rig has no idle clip. */
    private static readonly LOCO_REST_CLIP = '__rest__';
    // 1D blend tree config (§8): when set, its walk/run speeds tune the animator's walk ⇄ run blend points.
    private _locoBlend: LocomotionBlendConfig | null = null;
    // Layered overlay (§8): a masked clip (wave/aim) driving only its region's joints OVER the blended locomotion.
    // `_playerOverlayRef` is the raw request (clip ref + region); `_playerOverlay` is it resolved against the bound
    // avatar's skeleton (clip NAME + joint-index mask). Overlay has its own looping phase.
    private _playerOverlayRef: { clip: string; region: RegionMask; mode?: 'replace' | 'additive'; weight?: number } | null = null;
    private _playerOverlay: { clipName: string; mask: number[]; mode: 'replace' | 'additive'; weight: number } | null = null;
    private _overlayPhase = 0;

    /** Play mode: does the Play locomotion own this skeleton's pose (the engine animator's rig, or the Player's rig
     *  under a host clip handler)? The procedural idle yields to it (an idle left ON from the character panel otherwise
     *  re-posed the Player after every tick: it slid around breathing, no walk cycle). */
    private _isSkeletonPlayDriven(skelId: string): boolean {
        if (!this._playing) return false;
        if (skelId === this._locoEngineSkelId) return true;
        return !!this._playerClips && !!this._playerAnimHandler && skelId === this._playerSkeletonId();
    }

    /** The skeleton id driving the bound Player avatar (a SkinnedMesh3D's skeleton), or null. */
    private _playerSkeletonId(): string | null {
        const m = this._playerMesh as (Mesh3D & { skeletonId?: string | null }) | null;
        return m?.skeletonId ?? null;
    }

    /** Bind the Play-mode locomotion slots to Animation Library entries (or clip names/ids already on the
     *  avatar). Pass null to clear. Resolves + applies from the library on demand, then self-wires a
     *  crossfading playback handler. Persisted with the player binding. */
    setPlayerLocomotionSet3D(set: { idle?: string; walk?: string; run?: string; jump?: string; fall?: string; jumps?: string[] } | null): void {
        // `jumps` (2026-10-03): two or more jump clips / library entries; each jump picks one (jump variety).
        const jumps = Array.isArray(set?.jumps) ? set!.jumps.filter((j) => typeof j === 'string' && !!j) : null;
        this._locoSet = set ? { ...set } : null;
        if (this._locoSet) { delete this._locoSet.jumps; if (jumps && jumps.length) this._locoSet.jumps = jumps; }
        this._applyLocomotionSet();
    }
    getPlayerLocomotionSet3D(): { idle?: string; walk?: string; run?: string; jump?: string; fall?: string; jumps?: string[] } | null {
        return this._locoSet ? { ...this._locoSet, ...(this._locoSet.jumps ? { jumps: [...this._locoSet.jumps] } : {}) } : null;
    }

    /** Resolve the locomotion set against the bound avatar's skeleton (applying library entries as needed) and
     *  wire setPlayerAnimation3D with the crossfading handler. No-op without a bound avatar or an idle+walk. */
    private _applyLocomotionSet(): void {
        const set = this._locoSet;
        const skelId = this._playerSkeletonId();
        if (!set || !skelId) return;
        // Resolve a slot value (library entry id OR existing clip id/name) → a clip NAME present on the skeleton. Last, a
        // RUNTIME default clip name (2026-10-03: e.g. { walk: 'Stomp' }) — generated for this rig, never written to it.
        const runtime: SkeletonAnimClip[] = [];
        const resolve = (v?: string): string | undefined => {
            if (!v) return undefined;
            const existing = this.getSkeletonClips3D(skelId).find((c) => c.id === v || c.name === v);
            if (existing) return existing.name;
            const newId = this.applyLibraryEntry3D(v, skelId);   // maybe a library entry → instantiate it
            if (newId) return this.getSkeletonClips3D(skelId).find((c) => c.id === newId)?.name;
            if (DEFAULT_LOCOMOTION_CLIP_NAMES.includes(v)) {
                const skel = this.getSkeleton(skelId);
                if (skel && !runtime.length) runtime.push(...buildLocomotionClips(skel.data.joints, { armClearance: this._playArmClearance(skel), variation: this._locoCharacterSeed(skelId) }));
                if (runtime.some((c) => c.name === v)) return v;
            }
            return undefined;
        };
        // Jump variety for an authored set (2026-10-03): `jumps` = two or more jump clips, one picked per jump.
        const jumps = (set.jumps ?? []).map((j) => resolve(j)).filter((n): n is string => !!n);
        const clips: LocomotionClips = {
            idle: resolve(set.idle) ?? '', walk: resolve(set.walk) ?? '',
            run: resolve(set.run), jump: resolve(set.jump) ?? jumps[0], fall: resolve(set.fall),
            ...(jumps.length >= 2 ? { jumps } : {}),
        };
        if (!clips.idle || !clips.walk) return;   // idle + walk are required by the locomotion picker
        this._bindEngineLocomotion(skelId, clips);
        this._locoRuntimeClips = runtime;   // the runtime clips the set named (none = []); _locoClip looks them up
    }

    /** Hand the avatar's skeleton to the engine locomotion animator with these clip names. Captures the rest pose
     *  (the rig's pose right now) the first time this skeleton is taken. */
    private _bindEngineLocomotion(skelId: string, clips: LocomotionClips): void {
        // The auto player's default clips live on its RUNTIME skeleton (never saved): refit them to its body + outfit.
        if (this.autoPlayer.isRuntimeNode(skelId)) this._refitAutoPlayerClips(skelId);
        this.setPlayerAnimation3D(clips, () => { /* engine-driven: the animator plays the clips (_driveLocomotionAnimator) */ });
        this._locoEngineSkelId = skelId;
        this._locoRuntimeGait = false;   // the default-gait / auto-player binders set it after
        // Seeded per CHARACTER (its body id): the jump-variant sequence and the secondary motion's per-cycle variation.
        const seed = seedFromString(this._locoCharacterSeed(skelId));
        this._locoAnim.cfg.jumpSeed = seed;
        this._locoSecondary.reset(seed);
        this._locoAnim.reset();
        this._locoIdleVariants = []; this._locoIdleNames = []; this._idleFace = null;   // the default-gait binders add them
        if (this._locoRest?.skelId !== skelId) {
            this._restoreLocoRest();
            const pose = this.snapshotSkeletonPose3D(skelId);
            this._locoRest = pose ? { skelId, pose } : null;
        }
    }

    // ── Idle variety (Play polish 2026-10-04; default-idle-variants.ts) ──────────────────────────────────────────
    /** Runtime idle-variant clips for the bound rig (never written to the skeleton) and their names. Only over the
     *  runtime Stand idle: an authored Idle clip (or a host / locomotion-set binding) plays as authored. */
    private _locoIdleVariants: SkeletonAnimClip[] = [];
    private _locoIdleNames: string[] = [];
    /** The variant whose face events are being fired, and the last frame fired. */
    private _idleFace: { clip: string; frame: number } | null = null;
    /** Build the idle variants for an engine-bound rig whose idle is the runtime Stand (fitted to the body's arm
     *  clearance; Adjust Glasses only when it wears a glasses charm). */
    private _bindIdleVariants(skelId: string): void {
        this._locoIdleVariants = []; this._locoIdleNames = [];
        const skel = this.getSkeleton(skelId);
        if (!skel || this._playerClips?.idle !== LOCOMOTION_CLIP.idle) return;
        const body = this.getAllMeshes().find(m => m instanceof SkinnedMesh3D && this._isCharacterBody(m) && m.skeletonId === skelId);
        let glasses = false;
        try { glasses = !!body && this.listAttachments(body.id).some((a) => GLASSES_CHARMS.includes(a.type)); } catch { glasses = false; }
        this._locoIdleVariants = buildIdleVariantClips(skel.data.joints, { armClearance: this._playArmClearance(skel), glasses });
        this._locoIdleNames = this._locoIdleVariants.map((c) => c.name);
    }
    /** Fire the playing idle variant's face events (gaze / blink / face-kit expression) between the last tick and now. */
    private _fireIdleFace(skelId: string): void {
        const iv = this._locoAnim.idleVariant;
        if (!iv) {
            // A variant cancelled mid-way: put the eyes / expression back.
            if (this._idleFace && this._idleFace.frame >= 0) { const skel = this.getSkeleton(skelId); if (skel) this._clipFaceEvent(skel, { frame: 0, restore: true }); }
            this._idleFace = null; return;
        }
        const clip = this._locoIdleVariants.find((c) => c.name === iv.clip);
        if (!clip?.faceTrack?.length) { this._idleFace = { clip: iv.clip, frame: -1 }; return; }
        const f = clip.startFrame + iv.phase * (clip.endFrame - clip.startFrame);
        const prev = this._idleFace && this._idleFace.clip === iv.clip ? this._idleFace.frame : -1;
        const skel = this.getSkeleton(skelId);
        if (skel) for (const ev of clip.faceTrack) if (ev.frame > prev && ev.frame <= f) this._clipFaceEvent(skel, ev);
        this._idleFace = { clip: iv.clip, frame: f };
    }

    // ── Landing dust (Play polish 2026-10-04; src/game/landing-dust.ts + play-dust-driver.ts) ─────────────────────
    /** The Play dust: puffs on landings, running footstep puffs, splashes when wet. Holds no memory while idle. */
    private readonly _playDust = new PlayDustDriver(0x5a17d057);
    /** How wet the ground is right now (0..1: the city's rain / wet sheen) — ShapeManager wires it to the world.
     *  null = always dry. */
    playWetness: (() => number) | null = null;
    /** Diagnostics / tests: the dust driver (bursts by kind, live particles). */
    get playDust(): PlayDustDriver { return this._playDust; }
    /** Diagnostics (ShapeManager.getPlayPolishStats3D): dust bursts by kind + live particles; idle variants played. */
    getPlayPolishStats3D(): { dust: Record<string, number>; dustLive: number; idleVariants: string[]; idleVariant: string | null } {
        return {
            dust: { ...this._playDust.emitted }, dustLive: this._playDust.system.count,
            idleVariants: [...this._locoAnim.idleVariantHistory], idleVariant: this._locoAnim.idleVariant?.clip ?? null,
        };
    }
    private _dustEnvCache: DustEnvironment | null = null;
    private get _dustEnv(): DustEnvironment {
        return this._dustEnvCache ??= {
            groundColor: (x, y, z) => {
                // The surface under the burst: a short down ray over the ground candidates; its material's base colour.
                const up = Math.max(0.05, this._playerHeight * 0.2 || 0.3);
                const hit = this._picker.raycastWorld([x, y + up, z] as unknown as vec3, [0, -1, 0] as unknown as vec3, this._groundCandidates(x, z), true, up * 3, true);
                const d = hit?.mesh?.material?.diffuse;
                return d ? [d.r, d.g, d.b] : null;
            },
            lighting: (x, y, z): DustLighting => {
                const r = this.renderer3D, cam = r.getCamera();
                const amb = r.ambientConfig as { color?: number[]; intensity?: number } | undefined;
                const sun = r.lightConfig as { direction?: number[]; color?: number[]; intensity?: number } | undefined;
                const fog = r.fogConfig as Partial<FogConfig> | undefined;
                const dir = sun?.direction ?? [0, -1, 0];
                const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
                return {
                    ambient: amb?.color ?? [0.17, 0.17, 0.17], ambientIntensity: amb?.intensity ?? 1,
                    sun: sun?.color ?? [1, 1, 1], sunIntensity: sun?.intensity ?? 1, sunElevation: Math.max(0, -dir[1] / dl),
                    fogMode: fog?.mode ?? 'off', fogColor: fog?.color ?? [0, 0, 0], fogNear: fog?.near ?? 0, fogFar: fog?.far ?? 1, fogDensity: fog?.density ?? 0,
                    distance: Math.hypot(x - cam.position[0], y - cam.position[1], z - cam.position[2]),
                };
            },
            visible: (x, y, z, footstep) => {
                const cam = this.renderer3D.getCamera();
                const d = Math.hypot(x - cam.position[0], y - cam.position[1], z - cam.position[2]);
                // Sim LOD: nothing past the fog-horizon edge (the same edge that freezes the simulated crowd).
                if (this.simLod.enabled && d > this.renderer3D.simFogEdge) return false;
                // Too small to see: a footstep puff past ~40 m, a landing ring past ~120 m (at the avatar's scale).
                const s = Math.max(1e-6, (this._playerHeight || 1.7) / 1.7);
                return d < (footstep ? 40 : 120) * s;
            },
        };
    }
    /** Per fixed Play tick: let the dust driver decide on bursts (cheap edge checks; the environment is only queried
     *  when a burst is emitted). */
    private _tickPlayDust(cc: CharacterController, loco: LocomotionState): void {
        const on = this.playSettings.landingDust;
        const anim = this._locoEngineSkelId ? this._locoAnim : null;
        const hasLand = !!anim && !!this._playerClips?.land;
        const h = this._playerHeight > 0 ? this._playerHeight : cc.cfg.eyeHeight / 0.94;
        let wet = 0;
        if (on) { try { wet = this.playWetness?.() ?? 0; } catch { wet = 0; } }
        try {
            this._playDust.tick({
                enabled: on, feet: cc.pos, facing: cc.facing, vx: cc.vel[0], vz: cc.vel[2], grounded: cc.grounded,
                landImpact: loco.landImpact ?? 0,
                landCount: hasLand ? anim!.landCount : undefined, lastLanding: hasLand ? anim!.lastLanding : null,
                gaitPhase: anim ? anim.gaitPhase : undefined, moveWeight: anim ? anim.weights.move : undefined, runMix: anim ? anim.runMix : undefined,
                sneaking: !!loco.sneaking, scale: h / 1.7, wet,
            }, this._dustEnv);
        } catch { /* a cosmetic effect never breaks the Play tick */ }
    }

    /** The per-character seed string for a rig: the auto player's fixed seed, else its procedural body's id, else the
     *  skeleton id (gait personality, jump-variant sequence, secondary motion). */
    private _locoCharacterSeed(skelId: string): string {
        if (this.autoPlayer.isRuntimeNode(skelId)) return 'auto-player:' + AUTO_PLAYER_SEED;
        const body = this.getAllMeshes().find(m => m instanceof SkinnedMesh3D && this._isCharacterBody(m) && m.skeletonId === skelId);   // v1 or v2 body (stable id)
        return body?.id ?? skelId;
    }

    /** Put the engine-driven rig back in the pose it had when the engine took it (Stop / avatar swap). */
    private _restoreLocoRest(): void {
        const r = this._locoRest;
        this._locoRest = null;
        if (!r) return;
        const skel = this.getSkeleton(r.skelId);
        if (!skel) return;
        writePoseToSkeleton(r.pose, skel);
        skel.computeWorldMatrices();
        this._keepSpringsAlive(r.skelId);
        this.ctx.scheduleRender();
    }

    /** Arm clearance (deg) for the default Play clips of a procedural body (item 13): the arm-clearance fit of the
     *  RELAXED stance on this body (resolveArmClearance) + room for its top's bulk (playArmClearance). 0 for a skeleton
     *  without a procedural body or when the fit fails. Cached per body + top (the fit skins the body a few dozen times). */
    private _playArmClearanceCache = new Map<string, { key: string; verts: Float32Array; top: Float32Array | null; deg: number }>();
    private _playArmClearance(skel: Skeleton3D): number {
        const body = this.getAllMeshes().find(m => m instanceof SkinnedMesh3D && this._isCharacterBody(m) && m.skeletonId === skel.id) as SkinnedMesh3D | undefined;
        if (!body?.geometry || !body.jointIndices || !body.jointWeights) return 0;
        // The top (if any) joins the fit: sleeves / bare forearms against its torso panel (a bulky jacket).
        const topId = this._character.getClothingMeshId(body.id, 'top');
        const top = topId ? this.getMesh(topId) as SkinnedMesh3D | null : null;
        const topGeo = top instanceof SkinnedMesh3D && top.geometry && top.jointIndices && top.jointWeights ? top : null;
        // + blendVersion: a Character v2 body is re-shaped IN PLACE by its sliders (same vertex array), so the array
        // identity below alone kept a stale fit (a v1 body has no blend shapes: its blendVersion never moves).
        const key = `${skel.skinningMethod}:${topGeo ? topGeo.geometry!.vertices.length : 0}:${body.blendVersion}`;
        const hit = this._playArmClearanceCache.get(body.id);
        if (hit && hit.key === key && hit.verts === body.geometry.vertices && hit.top === (topGeo?.geometry?.vertices ?? null)) return hit.deg;
        const joints = skel.data.joints;
        const m: SkinnedMeshData = {
            vertices: body.geometry.vertices, stride: 12, posOffset: 0, indices: body.geometry.indices,
            jointIndices: body.jointIndices, jointWeights: body.jointWeights, jointNames: joints.map(j => j.name),
            jointParents: Int16Array.from(joints.map(j => j.parentIndex)),
            jointLocalPositions: Float32Array.from(joints.flatMap(j => [j.localPosition[0], j.localPosition[1], j.localPosition[2]])),
            inverseBindMatrices: Float32Array.from(joints.flatMap(j => Array.from(j.inverseBindMatrix))),
        };
        const relaxed = relaxedStance();
        const rot = new Map(joints.map(j => [j.name, [...(relaxed[j.name] ?? [0, 0, 0, 1])] as [number, number, number, number]]));
        let deg = 0;
        const outfit = topGeo ? withGarments(m, [{ vertices: topGeo.geometry!.vertices, indices: topGeo.geometry!.indices, jointIndices: topGeo.jointIndices!, jointWeights: topGeo.jointWeights! }]) : m;
        try { deg = playArmClearance(resolveArmClearance(outfit, rot, skel.skinningMethod)); } catch { deg = 0; }
        this._playArmClearanceCache.set(body.id, { key, verts: body.geometry.vertices, top: topGeo?.geometry?.vertices ?? null, deg });
        return deg;
    }

    /** Re-install the auto player's default locomotion clips fitted to its body + outfit (its skeleton is runtime-only,
     *  so this never reaches a document). */
    private _refitAutoPlayerClips(skelId: string): void {
        const skel = this.getSkeleton(skelId);
        if (!skel) return;
        const clips = (skel.data.clips ??= []);
        for (const c of buildLocomotionClips(skel.data.joints, { armClearance: this._playArmClearance(skel), variation: this._locoCharacterSeed(skelId) })) {
            if (!DEFAULT_LOCOMOTION_CLIP_NAMES.includes(c.name)) continue;
            const i = clips.findIndex((k) => k.name === c.name);
            if (i >= 0) clips[i] = c; else clips.push(c);
        }
    }

    /** A user Player with no locomotion set and no host handler gets the DEFAULT gait: its own "Walk"/"Run" clips if it
     *  has them, else runtime-generated ones (default-locomotion.ts, never saved; their arms fitted to this body +
     *  outfit), idling on its own "Idle" clip, else the runtime "Stand" (item 13: was the stock torso-only "Breathe"),
     *  else "Breathe", else the rest pose. No-op for a rig the gait can't drive (non-humanoid). */
    private _bindDefaultGait(skelId: string): void {
        const skel = this.getSkeleton(skelId);
        if (!skel) return;
        const own = this.getSkeletonClips3D(skelId);
        const has = (n: string) => own.some((c) => c.name === n);
        const runtime = buildLocomotionClips(skel.data.joints, { armClearance: this._playArmClearance(skel), variation: this._locoCharacterSeed(skelId) }).filter((c) => !has(c.name));
        const avail = (n: string) => has(n) || runtime.some((c) => c.name === n);
        if (!avail('Walk')) return;
        this._locoRuntimeClips = runtime;
        const idle = has('Idle') ? 'Idle' : avail(LOCOMOTION_CLIP.idle) ? LOCOMOTION_CLIP.idle : has('Breathe') ? 'Breathe' : Scene3DManager.LOCO_REST_CLIP;
        const opt = (n: string) => (avail(n) ? n : undefined);
        // Jump VARIETY only when the Jump is the runtime one (an own "Jump" clip plays as authored, every jump); the
        // STROLL only under a runtime Walk (it would not match an authored walk's stride).
        const ownWalk = has('Walk'), ownJump = has('Jump');
        const jumps = ownJump ? undefined : JUMP_VARIANT_CLIPS.filter((n) => runtime.some((c) => c.name === n));
        this._bindEngineLocomotion(skelId, {
            idle, walk: 'Walk', run: opt('Run'), sneak: opt('Sneak'), crouch: opt('Crouch'), jump: opt('Jump'), fall: opt('Fall'), land: opt('Land'),
            ...(jumps && jumps.length >= 2 ? { jumps } : {}), ...(!ownWalk && avail('Stroll') ? { stroll: 'Stroll' } : {}),
            // The JOG (2026-10-04) only under the runtime Run (it is matched to that run's stride and phase).
            ...(!has('Run') && avail('Jog') ? { jog: 'Jog' } : {}),
        });
        this._locoDefaultGait = true;
        this._locoRuntimeGait = !ownWalk;
        // Idle variety (2026-10-04) only over the RUNTIME Stand: an authored Idle (or an own Stand) plays as authored.
        if (idle === LOCOMOTION_CLIP.idle && !has(LOCOMOTION_CLIP.idle)) this._bindIdleVariants(skelId);
    }

    /** A clip by name for the engine locomotion: the skeleton's own, then the runtime gait, then the synthetic rest. */
    private _locoClip(skelId: string, name: string): SkeletonAnimClip | null {
        const own = this.getSkeletonClips3D(skelId).find((c) => c.name === name);
        if (own) return own;
        const rt = this._locoRuntimeClips.find((c) => c.name === name);
        if (rt) return rt;
        const iv = this._locoIdleVariants.length ? this._locoIdleVariants.find((c) => c.name === name) : undefined;
        if (iv) return iv;
        if (name === Scene3DManager.LOCO_REST_CLIP) return { id: name, name, startFrame: 0, endFrame: 24, fps: 24, tracks: [] };
        return null;
    }

    /** Enable/disable the 1D locomotion blend tree (continuous idle↔walk↔run mix by speed, §8) for the bound
     *  Player. Requires a locomotion set (setPlayerLocomotionSet3D). Pass an object to override walk/run speeds,
     *  `true` for defaults, or null/false to go back to discrete crossfades. Persisted with the player binding. */
    setPlayerLocomotionBlend3D(cfg: Partial<LocomotionBlendConfig> | boolean | null): void {
        if (cfg === null || cfg === false) { this._locoBlend = null; return; }
        const base = DEFAULT_LOCOMOTION_BLEND;
        this._locoBlend = cfg === true
            ? { ...base }
            : { walkSpeed: cfg.walkSpeed ?? base.walkSpeed, runSpeed: cfg.runSpeed ?? base.runSpeed };
    }
    getPlayerLocomotionBlend3D(): LocomotionBlendConfig | null { return this._locoBlend ? { ...this._locoBlend } : null; }

    /** Layer a masked overlay clip (e.g. a wave/aim) over the Player's locomotion: it drives only `region`'s joints
     *  ('upperBody'/'lowerBody'/'arms'/'head' or an explicit joint-name array) while the rest keep walking. `clip` is
     *  a library-entry id, clip id, or clip name. Pass null to clear. Requires the blend tree (setPlayerLocomotionBlend3D).
     *  Persisted with the player binding. */
    setPlayerAnimationOverlay3D(clip: string | null, region: RegionMask = 'upperBody', opts?: { mode?: 'replace' | 'additive'; weight?: number }): void {
        this._playerOverlayRef = clip ? { clip, region, mode: opts?.mode, weight: opts?.weight } : null;
        this._overlayPhase = 0;
        this._resolvePlayerOverlay();
    }
    getPlayerAnimationOverlay3D(): { clip: string; region: RegionMask; mode: 'replace' | 'additive'; weight: number } | null {
        const r = this._playerOverlayRef;
        return r ? { clip: r.clip, region: r.region, mode: r.mode ?? 'replace', weight: r.weight ?? 1 } : null;
    }

    /** Resolve the raw overlay request against the bound avatar's skeleton: clip ref → clip NAME, region → joint-index
     *  mask. No-op (clears the resolved overlay) without a bound skeleton, a resolvable clip, or a non-empty mask. */
    private _resolvePlayerOverlay(): void {
        this._playerOverlay = null;
        const ref = this._playerOverlayRef;
        const skelId = this._playerSkeletonId();
        if (!ref || !skelId) return;
        // Resolve clip ref (library entry id / clip id / clip name) → a clip NAME on the skeleton (mirrors _applyLocomotionSet).
        let clipName: string | undefined;
        const existing = this.getSkeletonClips3D(skelId).find((c) => c.id === ref.clip || c.name === ref.clip);
        if (existing) clipName = existing.name;
        else {
            const newId = this.applyLibraryEntry3D(ref.clip, skelId);
            if (newId) clipName = this.getSkeletonClips3D(skelId).find((c) => c.id === newId)?.name;
        }
        if (!clipName) return;
        const skel = this.getSkeleton(skelId);
        if (!skel) return;
        const joints = skel.data.joints.map((j, index) => ({ index, name: j.name }));
        const mask = resolveRegionMask(joints, ref.region);
        if (mask.length === 0) return;
        this._playerOverlay = { clipName, mask, mode: ref.mode ?? 'replace', weight: ref.weight ?? 1 };
    }

    /**
     * Render an ANIMATED preview of a clip on a skeleton — a turntable loop for the Animation Library thumbnail
     * (animation-library-and-triggers.md §8). Poses the skeleton across the clip while a camera orbits it, snapshots
     * each step, and returns the frames as PNG data URLs the host plays back as a loop (or lays out as a strip).
     * Non-destructive: camera, skeleton pose, and (with `isolate`) mesh visibility are all restored on exit. The
     * skeleton must have `clipRef` (clip id or name) already on it — to preview a Library entry, apply it first with
     * {@link applyLibraryEntry3D}. Returns null if the skeleton or clip can't be found.
     *
     * ★ GPU path: renders real frames, so it's verified in the browser, not the unit harness (the planning/orbit math
     * in turntable-preview.ts is what's unit-tested).
     */
    async captureAnimationPreview3D(
        skeletonId: string,
        clipRef: string,
        opts?: { frames?: number; size?: number; turns?: number; pitchDeg?: number; margin?: number; isolate?: boolean; fps?: number },
    ): Promise<{ frames: string[]; width: number; height: number; frameCount: number; fps: number } | null> {
        const skel = this.getSkeleton(skeletonId);
        if (!skel) return null;
        const clip = this.getSkeletonClips3D(skeletonId).find(c => c.id === clipRef || c.name === clipRef);
        if (!clip) return null;

        const frames = Math.max(1, Math.floor(opts?.frames ?? 24));
        const size = Math.max(16, Math.floor(opts?.size ?? 256));
        const pitch = (opts?.pitchDeg ?? 12) * Math.PI / 180;
        const margin = opts?.margin ?? 1.4;
        const fps = opts?.fps ?? 24;
        const isolate = opts?.isolate !== false;

        // ── Save every bit of state we touch, so the live scene is untouched afterwards. ──
        const cam = this.renderer3D.getCamera();
        const savedCam = { position: [cam.position[0], cam.position[1], cam.position[2]] as [number, number, number], target: [cam.target[0], cam.target[1], cam.target[2]] as [number, number, number], fov: cam.fov, mode: cam.mode };
        const savedPose = this.snapshotSkeletonPose3D(skeletonId);
        if (!savedPose) return null;
        const meshes = this.getAllMeshes();
        const savedVis: { m: Mesh3D; v: boolean }[] = isolate ? meshes.map(m => ({ m, v: m.visible })) : [];
        if (isolate) for (const m of meshes) m.visible = (m instanceof SkinnedMesh3D && m.skeletonId === skeletonId);
        cam.mode = 'perspective';

        try {
            // Frame the camera ONCE from the first posed frame's joint world positions (stable framing across the spin).
            applySkeletonClipAtFrame(clip, skel, clip.startFrame);
            skel.computeWorldMatrices();
            const jpts = skel.data.joints.map(j => [j.worldMatrix[12], j.worldMatrix[13], j.worldMatrix[14]] as [number, number, number]);
            const { center, radius } = boundsCenterRadius(jpts);
            const fovY = cam.fov || (Math.PI / 4);
            const plan = planTurntable({ frames, clipStartFrame: clip.startFrame, clipEndFrame: clip.endFrame, turns: opts?.turns ?? 1 });

            const out: string[] = [];
            for (const step of plan) {
                applySkeletonClipAtFrame(clip, skel, step.frame);
                skel.computeWorldMatrices();
                const pose = orbitCameraPose(center, radius, step.yaw, pitch, fovY, margin);
                this.renderer3D.uiSetCamera(pose.position, pose.target);
                this.ctx.scheduleRender();
                const blob = await this.ctx.webgpuRenderer.snapshotToBlob(size);
                out.push(await Scene3DManager._blobToDataUrl(blob));
            }
            return { frames: out, width: size, height: size, frameCount: out.length, fps };
        } finally {
            if (isolate) for (const { m, v } of savedVis) m.visible = v;
            writePoseToSkeleton(savedPose, skel);
            skel.computeWorldMatrices();
            cam.position[0] = savedCam.position[0]; cam.position[1] = savedCam.position[1]; cam.position[2] = savedCam.position[2];
            cam.target[0] = savedCam.target[0]; cam.target[1] = savedCam.target[1]; cam.target[2] = savedCam.target[2];
            cam.fov = savedCam.fov; cam.mode = savedCam.mode;
            this.ctx.scheduleRender();
        }
    }

    /** Blob → PNG data URL (FileReader where available, else an OffscreenCanvas/base64 fallback for workers). */
    private static async _blobToDataUrl(blob: Blob): Promise<string> {
        if (typeof FileReader !== 'undefined') {
            return await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(r.result as string);
                r.onerror = () => reject(r.error);
                r.readAsDataURL(blob);
            });
        }
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
    }

    /** Per-tick engine locomotion: advance the state machine, sample each weighted clip against the rest pose, blend,
     *  add the additive layers (landing) and the procedural lean / head lead, layer any masked overlay, write the pose.
     *  `loco` carries REAL world speeds (Round 8): the animator's blend points are the controller's gait speeds and its
     *  stride matching uses each clip's own ground speed scaled by the avatar's size. */
    private _driveLocomotionAnimator(skelId: string, loco: LocomotionState, dt: number, cc: CharacterController): void {
        // Walk style (2026-10-03): 'stomp' swaps the RUNTIME default Walk for the Stomp clip (never an authored walk).
        const clips = this._playerClips && this._locoRuntimeGait
            ? applyWalkStyle(this._playerClips, this.playSettings.walkStyle, (n) => !!this._locoClip(skelId, n))
            : this._playerClips;
        const skel = this.getSkeleton(skelId);
        if (!clips || !skel) return;
        if (!this._locoRest || this._locoRest.skelId !== skelId) {
            const pose = this.snapshotSkeletonPose3D(skelId);
            if (!pose) return;
            this._locoRest = { skelId, pose };
        }
        const rest = this._locoRest.pose;
        const b = this._locoBlend, mpu = this.getPlayMetresPerUnit3D();
        const ac = this._locoAnim.cfg;
        // Blend points: a setPlayerLocomotionBlend3D override (m/s) or the controller's own walk / run speeds.
        ac.walkSpeed = b ? b.walkSpeed / mpu : cc.walkTopSpeed();
        ac.runSpeed = b ? Math.max(b.runSpeed, b.walkSpeed + 0.01) / mpu : Math.max(cc.cfg.moveSpeed, ac.walkSpeed + 1e-3);
        // Stride matching: a clip with a ground speed (the runtime default gaits) is planted for groundSpeed × the rig's
        // world scale; any other clip for the blend point it stands for.
        const rigScale = Math.abs(this._playerMesh?.scaleY ?? 1) || 1;
        const clipSpeed = (name: string | undefined) => { const c = name ? this._locoClip(skelId, name) : null; return c?.groundSpeed ? c.groundSpeed * rigScale : null; };
        ac.walkClipSpeed = clipSpeed(clips.walk); ac.runClipSpeed = clipSpeed(clips.run);
        ac.sneakClipSpeed = clipSpeed(clips.sneak) ?? cc.cfg.sneakSpeed;
        ac.jumpTakeoff = (clips.jump ? this._locoClip(skelId, clips.jump)?.takeoffPhase : 0) ?? 0;   // the default Jump's wind-up part
        ac.jumpVariety = this.playSettings.jumpVariety;
        ac.strollClipSpeed = clipSpeed(clips.stroll);
        ac.jogClipSpeed = clipSpeed(clips.jog);
        const secs = (c: SkeletonAnimClip) => Math.max((c.endFrame - c.startFrame) / Math.max(c.fps, 1), 1 / 60);
        // Idle variety (2026-10-04): the runtime idle variants over the runtime Stand, gated by the Play setting.
        ac.idleVariety = this.playSettings.idleVariety;
        const animClips = this._locoIdleNames.length ? { ...clips, idles: this._locoIdleNames } : clips;
        // `info` = each clip's take-off phase + jump-variant weights (the runtime jumps carry them; authored clips don't).
        const layers = this._locoAnim.update(dt, loco, animClips, (n) => { const c = this._locoClip(skelId, n); return c ? secs(c) : 0; }, (n) => this._locoClip(skelId, n));
        if (this._locoIdleNames.length) this._fireIdleFace(skelId);
        let pose = composeLocomotionPose(layers, (n) => this._locoClip(skelId, n), rest);
        // Procedural lean into acceleration / turns + the head leading a turn (the engine's own humanoid rigs only —
        // their joints are identity at rest, so a parent-frame axis turn means what it says).
        if (this._locoProcedural) {
            const names = skel.data.joints.map((j) => j.name);
            const lean = this._locoLean.update(dt, cc.vel[0] * mpu, cc.vel[2] * mpu, cc.facing, cc.cfg.moveSpeed * mpu, cc.grounded, cc.turnRemaining());
            applyLocomotionLean(names, pose, lean);
            // Secondary motion (gait feel 2026-10-03) over the RUNTIME default gaits only: follow-through, per-cycle arm
            // variation, head drift, scaled by the Play setting "motion looseness" (0 = the clips exactly).
            if (this._locoRuntimeGait) {
                this._locoSecondary.cfg.looseness = this.playSettings.getMotionLooseness();
                if (this._locoSecondary.cfg.looseness > 0) applyLocomotionSecondary(names, pose, this._locoSecondary.update(dt, secondaryInputFor(this._locoAnim, this._locoLean.accel, cc.grounded)));
            }
        }
        // Optional masked overlay (wave/aim), advanced on its OWN looping phase so it's independent of gait speed.
        const ov = this._playerOverlay;
        if (ov) {
            const oc = this._locoClip(skelId, ov.clipName);
            if (oc) {
                this._overlayPhase = (this._overlayPhase + dt / secs(oc)) % 1;
                const oPose = sampleClipPose(oc, rest, oc.startFrame + this._overlayPhase * (oc.endFrame - oc.startFrame));
                pose = ov.mode === 'additive'
                    ? addPoseMasked(pose, oPose, sampleClipPose(oc, rest, oc.startFrame), ov.weight, ov.mask)
                    : overlayPoseMasked(pose, oPose, ov.mask);
            }
        }
        writePoseToSkeleton(pose, skel);
        this._keepSpringsAlive(skelId);
        this.ctx.scheduleRender();
    }

    /** True while the engine drives one of its OWN humanoid rigs (the auto default player / the default gait), whose
     *  joint rest rotations are identity — the procedural lean is only applied there. */
    private get _locoProcedural(): boolean {
        return this._locoDefaultGait || this._isAutoPlayerMesh(this._playerMesh);
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
        if (hit) { this._interactHandler?.(hit.id); this._scriptRunner?.fireInteract(hit.id); }
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
    /** True while Play mode is running (the game loop drives live player transforms + locomotion pose). The
     *  autosave timer skips while this holds so a transient mid-play frame isn't persisted (would reload the doc
     *  with the character teleported to its walked-to position + frozen mid-stride). Pre-play state is restored
     *  on exit and saves normally then. */
    isPlayModeActive(): boolean { return this._playLoop !== null; }

    enterPlayMode3D(opts?: { start?: [number, number, number]; config?: Partial<CharacterConfig>; keyboard?: boolean; mouseLook?: boolean; collision?: boolean; playerMeshId?: string; gamepad?: boolean }): void {
        if (this._playing) return;
        try { this._enterPlayMode3D(opts); this._beginPlayOutlines(); }
        catch (e) {
            // bug-hunt 2026-10-01: a throw part-way (locomotion bind, library apply, …) left the WASD keydown
            // preventDefault + canvas pointer-lock listeners live in the EDITOR (exit no-op'd: _playing was still
            // false) and the editor suspended. Unwind whatever was set up, then rethrow.
            if (!this._playing) { this._playing = true; try { this.exitPlayMode3D(); } catch { /* best effort */ } }
            throw e;
        }
    }
    private _enterPlayMode3D(opts?: {
        start?: [number, number, number];
        config?: Partial<CharacterConfig>;
        keyboard?: boolean;
        mouseLook?: boolean;
        collision?: boolean;
        playerMeshId?: string;
        gamepad?: boolean;
    }): void {
        if (this._playing) return;
        // Play owns the camera — it's mutually exclusive with cut-preview and manual look-through (all three drive
        // the render cam). Tear those down FIRST so _prePlayCam below snapshots the real edit camera, not a shot pose.
        if (this._previewThroughCameras) this.setPreviewThroughCameras3D(false);
        if (this._lookThroughCamId !== null) this.lookThroughCamera3D(null);
        const cam = this.renderer3D.getCamera();
        this._prePlayCam = { pos: [cam.position[0], cam.position[1], cam.position[2]], target: [cam.target[0], cam.target[1], cam.target[2]], mode: (cam.mode === 'orthographic' ? 'orthographic' : 'perspective') };
        this._prePlayXforms = this._snapshotTransforms();
        // Stop's _applyViewState restores the free3D vantage from _viewState.freeCam (overriding _prePlayCam), and that
        // is only captured on a mode switch / save — so Stop jumped to a stale pose or reframed (bug-hunt 2026-10-01).
        if (this._viewState.cameraMode === 'free3D' && !this._inCameraSubMode()) this._captureCurrentPose();
        // Bind the "Player" avatar (if any): the controller drives its transform each tick, and its spawn defaults to
        // wherever the avatar sits in the scene. See setPlayerObject3D.
        const playerId = opts?.playerMeshId ?? this._playerMeshId;
        this._playerMesh = playerId ? (this.getAllMeshes().find(m => m.id === playerId) ?? null) : null;
        // NOT written back to _playerMeshId (bug-hunt 2026-10-01): a Player still restoring async (GLB / character) or a
        // one-off opts.playerMeshId used to wipe / replace the PERSISTED binding, and the next save dropped player.meshId.
        // Measure the bound avatar so the camera frames THIS body (not a hardcoded ~1.7-unit human) and so a
        // non-feet origin is driven at the right height. Spawn the FEET at the avatar's bbox bottom, not its
        // origin — a center-origin avatar would otherwise drop by half its height on the first gravity tick.
        if (this._playerMesh) this._measureBoundAvatar(this._playerMesh); else { this._playerHeight = 0; this._playerFootToOrigin = 0; this._playerPartIds.clear(); }
        const start = opts?.start ?? (this._playerMesh
            ? [this._playerMesh.x, this._playerMesh.y - this._playerFootToOrigin, this._playerMesh.z] as [number, number, number]
            : [cam.position[0], 0, cam.position[2]]);
        // Controller config = the play settings (first-person eye height, T5.1) overridden by the host's own config.
        this._playOptsConfig = opts?.config ? { ...opts.config } : undefined;
        const explicitCfg = this._explicitPlayConfig();
        // Scale-correct defaults (metres → world units; move speed from the settings) under the explicit overrides.
        const controller = new CharacterController({ ...this._playScaleConfig(), ...explicitCfg }, start);
        this._playController = controller;
        this._applyAvatarCameraFraming(controller, explicitCfg);
        this._playInput = { forward: 0, right: 0, look: 0, jump: false };
        // Collision against real scene geometry (opt-out → flat fallback plane). Ground = downward ray per tick;
        // walls = horizontal ray along the move. An XZ broadphase grid (built now over the static mesh set) means
        // each cast only tests nearby meshes, so it scales to a street-sized city. BVHs still build lazily per mesh
        // on first contact — but only for meshes the character actually approaches.
        // Heading: camera AND body start along the avatar's authored facing (it faces +Z at rest, so rotationY is its
        // heading), else along the edit camera's view, so Play doesn't spin the view / the character on enter.
        {
            const third = controller.cfg.cameraMode === 'third';
            const heading = this._playerMesh ? this._playerMesh.rotationY
                : Math.atan2(cam.target[0] - cam.position[0], cam.target[2] - cam.position[2]);
            controller.setHeading(Number.isFinite(heading) ? heading : 0, third ? -0.3 : 0);
        }
        controller.running = this._playRunning;
        controller.sneaking = false;
        if (opts?.collision !== false) {
            this._buildCollisionGrid();
            // Ground = the STANDABLE surface under the feet (collision-math sampleStandableGround): the ray starts at
            // feet + stepHeight (nothing higher is ever ground: an awning / canopy / bridge deck / bench overhead or
            // ahead is not the floor) and a step UP needs headroom (no foliage-card / low-beam cascades).
            controller.groundSampler = (x, z) => {
                const skips = this._picker.bvhSkips;
                const g = sampleStandableGround(this._rayCaster(this._groundCandidates(x, z)), x, z,
                    controller.pos[1], controller.cfg.stepHeight, controller.cfg.eyeHeight);
                // P10.D: a mesh under the feet was skipped by the BVH-build budget this frame (a freshly streamed tile)
                // → hold the current height for this frame instead of falling.
                return g === null && this._picker.bvhSkips !== skips ? controller.pos[1] : g;
            };
            controller.moveResolver = (fx, fz, tx, tz, r) => this._resolveWallMove(controller, fx, fz, tx, tz, r);
            // Spawned from the camera (no Player, no explicit start): stand on the first surface under the camera with
            // room to stand (never inside / on top of a canopy's inner cards), instead of at y = 0.
            if (!opts?.start && !this._playerMesh) {
                const g = findStandableGround(this._rayCaster(this._groundCandidates(start[0], start[2]), false), start[0], start[2], cam.position[1], controller.cfg.eyeHeight);
                if (g !== null) { controller.teleport([start[0], g, start[2]]); controller.grounded = true; }
            }
        }
        this._tpCam.reset(); this._camLastMs = 0;   // third-person follow smoothing starts fresh (first frame snaps)
        this._lookAccumYaw = 0; this._lookAccumPitch = 0;
        this._locoDriver.reset();                    // first tick emits the initial locomotion clip (idle)
        this._triggerSystem.reset();                 // enter events fire fresh from the spawn position
        this._lastInteract = false;                  // don't fire a stale "use" on the first tick
        // Built-in WASD keyboard unless the host opts out (to feed its own input via setPlayInput3D).
        if (opts?.keyboard !== false) { this._keyboard = new KeyboardInput({ sneakKeys: true }); this._keyboard.attach(); this._lockPlayKeys(true); }
        // Built-in pointer-lock mouse-look unless opted out — click the canvas to capture the pointer.
        if (opts?.mouseLook !== false) { this._mouseLook = new MouseLook(); this._mouseLook.attach(this.ctx.webgpuRenderer.getCanvas() as unknown as Element | null); }
        // Built-in gamepad unless opted out (left stick move, right stick orbit, A jump, X use, L3 / Y walk-run).
        if (opts?.gamepad !== false) { this._gamepad = new GamepadInput(); this._padReading = null; this._padRunToggles = 0; this._padSneakToggles = 0; }
        this._playSneakToggle = false; this._playSneaking = false; this._locoLean.reset(); this._locoSecondary.reset(); this._playDust.reset();
        // Player avatar visibility: in first-person you're INSIDE the body (hide it, so it doesn't fill the view);
        // in third-person you follow it (keep it shown). Restored on exit.
        if (this._playerMesh) {
            this._playerPrevVisible = this._playerMesh.visible;
            this._playerMesh.visible = controller.cfg.cameraMode === 'third';
            this._drivePlayerMesh(controller);
        }
        // Now the avatar (and its skeleton) is bound — resolve any locomotion set against it; a user Player with no
        // set and no host handler gets the default gait (runtime clips, never saved).
        this._overlayPhase = 0; this._resolvePlayerOverlay();   // resolve any masked overlay against the bound avatar
        this._applyLocomotionSet();
        {
            const skelId = this._playerSkeletonId();
            if (skelId && !this._locoEngineSkelId && !this._playerAnimHandler && this._playerMesh && !this._isAutoPlayerMesh(this._playerMesh)) this._bindDefaultGait(skelId);
        }
        // Auto default player (T5.2): third-person with no Player → spawn the runtime default character (async the
        // first time; cached after). Never touches the persisted player binding.
        if (PlayAutoPlayer.shouldSpawn({ enabled: this.playSettings.autoDefaultPlayer, cameraMode: controller.cfg.cameraMode, hasPlayer: this._playerMesh !== null })) {
            void this._spawnAutoPlayer(controller);
        }
        cam.mode = 'perspective';
        this._prePlayFov = cam.fov;
        this._applyPlayFov(controller);
        this._flyController?.disable();                         // Play owns input now (fly re-applies on exit)
        this.disableOrbitControls();                            // the controller owns the camera now
        // Round 8: editor input + overlays off for the run (keyboard shortcuts, 2D pointer, hover pick / outline,
        // click-select + gizmo drag, selection / gizmo / bone / snap / frustum overlays). Restored on Stop.
        this._setEditorSuspended(true);
        this._playLoop = new GameLoop();
        this._playLoop.start(
            (dt) => {
                const cc = this._playController; if (!cc) return;
                // Merge keyboard (WASD/turn/jump) + gamepad (left stick / A / X) or the host-fed intent. Mouse / right
                // stick / host look deltas are applied per RENDER frame (crisp at any refresh rate), not here.
                // readTick (not read): a Space TAP that went down AND up between two ticks still jumps (item 13).
                // TOUCH-4: the host intent (a virtual joystick / Jump / Use) is MERGED with the keyboard, like the pad —
                // it used to be ignored whenever the built-in keyboard was attached.
                const base: CharacterInput = this._keyboard ? mergeHostPlayInput(this._keyboard.readTick(), this._playInput) : { ...this._playInput };
                base.lookYaw = 0; base.lookPitch = 0;
                const pad = this._padReading;
                if (pad?.active) {
                    const f = base.forward + pad.forward, r = base.right + pad.right;
                    base.forward = Math.max(-1, Math.min(1, f)); base.right = Math.max(-1, Math.min(1, r));
                    base.jump = base.jump || pad.jump;
                    base.interact = (base.interact ?? false) || pad.interact;
                }
                // Walk / run toggle: Shift (a press, not a hold) or L3 / Y on a pad.
                const toggles = (this._keyboard ? this._keyboard.takePress('ShiftLeft', 'ShiftRight') : 0) + this._padRunToggles;
                this._padRunToggles = 0;
                if (toggles % 2 === 1) this._setRunning(cc, !cc.running);
                // Sneak (Round 8): Ctrl held, or C / pad B toggled.
                const sneakToggles = (this._keyboard ? this._keyboard.takePress('KeyC') : 0) + this._padSneakToggles;
                this._padSneakToggles = 0;
                if (sneakToggles % 2 === 1) this._playSneakToggle = !this._playSneakToggle;
                this._setSneaking(cc, this._playSneakToggle || (this._keyboard?.ctrlHeld() ?? false));
                this._collisionCellsTick(cc);   // step 3: collision cells around the player (validate / request / gather)
                cc.update(dt, base);
                // For scripts' ctx.input: the look applied at render rate since the previous tick.
                base.lookYaw = this._lookAccumYaw; base.lookPitch = this._lookAccumPitch;
                this._lookAccumYaw = 0; this._lookAccumPitch = 0;
                const loco = cc.locomotion();
                const animLoco = this._locoForAnim(cc, loco);   // speed at the default move speed → thresholds follow
                // Avatar locomotion animation. Engine-driven rigs run the LocomotionAnimator state machine every tick
                // (crossfaded idle ⇄ walk ⇄ run, jump / fall); a host-owned handler gets a clip NAME on transitions.
                if (this._locoEngineSkelId) {
                    this._driveLocomotionAnimator(this._locoEngineSkelId, loco, dt, cc);
                } else if (this._playerClips && this._playerAnimHandler) {
                    const clip = this._locoDriver.update(animLoco, this._playerClips);
                    if (clip) this._playerAnimHandler(clip);
                }
                // Landing dust (2026-10-04): landing puffs / running footstep puffs / wet splashes (no-op while idle).
                this._tickPlayDust(cc, loco);
                // Publish player movement as UI-machine variables (player.speed/moving/… — §4.3); the handler
                // (wired by ShapeManager) writes them into the active UI layer, change-gated. No-op with no UI.
                this._playerParamHandler?.(loco);
                // Trigger volumes: fire enter/exit as the player's feet cross scene zones.
                if (this._triggerHandler || this._scriptRunner) {
                    const events = this._triggerSystem.update(cc.pos, this._triggerScratch);
                    for (const e of events) { this._triggerHandler?.(e); this._scriptRunner?.fireTrigger(e.id, { type: e.type, id: e.id }); }
                }
                // Interaction "use" verb: edge-detect the use key → fire the nearest in-range interactable once.
                const interact = base.interact ?? false;
                if (interact && !this._lastInteract) this._fireInteract();
                this._lastInteract = interact;
                // Script Behaviors: publish the merged input (for ctx.input) then tick every live behavior.
                this._lastPlayBase = base;
                this._scriptRunner?.tick(dt);
            },
            (alpha) => {
                const cc = this._playController; if (!cc) return;
                const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                const rdt = this._camLastMs ? Math.min(0.1, (now - this._camLastMs) / 1000) : 0;
                this._camLastMs = now;
                // Look at render rate: pointer-lock mouse + right stick + host-fed deltas (consumed once).
                let ly = 0, lp = 0;
                if (this._mouseLook) { const d = this._mouseLook.consume(); ly += d.yaw; lp += d.pitch; }
                if (this._gamepad) {
                    const pad = this._gamepad.poll();
                    this._padReading = pad;
                    this._padRunToggles += pad.runToggle;
                    this._padSneakToggles += pad.sneakToggle;
                    if (pad.active) { ly += pad.lookX * Scene3DManager.PAD_YAW_RATE * rdt; lp += pad.lookY * Scene3DManager.PAD_PITCH_RATE * rdt; }
                }
                // Host-fed look deltas (setPlayInput3D lookYaw / lookPitch) are consumed ONCE, alongside any built-in input.
                ly += this._playInput.lookYaw ?? 0; lp += this._playInput.lookPitch ?? 0;
                this._playInput.lookYaw = 0; this._playInput.lookPitch = 0;
                if (ly !== 0 || lp !== 0) { cc.applyLook(ly, lp); this._lookAccumYaw += ly; this._lookAccumPitch += lp; }
                // Draw between the last two fixed steps (no stutter when the display rate ≠ the 60 Hz sim).
                const feet = cc.renderPos(alpha);
                this._lastPlayerFeet = [feet[0], feet[1], feet[2]];   // visual-polish #16 (the player's contact blob)
                if (this._playerMesh) this._drivePlayerMesh(cc, feet, cc.renderFacing(alpha));
                let eye: [number, number, number], tgt: [number, number, number];
                if (cc.cfg.cameraMode === 'third') {
                    [eye, tgt] = this._thirdPersonCamera(cc, feet, rdt);
                    this._cameraOccluderFadeTick(cc, eye, rdt);   // soft occluders between the camera and the player dither out
                } else {
                    if (this._camFaded.size) this._clearCameraFades();
                    // First-person is rigid to the head (no smoothing).
                    const f = cc.forwardDir();
                    eye = [feet[0], feet[1] + cc.cfg.eyeHeight, feet[2]];
                    tgt = [eye[0] + f[0], eye[1] + f[1], eye[2] + f[2]];
                }
                cam.lookAt(eye[0], eye[1], eye[2], tgt[0], tgt[1], tgt[2]);
                this._updatePlayerLight(cc, feet, eye);   // visual-polish #7c (no-op while the light is off)
                this._playDust.frame(rdt, this.renderer3D);   // landing dust: advance + (un)register (nothing when idle)
                this.ctx.scheduleRender();
            },
        );
        // Script Behaviors: compile + start the enabled ones (onStart now; onTick each fixed tick above). Guarded so a
        // scene with no scripts pays nothing. Non-destructive — Stop reverts transforms (snapshot) + any ctx.destroy hides.
        this._playStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        this._scriptHidden.clear();
        if (this._scriptManager.size > 0) {
            this._scriptRunner = new ScriptRunner(this._scriptCompiler, this._scriptManager, this._buildScriptAdapter(), {
                onError: (nodeId, hook, err) => console.warn(`[script:${nodeId}] ${hook} error:`, err),
            });
            this._scriptRunner.start();
        }
        this._playing = true;
        // Fog horizon (2026-10-01): the renderer fog-culls / fades skinned characters; never the player (the camera
        // would lose it), whatever the fog's Far.
        const fr3 = this.ctx.webgpuRenderer?.getRenderer3D?.();
        if (fr3) fr3.fogCullExempt = (m) => this._playing && this._isPlayerPart(m);
        this.onPlayStateChanged.emit();
    }

    /** Exit Play mode: stop the loop, restore the pre-play camera + scene transforms + re-apply the edit view. */
    exitPlayMode3D(): void {
        if (!this._playing) return;
        this._endPlayOutlines();   // the runtime Play character outlines off (item 10)
        this._playLoop?.stop();
        this._playLoop = null;
        // Script Behaviors: drop instances; restore anything ctx.destroy() hid this run (Play is non-destructive).
        this._scriptRunner?.stop();
        this._scriptRunner = null;
        for (const [id, wasVisible] of this._scriptHidden) { const m = this.getMesh(id); if (m) m.visible = wasVisible; }   // not "true": an editor-hidden mesh stays hidden
        this._scriptHidden.clear();
        this._playController = null;
        this._keyboard?.detach();
        if (this._keyboard) this._lockPlayKeys(false);
        this._keyboard = null;
        this._mouseLook?.detach();
        this._mouseLook = null;
        this._gamepad = null; this._padReading = null; this._padRunToggles = 0; this._padSneakToggles = 0;
        if (this._playSneaking) { this._playSneaking = false; this.onPlayerSneakChanged.emit(false); }
        this._playSneakToggle = false;
        this._playing = false;
        this._clearCameraFades();   // camera occluder fades: every faded prop whole again
        const fr3 = this.ctx.webgpuRenderer?.getRenderer3D?.();
        if (fr3) fr3.fogCullExempt = null;   // fog horizon: the player exemption ends with Play
        this.renderer3D.setPinnedPointLights([]);   // visual-polish #7c: the player light ends with Play
        this._playDust.detach(this.renderer3D);     // landing dust: drop the particles + the renderer registration
        this._locoIdleVariants = []; this._locoIdleNames = []; this._idleFace = null;
        this._releaseAutoPlayer();                            // auto default player out of the scene (kept cached)
        this._playOptsConfig = undefined;
        this._restoreLocoRest();                                // the engine-driven rig back to its pre-play pose
        if (this._locoDefaultGait) { this.setPlayerAnimation3D(null, null); this._locoRuntimeClips = []; }   // runtime-only binding
        if (this._playerMesh) { this._playerMesh.visible = this._playerPrevVisible; this._playerMesh = null; }
        this._collisionGrid = null; this._collisionMeshes = null; this._collSnap = null; this._collisionHood = null; this._collisionSet = null; this._collCells?.clear(); this._collCells = null; this._tpCam.reset(); this._playerPartIds.clear();
        if (this._prePlayXforms) { this._restoreTransforms(this._prePlayXforms); this._prePlayXforms = null; }
        this._candMeshes.length = 0;   // the picker scratch held refs to (possibly disposed) meshes after Stop
        const cam = this.renderer3D.getCamera();
        // Stop lands on the vantage you were LOOKING FROM in Play (the follow camera), not the pre-Play editor pose (that
        // jumped back to a builder view high above the city). Only for a perspective free-nav edit view: an ortho /
        // locked 2D view keeps its exact pre-Play restore. Captured before anything below moves the camera.
        const keepPlayView = this._prePlayCam?.mode === 'perspective' && deriveViewRules(this._viewState).freeNavigation;
        const playPos: [number, number, number] = [cam.position[0], cam.position[1], cam.position[2]];
        const playTgt: [number, number, number] = [cam.target[0], cam.target[1], cam.target[2]];
        if (this._prePlayFov !== null) { cam.fov = this._prePlayFov; this._prePlayFov = null; }
        if (this._prePlayCam) {
            const p = this._prePlayCam;
            cam.mode = p.mode;
            cam.lookAt(p.pos[0], p.pos[1], p.pos[2], p.target[0], p.target[1], p.target[2]);
            this._prePlayCam = null;
        }
        this._setEditorSuspended(false);
        this._applyViewState();                                 // land back in the edit view (free3D orbit etc.)
        if (keepPlayView && playPos.every(Number.isFinite) && playTgt.every(Number.isFinite)) {
            cam.lookAt(playPos[0], playPos[1], playPos[2], playTgt[0], playTgt[1], playTgt[2]);
            this._armature.getOrbitController()?.syncFromCamera();   // orbit now pivots on what Play looked at (the player)
            this._captureCurrentPose();                              // …and the remembered free-cam vantage is this one
        }
        if (this._viewChangedInPlay) { this._viewChangedInPlay = false; void this._refreshArtboardTexture(); }   // a mode/target switch deferred during Play
        this.onPlayStateChanged.emit();
        this.ctx.scheduleRender();
    }

    /** Suspend (Play enter) / resume (Stop) the editor's input + overlays: the InteractionService playActive flag gates
     *  every 2D key / pointer path and the editor overlay draws; the armature's hover pick, joint picking and the
     *  transform controller read isPlaying. The hover outline is cleared (no per-frame silhouette pass). */
    private _setEditorSuspended(on: boolean): void {
        const is = this.ctx.interactionService as { playActive?: boolean } | undefined;
        if (is) is.playActive = on;
        if (on) { try { this.setHoveredMesh(null); } catch { /* no armature yet */ } }
        this.ctx.scheduleRender();
    }

    // ── Script Behaviors (docs/specs/script-behaviors.md) ─────────────────────────────────────────────
    /** Route script getVar/setVar/emit to the UI state machine (wired by ShapeManager). Scripts + the UI machine
     *  share variables, so a script computes and a machine transition reacts (or vice-versa). */
    setScriptVarBridge(bridge: { get(name: string): number | string | boolean | null; set(name: string, v: number | string | boolean): void; emit(event: string): void } | null): void {
        this._scriptVarBridge = bridge;
    }
    /** Attach/replace a node's behavior source. Compiled at the next Play start (v1 recompiles on enter). */
    setScriptBehavior3D(nodeId: string, source: string, opts?: { enabled?: boolean; name?: string }): void { this._scriptManager.set(nodeId, source, opts); }
    getScriptBehavior3D(nodeId: string): ScriptBehavior | null { return this._scriptManager.get(nodeId); }
    removeScriptBehavior3D(nodeId: string): boolean { return this._scriptManager.remove(nodeId); }
    setScriptEnabled3D(nodeId: string, enabled: boolean): boolean { return this._scriptManager.setEnabled(nodeId, enabled); }
    listScriptBehaviors3D(): ScriptBehavior[] { return this._scriptManager.list(); }
    /** Transpile-check a source without attaching it — for the editor's inline error list. */
    validateScript3D(source: string): { ok: boolean; error?: { message: string; line?: number } } {
        const r = this._scriptCompiler.compile(source);
        return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    /** The ambient `.d.ts` for the code editor's IntelliSense (load as a Monaco extraLib). */
    getScriptContextTypes3D(): string { return SCRIPT_CONTEXT_DTS; }
    /** Starter behavior templates for the editor's snippet picker. */
    getScriptSnippets3D(): ScriptSnippet[] { return SCRIPT_SNIPPETS; }

    private _scriptInputSnapshot(): ScriptInput {
        const b = this._lastPlayBase;
        return { forward: b.forward, right: b.right, jump: b.jump, lookYaw: b.lookYaw ?? 0, lookPitch: b.lookPitch ?? 0, interact: b.interact ?? false };
    }

    /** The engine seam the ScriptContext runs against. Transforms go through setPosition3D/setRotation3D (they rebuild
     *  the matrix); vars/emit route to the UI machine via the injected bridge; play/stop + spawn are v1-deferred;
     *  destroy hides the node and is restored on Stop (non-destructive Play). */
    private _buildScriptAdapter(): ScriptSceneAdapter {
        return {
            playerId: () => this._playerMesh?.id ?? this.autoPlayer.meshId,   // the auto default player counts as the player
            getPos: (id) => { const m = this.getMesh(id); return m ? [m.x, m.y, m.z] : null; },
            setPos: (id, x, y, z) => { this.getMesh(id)?.setPosition3D(x, y, z); this.ctx.scheduleRender(); },
            getYaw: (id) => this.getMesh(id)?.rotationY ?? 0,
            setYaw: (id, rad) => { const m = this.getMesh(id); if (m) { m.setRotation3D(m.rotationX, rad, m.rotation); this.ctx.scheduleRender(); } },
            play: () => { /* v1: script-driven animation deferred — drive clips via the UI machine's playAnimation action */ },
            stop: () => { /* v1: see play */ },
            exists: (id) => this.getMesh(id) !== null,
            raycast: (origin, dir, maxDist) => {
                const hit = this._picker.raycastWorld(origin as unknown as vec3, dir as unknown as vec3, this.getAllMeshes(), false);
                if (!hit || (maxDist !== undefined && hit.distance > maxDist)) return null;
                return { id: hit.mesh.id, point: hit.hitPoint };
            },
            spawn: () => null,   // v1: real prefab spawn is a later phase
            destroy: (id) => { const m = this.getMesh(id); if (m) { if (!this._scriptHidden.has(id)) this._scriptHidden.set(id, m.visible); m.visible = false; this.ctx.scheduleRender(); } },
            getVar: (name) => this._scriptVarBridge?.get(name) ?? null,
            setVar: (name, v) => { this._scriptVarBridge?.set(name, v); },
            input: () => this._scriptInputSnapshot(),
            emit: (event) => { this._scriptVarBridge?.emit(event); },
            now: () => ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this._playStartMs) / 1000,
        };
    }

    /** Assign (or clear with null) the mesh that Play drives as the "Player" avatar: the controller moves it and,
     *  in third-person, the camera follows it (follow distance/height = the CharacterConfig thirdPersonDistance/
     *  thirdPersonHeight). Persists across enter/exit so the host can set it once. Takes effect on the next
     *  enterPlayMode3D; if called mid-play it re-binds immediately. */
    setPlayerObject3D(meshId: string | null): void {
        this._playerMeshId = meshId;
        if (!this._playing) return;
        // Re-bind live: restore the old avatar's visibility, adopt the new one. (The auto default player is simply
        // released — a user-set Player always replaces it.)
        if (this._isAutoPlayerMesh(this._playerMesh)) this._releaseAutoPlayer();
        if (this._playerMesh) { this._playerMesh.visible = this._playerPrevVisible; this._playerMesh = null; }
        // Release the old rig from the engine locomotion (back to its pre-play pose; a runtime default gait is dropped).
        this._restoreLocoRest();
        if (this._locoDefaultGait) { this.setPlayerAnimation3D(null, null); this._locoRuntimeClips = []; }
        this._locoEngineSkelId = null;
        const m = meshId ? (this.getAllMeshes().find(x => x.id === meshId) ?? null) : null;
        this._playerMesh = m;
        if (m && this._playController) {
            this._playerPrevVisible = m.visible;
            m.visible = this._playController.cfg.cameraMode === 'third';
            // Re-measure + re-frame for the new avatar, and snap the controller feet to its base so the camera and
            // the driven mesh stay consistent (a mid-play swap otherwise keeps the previous avatar's framing).
            this._measureBoundAvatar(m);
            // The broadphase was built without the OLD Player; rebuild it so the new one (all its parts) is excluded.
            if (this._collisionOn()) this._buildCollisionGrid();
            this._applyAvatarCameraFraming(this._playController, this._explicitPlayConfig());
            this._playController.teleport([m.x, m.y - this._playerFootToOrigin, m.z]);
            this._playController.setHeading(m.rotationY, this._playController.pitch);
            this._drivePlayerMesh(this._playController);
            this._tpCam.reset();
            // Re-resolve the avatar's animation against the new rig.
            this._resolvePlayerOverlay();
            this._applyLocomotionSet();
            const skelId = this._playerSkeletonId();
            if (skelId && !this._locoEngineSkelId && !this._playerAnimHandler) this._bindDefaultGait(skelId);
        } else {
            this._playerHeight = 0; this._playerFootToOrigin = 0; this._playerPartIds.clear();
            if (this._collisionOn()) this._buildCollisionGrid();   // the old Player is now an ordinary obstacle
            // Cleared mid-play in third-person → the auto default player takes over (if enabled).
            const cc = this._playController;
            if (cc && PlayAutoPlayer.shouldSpawn({ enabled: this.playSettings.autoDefaultPlayer, cameraMode: cc.cfg.cameraMode, hasPlayer: false })) void this._spawnAutoPlayer(cc);
        }
    }
    get playerObjectId3D(): string | null { return this._playerMeshId; }
    /** The Play character's FEET position (world space) while Play runs, else null. A streamed tiled city centres its
     *  active tile window on it (performance-plan P10.D). */
    getPlayerFeet3D(): [number, number, number] | null {
        const cc = this._playing ? this._playController : null;
        return cc ? [cc.pos[0], cc.pos[1], cc.pos[2]] : null;
    }

    /** Place the bound Player mesh at the controller's feet, facing its yaw (TRS — localMatrix is derived). Keeps the
     *  avatar's authored scale + pitch/roll; only position and yaw are driven. cc.pos is the FEET; _playerFootToOrigin
     *  lifts the mesh origin back to its authored height above the feet (0 for a feet-origin avatar), so a
     *  center-origin avatar isn't half-buried. */
    private _drivePlayerMesh(cc: CharacterController, feet: [number, number, number] = cc.pos, facing: number = cc.facing): void {
        const m = this._playerMesh; if (!m) return;
        // The BODY facing (turns toward the move direction in third-person), never the camera yaw.
        m.setRotation3D(m.rotationX, facing, m.rotation);
        m.setPosition3D(feet[0], feet[1] + this._playerFootToOrigin, feet[2]);   // last → single localMatrix rebuild with the new yaw
    }

    /** Measure the bound player mesh's world bounding box so Play can frame THIS avatar. Sets _playerHeight (world
     *  vertical extent) and _playerFootToOrigin (mesh origin Y − geometry bottom Y). Leaves both 0 when no world
     *  corners are available yet (→ the caller keeps the hardcoded defaults). Bind-pose bounds, which is what we
     *  want at Play-enter (authored standing height); they don't track live skeletal deformation. */
    private _measureBoundAvatar(m: Mesh3D): void {
        this._playerHeight = 0; this._playerFootToOrigin = 0;
        this._collectPlayerParts(m);
        // Fresh bounds: a body regenerated in place (the height / proportion sliders swap its geometry) kept the OLD
        // box until its next transform change, so the first Play after a height edit framed and lifted the old size.
        m.calculateBoundingBox();
        const c = m.obbCorners;
        if (!c || c.length === 0) return;
        let minY = Infinity, maxY = -Infinity;
        for (const p of c) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
        if (!isFinite(minY) || !isFinite(maxY) || maxY <= minY) return;
        this._playerHeight = maxY - minY;
        this._playerFootToOrigin = m.y - minY;
    }

    /** Scale the Play camera offsets to the measured avatar height so the framing fits ANY avatar, not just a
     *  ~1.7-unit human. eyeHeight ≈ near the top (first-person eyes); the third-person target (orbitPivot = feet +
     *  eyeHeight + thirdPersonHeight) is aimed at ~0.6·H (upper torso) so the whole body stays framed and a small
     *  pitch can't throw it off screen; distance ≈ 2.2·H (taller avatar → more pullback). Any field the host set
     *  explicitly (via enterPlayMode3D config) is respected. No-op when nothing was measured (H ≤ 0). */
    private _applyAvatarCameraFraming(cc: CharacterController, explicit?: Partial<CharacterConfig>): void {
        const H = this._playerHeight;
        if (H <= 0) return;
        const eye = explicit?.eyeHeight ?? H * 0.9;
        cc.cfg.eyeHeight = eye;
        // R6.2: a SHOULDER-height pivot (0.8·H) and a further follow distance (2.6·H ≈ 4.4 m for a 1.7 m body), which
        // with the wider 72° FOV frames the whole character with room around it, like a released third-person game.
        // The collision min distance / ray radius / padding scale with H too (avatarCameraFraming): metre values in a
        // city put a giant user Player's pulled-in camera 3 cm behind its shoulder pivot, i.e. inside its head. The
        // camera never comes closer than the min distance (ThirdPersonCamera), so even a short metre camera-distance
        // setting keeps it outside the body.
        const f = avatarCameraFraming(H, eye, DEFAULT_CHARACTER);
        if (explicit?.thirdPersonHeight === undefined) cc.cfg.thirdPersonHeight = f.thirdPersonHeight;
        if (explicit?.thirdPersonDistance === undefined) cc.cfg.thirdPersonDistance = f.thirdPersonDistance;
        if (explicit?.cameraMinDistance === undefined) cc.cfg.cameraMinDistance = f.cameraMinDistance;
        if (explicit?.cameraCollisionRadius === undefined) cc.cfg.cameraCollisionRadius = f.cameraCollisionRadius;
        if (explicit?.cameraCollisionPadding === undefined) cc.cfg.cameraCollisionPadding = f.cameraCollisionPadding;
        if (explicit?.cameraShoulderOffset === undefined) cc.cfg.cameraShoulderOffset = f.cameraShoulderOffset;   // visual-polish #7a
        // Character scale (2026-10-04): the collision CAPSULE follows the avatar's size too (radius + step height × H /
        // 1.7 m). It stayed at the metre defaults, so a 2× giant walked half into walls and a doll stopped 35 cm short.
        // A 1.7 m avatar (a fitted city character) gets exactly the defaults. Speeds stay in metres per second (the
        // gait's cadence follows the size instead: LocomotionAnimator scaleRateClamp).
        if (Scene3DManager.avatarScaledCapsule) {
            const cap = avatarCollisionScale(H, DEFAULT_CHARACTER);
            if (explicit?.radius === undefined) cc.cfg.radius = cap.radius;
            if (explicit?.stepHeight === undefined) cc.cfg.stepHeight = cap.stepHeight;
        }
    }
    /** A/B (character scale 2026-10-04): false = the Play capsule keeps the metre defaults whatever the avatar's size. */
    static avatarScaledCapsule = true;
    /** A/B (character scale 2026-10-04): false = a body-param edit (height / legs) grows the body about its hips (the
     *  feet sink / float) instead of keeping the soles where they were. */
    static bodyEditKeepsFeet = true;
    /** A/B (character scale 2026-10-04): false = a new city character's ORIGIN (its hips) sits on the spawn floor point
     *  (its feet buried below the street) instead of its soles. Same for the live ghost preview. */
    static citySpawnFeetOnFloor = true;

    /** Third-person camera (R6.2): the ThirdPersonCamera rig — crisp orbit, lagged shoulder pivot with look-ahead, and a
     *  sphere-cast pull-in that eases back out. `feet` is the render-interpolated feet position; `dt` the render dt.
     *  Returns [eye, lookTarget]. */
    private _thirdPersonCamera(cc: CharacterController, feet: [number, number, number], dt: number): [[number, number, number], [number, number, number]] {
        const pivot = cc.orbitPivot(feet);
        const reach = cc.cfg.thirdPersonDistance + cc.cfg.cameraCollisionRadius + cc.cfg.cameraCollisionPadding;
        // P9: the grid query + copy is the FALLBACK list for rays the collision hood cannot answer — built on first
        // use only (most frames every camera ray is inside the hood). Scene3DManager.lazyCameraCandidates = false:
        // built every frame as before (A/B).
        let cand: Mesh3D[] | null = null;
        const candidates = (): Mesh3D[] => cand ??= this._regionCandidates(pivot[0] - reach, pivot[2] - reach, pivot[0] + reach, pivot[2] + reach).slice();
        // Camera occluders (camera-occluders.ts): the camera rays see only HARD occluders (walls, buildings, ground,
        // big solids); poles / trees / signs / props / characters are passed through. A/B: cameraSoftOccluders = false.
        this._camOccScale = cameraOccluderScale(this._playerHeight > 0 ? this._playerHeight : cc.cfg.eyeHeight / 0.9);
        const caster = cc.cfg.cameraCollision
            ? this._rayCaster(Scene3DManager.lazyCameraCandidates ? candidates : candidates(), /*bvhBudget*/ true,
                Scene3DManager.cameraSoftOccluders ? this._cameraBlocksFn : undefined)
            : null;
        const r = this._tpCam.update(dt, { pivot, velX: cc.vel[0], velZ: cc.vel[2], yaw: cc.yaw, pitch: cc.pitch, airborne: !cc.grounded }, cc.cfg, caster);
        return [r.eye, r.target];
    }

    /** A/B (camera occluders 2026-10-04): false = the Play camera pulls in for every collision mesh (poles, trees,
     *  signs, props too), the old behaviour. */
    static cameraSoftOccluders = true;
    /** Size thresholds of the occluder size rule for the current avatar (world units). */
    private _camOccScale = cameraOccluderScale(1.7);
    /** Per-mesh cached occluder verdicts, recomputed only when an input changes (matrix / geometry / fog class /
     *  override / parent / scale). Classification never flips per frame, so the camera never pops on a re-read. */
    private _camOccCache = new WeakMap<Mesh3D, { ver: number; geom: unknown; fc: number; cb: string; parent: unknown; thin: number; v: CameraOccluderVerdict }>();
    private readonly _cameraBlocksFn = (m: Mesh3D): boolean => this._cameraOccluderVerdict(m).hard;
    /** The camera occluder verdict of a mesh (cached; see camera-occluders.ts for the rules). */
    private _cameraOccluderVerdict(m: Mesh3D): CameraOccluderVerdict {
        const s = this._camOccScale;
        const e = this._camOccCache.get(m);
        if (e && e.ver === m.localMatrixVersion && e.geom === m.geometry && e.fc === m.fogClass && e.cb === m.cameraBlock && e.parent === m.parent && e.thin === s.thin) return e.v;
        const names: string[] = [];
        let character = m instanceof SkinnedMesh3D;
        for (let n: { name?: string; parent?: unknown } | null = m, depth = 0; n && depth < 8; n = (n.parent as typeof n) ?? null, depth++) {
            names.push(n.name ?? '');
            if (n !== m && n instanceof SkinnedMesh3D) character = true;
        }
        let extents: [number, number, number] | null = null;
        if (!m.cheapBounds && !character) {
            const c = m.obbCorners;
            if (c && c.length) {
                let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
                for (const p of c) {
                    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
                    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
                    if (p[2] < z0) z0 = p[2]; if (p[2] > z1) z1 = p[2];
                }
                extents = [x1 - x0, y1 - y0, z1 - z0];
            }
        }
        const v = classifyCameraOccluder({ cameraBlock: m.cameraBlock, names, fogClass: m.fogClass, character, mover: m.cheapBounds, extents }, s, e?.v.hard);
        this._camOccCache.set(m, { ver: m.localMatrixVersion, geom: m.geometry, fc: m.fogClass, cb: m.cameraBlock, parent: m.parent, thin: s.thin, v });
        return v;
    }
    /** Diagnostics: how the Play camera treats a mesh — hard (pulls the camera in) or soft (passed through), and why. */
    getCameraOccluderClass3D(meshId: string): CameraOccluderVerdict | null {
        const m = this.getMesh(meshId);
        return m ? this._cameraOccluderVerdict(m) : null;
    }
    /** Author override of how the Play third-person camera treats a mesh: 'auto' (the rules), 'block' (a wall: the camera
     *  pulls in in front of it) or 'ignore' (the camera passes through it). Persisted on the mesh. */
    setMeshCameraBlock3D(meshId: string, mode: CameraBlockMode): boolean {
        const m = this.getMesh(meshId);
        if (!m || !isCameraBlockMode(mode)) return false;
        if (m.cameraBlock !== mode) { m.cameraBlock = mode; m.stateDirty = true; this.ctx.emitSceneGraphChanged(); }
        return true;
    }
    getMeshCameraBlock3D(meshId: string): CameraBlockMode | null { return this.getMesh(meshId)?.cameraBlock ?? null; }

    /** A/B (camera occluders): false = soft occluders between the camera and the player stay solid. */
    static cameraOccluderFade = true;
    /** Screen-door coverage a faded occluder eases to (0 = gone, 1 = whole), and the ease rate (1/s). */
    static CAMERA_FADE_COVERAGE = 0.3;
    static CAMERA_FADE_RATE = 12;
    /** Only soft meshes no bigger than this × the follow distance fade: a merged city layer (one mesh for every sign /
     *  pole of a district) stays whole rather than dissolving the whole street. */
    static CAMERA_FADE_MAX_EXTENT = 5;
    /** Meshes this camera has faded → their current coverage. */
    private readonly _camFaded = new Map<Mesh3D, number>();
    /** Per third-person frame: the SOFT occluders on the lines from the eye to the player's chest and head fade to
     *  CAMERA_FADE_COVERAGE (the P17 HLOD dither lane, Mesh3D.hlodFade); ones no longer in the way ease back whole. */
    private _cameraOccluderFadeTick(cc: CharacterController, eye: [number, number, number], dt: number): void {
        const S = Scene3DManager, hit = new Set<Mesh3D>();
        if (S.cameraOccluderFade && S.cameraSoftOccluders && cc.cfg.cameraCollision && this._collisionOn()) {
            const p = this._lastPlayerFeet ?? cc.pos, H = this._playerHeight > 0 ? this._playerHeight : cc.cfg.eyeHeight / 0.9;
            const maxE = S.CAMERA_FADE_MAX_EXTENT * cc.cfg.thirdPersonDistance;
            const ok = (m: Mesh3D): boolean => {
                if (m instanceof SkinnedMesh3D || m.arraySourceOnly || this._isPlayerPart(m) || this._cameraOccluderVerdict(m).hard) return false;
                if (m.hlodFade >= 0 && !this._camFaded.has(m)) return false;   // an HLOD tier dissolving: not ours
                const c = m.obbCorners;
                if (!c || !c.length) return false;
                let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
                for (const q of c) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; if (q[2] < z0) z0 = q[2]; if (q[2] > z1) z1 = q[2]; }
                return Math.max(x1 - x0, y1 - y0, z1 - z0) <= maxE;
            };
            const lo = Math.min(eye[0], p[0]), hi = Math.max(eye[0], p[0]), lz = Math.min(eye[2], p[2]), hz = Math.max(eye[2], p[2]);
            let list: Mesh3D[] | null = null;
            for (const ty of [p[1] + 0.6 * H, p[1] + 0.9 * H]) {   // the chest and the head
                const d: [number, number, number] = [p[0] - eye[0], ty - eye[1], p[2] - eye[2]], L = Math.hypot(d[0], d[1], d[2]);
                if (!(L > 1e-6)) continue;
                list ??= this._regionCandidates(lo, lz, hi, hz).filter(ok);
                if (!list.length) break;
                let rest = list;
                for (let k = 0; k < 3 && rest.length; k++) {   // up to three soft layers on one line (a pole, a sign, a tree)
                    const h = this._picker.raycastWorld(eye as unknown as vec3, [d[0] / L, d[1] / L, d[2] / L] as unknown as vec3, rest, true, L * 0.97, true);
                    if (!h || !(h.distance < L * 0.97)) break;
                    hit.add(h.mesh);
                    rest = rest.filter((m) => m !== h.mesh);
                }
            }
        }
        for (const m of hit) if (!this._camFaded.has(m)) this._camFaded.set(m, 1);
        const a = 1 - Math.exp(-S.CAMERA_FADE_RATE * Math.max(0, Math.min(dt, 0.1)));
        for (const [m, c] of this._camFaded) {
            const goal = hit.has(m) ? S.CAMERA_FADE_COVERAGE : 1;
            let nc = c + (goal - c) * a;
            if (Math.abs(nc - goal) < 0.01) nc = goal;
            if (nc >= 1) { this._camFaded.delete(m); m.hlodFade = -1; m.materialDirty = true; continue; }
            this._camFaded.set(m, nc);
            const q = Math.round(nc * 32) / 32;   // quantised: a slot rewrite only when the dither level changes
            if (m.hlodFade !== q) { m.hlodFade = q; m.materialDirty = true; }
        }
    }
    /** Every camera-faded mesh whole again (Play exit, first person). */
    private _clearCameraFades(): void {
        for (const m of this._camFaded.keys()) { m.hlodFade = -1; m.materialDirty = true; }
        this._camFaded.clear();
    }

    /** A collision RayCaster over a fixed mesh set (the BVH picker; includes non-pickable city decoration). `blocks`
     *  (the camera rays): only meshes it accepts can be hit. */
    private _rayCaster(meshes: Mesh3D[] | (() => Mesh3D[]), bvhBudget = Scene3DManager.collisionBvhBudget, blocks?: (m: Mesh3D) => boolean): RayCaster {
        const scratch: Mesh3D[] = [];
        return (origin, dir, maxDist) => {
            // P6: a bounded ray inside the collision hood tests only the meshes near the character (same nearest hit);
            // maxDist also lets the picker skip meshes whose box starts beyond reach. P9: `meshes` may be lazy.
            let list = (Scene3DManager.collisionHood && this._collisionHood?.candidatesFor(origin, dir, maxDist)) || (typeof meshes === 'function' ? meshes() : meshes);
            if (blocks) { scratch.length = 0; for (const m of list as Mesh3D[]) if (blocks(m)) scratch.push(m); list = scratch; }
            // Step 3: a ray inside a ready collision cell walks the cell's merged BVH (+ the old path over what the cell
            // does not cover). Same nearest hit, distance and normal (collision-cells.ts).
            const cells = Scene3DManager.STEP3.collisionCells ? this._collCells : null;
            if (cells) {
                const cell = cells.cellForRay(origin, dir, maxDist);
                if (cell) {
                    const r = this._cellRaycast(cell, origin, dir, maxDist, list as Mesh3D[], bvhBudget, blocks);
                    if (r !== undefined) return r;
                }
            }
            // bvhBudget (P10.D): the camera bundle builds at most MeshPicker.bvhBuildBudgetMs of new BVHs per frame.
            this._cellRayStats.old++;
            const hit = this._picker.raycastWorld(origin as unknown as vec3, dir as unknown as vec3, list as Mesh3D[], true, maxDist, bvhBudget);
            if (!hit || hit.distance > maxDist) return null;
            return { distance: hit.distance, normal: hit.faceNormal };
        };
    }

    // ── Step 3 collision cells (src/game/collision-cells.ts; Scene3DManager.STEP3.collisionCells) ──────────────────────
    private _collCells: CollisionCellManager<Mesh3D> | null = null;
    private _collCellsReach = 0;
    /** The collision snapshot as a set (a cell member answers only while it is in the current snapshot). */
    private _collisionSet: Set<Mesh3D> | null = null;
    private readonly _cellScratch = newCellRayScratch();
    /** Cell core size and margin, as multiples of the longest Play ray (the third-person camera reach). */
    static COLLISION_CELL_CORE = 4;
    static COLLISION_CELL_MARGIN = 1.5;
    /** Main-thread gather budget per Play tick (ms). */
    static COLLISION_CELL_GATHER_MS = 1.5;
    /** Diagnostics: rays answered through a cell / by the old path, residual meshes tested, cell rays that fell back. */
    private readonly _cellRayStats = { cell: 0, old: 0, residual: 0, fallback: 0 };

    /** Per Play tick: (re)size the cells to the camera reach, then let the manager validate / request / gather. */
    private _collisionCellsTick(cc: CharacterController): void {
        if (!Scene3DManager.STEP3.collisionCells || !this._collisionOn()) { if (this._collCells) { this._collCells.clear(); this._collCells = null; } return; }
        this._refreshCollisionGrid();
        const reach = Math.max(1e-4, cc.cfg.thirdPersonDistance + cc.cfg.cameraCollisionRadius + cc.cfg.cameraCollisionPadding, cc.cfg.radius + cc.cfg.stepHeight);
        if (!this._collCells || Math.abs(reach - this._collCellsReach) > 0.1 * this._collCellsReach) {
            this._collCells?.clear();
            this._collCellsReach = reach;
            this._collCells = new CollisionCellManager<Mesh3D>({
                region: (x0, z0, x1, z1) => this._regionCandidates(x0, z0, x1, z1),
                staticGeometry: (m) => this._cellStaticGeometry(m),
                same: (m, key, ver) => m.geometry === key && m.localMatrixVersion === ver && !m.gpuDirty && m.geometry.vertices.length > 0,
                xzBox: (m) => { const b = this._meshXZBounds(m); return [b.minX, b.minZ, b.maxX, b.maxZ]; },
                build: (soup) => buildCellBvhAsync(soup),
                now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
            }, { core: reach * Scene3DManager.COLLISION_CELL_CORE, margin: reach * Scene3DManager.COLLISION_CELL_MARGIN, gatherMs: Scene3DManager.COLLISION_CELL_GATHER_MS });
        }
        this._collCells.update(cc.pos[0], cc.pos[2]);
    }

    /** A mesh is STATIC cell geometry when the per-mesh path would take its BVH branch with an identity matrix:
     *  uploaded (not gpuDirty), not skinned, not a per-frame mover, indexed, and exactly the identity model matrix. */
    private _cellStaticGeometry(m: Mesh3D): { vertices: Float32Array; indices: Uint32Array; key: object; ver: number; runBoxes?: unknown } | null {
        if (m.gpuDirty || m.cheapBounds || m instanceof SkinnedMesh3D || m.arraySourceOnly) return null;
        const g = m.geometry;
        if (!g || !g.vertices || g.vertices.length === 0 || !g.indices || g.indices.length < 3) return null;
        const mm = m.localMatrix as unknown as Float32Array;
        if (mm[0] !== 1 || mm[5] !== 1 || mm[10] !== 1 || mm[15] !== 1 || mm[1] !== 0 || mm[2] !== 0 || mm[3] !== 0 || mm[4] !== 0
            || mm[6] !== 0 || mm[7] !== 0 || mm[8] !== 0 || mm[9] !== 0 || mm[11] !== 0 || mm[12] !== 0 || mm[13] !== 0 || mm[14] !== 0) return null;
        return { vertices: g.vertices, indices: g.indices, key: g, ver: m.localMatrixVersion, runBoxes: (g as { runBoxes?: unknown }).runBoxes };
    }

    /** One ray through a ready cell (collision-cells.ts cellRaycast): the cell BVH for the meshes it covers + the
     *  per-mesh path for the rest of `list`, combined by the old rules. undefined = the caller takes the old path. */
    private _cellRaycast(cell: CollisionCell<Mesh3D>, origin: [number, number, number], dir: [number, number, number], maxDist: number,
        list: Mesh3D[], bvhBudget: boolean, blocks?: (m: Mesh3D) => boolean): { distance: number; normal: [number, number, number] } | null | undefined {
        const pk = this._picker, set = this._collisionSet;
        return cellRaycast(cell.cur!, origin, dir, maxDist, list, pk as unknown as CellRayPicker<Mesh3D>, bvhBudget,
            (m) => m.visible && !pk.isDetached(m) && (!set || set.has(m)) && (!blocks || blocks(m)),
            (m) => this._cellStaticGeometry(m) !== null,
            () => this._collCells?.markStale(cell),
            this._cellScratch, this._cellRayStats);
    }

    /** Play collision diagnostics: the cells (counts, builds, bytes, rays served / not), the rays answered through cells
     *  vs the per-mesh path, the hood, the per-mesh BVHs built. Null outside Play. */
    getCollisionStats3D(): { cells: unknown; rays: { cell: number; old: number; residual: number; fallback: number }; hood: unknown; meshBvhs: number; snapshot: number; snapshotSync?: unknown } | null {
        if (!this._playing) return null;
        return {
            cells: this._collCells ? { ...this._collCells.stats, core: this._collCells.opts.core, margin: this._collCells.opts.margin } : null,
            rays: { ...this._cellRayStats }, hood: this._collisionHood ? { ...this._collisionHood.stats } : null,
            meshBvhs: this._picker.bvhCount(), snapshot: this._collSnap?.size ?? this._collisionMeshes?.length ?? 0,
            ...(this._collSnap ? { snapshotSync: { ...this._collSnap.stats, cellSize: this._collSnap.cellSize, hoodKept: this._hoodKept } } : {}),
        };
    }

    /** Right-stick orbit speed at full tilt (rad/s): yaw / pitch. */
    private static readonly PAD_YAW_RATE = 3.2;
    private static readonly PAD_PITCH_RATE = 2.0;

    /** Set walk/run on the controller (and remember it for the next Play), firing onPlayerRunChanged on a change. */
    private _setRunning(cc: CharacterController | null, running: boolean): void {
        const changed = running !== this._playRunning || (cc !== null && cc.running !== running);
        this._playRunning = running;
        if (cc) cc.running = running;
        if (changed) this.onPlayerRunChanged.emit(running);
    }
    /** Walk / run state (true = running). Shift (keyboard) or L3 / Y (gamepad) toggles it while playing. */
    getPlayerRunning3D(): boolean { return this._playController ? this._playController.running : this._playRunning; }
    /** Force walk (false) or run (true); applies live while playing and to the next Play. */
    setPlayerRunning3D(running: boolean): void { this._setRunning(this._playController, !!running); }

    /** Set the effective sneak on the controller, firing onPlayerSneakChanged on a change. */
    private _setSneaking(cc: CharacterController | null, on: boolean): void {
        if (cc) cc.sneaking = on;
        if (on !== this._playSneaking) { this._playSneaking = on; this.onPlayerSneakChanged.emit(on); }
    }
    /** Sneak state while playing (Ctrl held, or C / pad B toggled). False when not playing. */
    getPlayerSneaking3D(): boolean { return this._playing && this._playSneaking; }
    /** Toggle-style sneak from the host (an on-screen button): true = sneak until set false / C / B. Ctrl still adds a
     *  hold on top. No-op when not playing (sneak resets every run). */
    setPlayerSneaking3D(on: boolean): void {
        if (!this._playing) return;
        this._playSneakToggle = !!on;
        this._setSneaking(this._playController, this._playSneakToggle || (this._keyboard?.ctrlHeld() ?? false));
    }
    /** The active gait while playing ('walk' | 'run' | 'sneak'), else null. */
    getPlayerGait3D(): 'walk' | 'run' | 'sneak' | null { return this._playController ? this._playController.gait() : null; }

    /** Keyboard Lock (Chromium): while the page is FULLSCREEN, let Play receive Ctrl+W / Ctrl+S / … (browser shortcuts)
     *  instead of the browser closing the tab mid-sneak. No effect outside fullscreen; harmless where unsupported. */
    private _lockPlayKeys(on: boolean): void {
        const kb = (typeof navigator !== 'undefined' ? (navigator as Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void } }).keyboard : undefined);
        try {
            if (on) void kb?.lock?.(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyQ', 'KeyE', 'KeyF', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])?.catch?.(() => { /* not fullscreen / unsupported */ });
            else kb?.unlock?.();
        } catch { /* unsupported */ }
    }

    /** Apply the Play FOV: third-person = cfg.thirdPersonFovDeg; first-person = cfg.firstPersonFovDeg, or the camera's
     *  pre-play FOV when that is null. */
    private _applyPlayFov(cc: CharacterController): void {
        const cam = this.renderer3D.getCamera();
        const deg = cc.cfg.cameraMode === 'third' ? cc.cfg.thirdPersonFovDeg : cc.cfg.firstPersonFovDeg;
        if (deg !== null && Number.isFinite(deg) && deg > 0) cam.fov = deg * Math.PI / 180;
        else if (this._prePlayFov !== null) cam.fov = this._prePlayFov;
    }

    /** The live third-person camera numbers while playing (for a host HUD / debug), else null. */
    getPlayCameraState3D(): { mode: 'first' | 'third'; distance: number; targetDistance: number; fovDeg: number; yaw: number; pitch: number; facing: number } | null {
        const cc = this._playController;
        if (!cc) return null;
        const cam = this.renderer3D.getCamera();
        return {
            mode: cc.cfg.cameraMode, distance: this._tpCam.distance < 0 ? cc.cfg.thirdPersonDistance : this._tpCam.distance,
            targetDistance: cc.cfg.thirdPersonDistance, fovDeg: cam.fov * 180 / Math.PI, yaw: cc.yaw, pitch: cc.pitch, facing: cc.facing,
        };
    }

    /** The engine locomotion animator's live state (state / weights / walk-run mix), or null when the host owns playback. */
    getPlayerAnimationState3D(): { state: string; weights: Record<string, number>; runMix: number; crouchMix: number; strollMix: number; jogMix: number; landWeight: number; speed: number; gait: 'walk' | 'run' | 'sneak' | null; lean: { pitch: number; roll: number; headYaw: number }; jumpClip: string | null; jumpCount: number } | null {
        if (!this._locoEngineSkelId || !this._playing) return null;
        const a = this._locoAnim, l = this._locoLean.output;
        return {
            state: a.state, weights: { ...a.weights }, runMix: a.runMix, crouchMix: a.crouchMix, strollMix: a.strollMix, jogMix: a.jogMix, landWeight: a.landWeight,
            speed: a.smoothedSpeed, gait: this.getPlayerGait3D(), lean: { pitch: l.pitch, roll: l.roll, headYaw: l.headYaw },
            jumpClip: a.jumpClip, jumpCount: a.jumpCount,
        };
    }

    /** Build the collision broadphase: snapshot the static mesh set (minus the Player avatar — you don't collide
     *  with yourself) and index their world XZ footprints into a grid. Rebuilt each Play-enter; the scene is treated
     *  as static during Play (moving city traffic isn't re-indexed — a v1 limitation, see the spec). */
    private _buildCollisionGrid(): void {
        // Never the Player itself: body, hair, garments, face decal, charms (a user-set Player's parts too).
        // P10.D: a streamed tile's merged static crowd (0.1-0.7 M triangles per layer, spanning the whole tile) is not
        // collided with — every ground / camera ray near it built its BVH (seconds per tile entered). The centre city's
        // crowd keeps its collision (unchanged); the live near crowd is lifted out of these layers anyway.
        if (Scene3DManager.STEP3B.incrementalCollisionGrid) {
            // Step 3b: the same broadphase, kept by CollisionSnapshot (same query answers; see _refreshCollisionGrid).
            // (a survivor's footprint is re-read only when its matrix version, geometry or the global geometry epoch moved)
            this._collSnap = new CollisionSnapshot<Mesh3D>({ include: (m) => this._isCollisionMesh(m), bounds: (m, out) => this._meshXZBoundsInto(m, out),
                version: (m) => m.localMatrixVersion, source: (m) => m.geometry, geomVersion: (m) => m.geometryVersion,
                // P16 snapshotMeshVersion: the per-mesh geometry version above replaces the global epoch (every new
                // streamed mesh bumped it, so every sync on a tile change re-read all ~13 k footprints)
                epoch: () => STREAM_HITCH.snapshotMeshVersion ? 0 : Mesh3D.geometryEpoch });
            this._collSnap.rebuild(this.getAllMeshes());
            this._collisionMeshes = null; this._collisionGrid = null;
            this._collisionSet = this._collSnap.members;
        } else {
            this._collSnap = null;
            const meshes = this.getAllMeshes().filter(m => this._isCollisionMesh(m));
            const aabbs: XZBounds[] = meshes.map(m => this._meshXZBounds(m));
            this._collisionMeshes = meshes;
            this._collisionSet = new Set(meshes);
            this._collisionGrid = SpatialGridXZ.build(aabbs);
        }
        this._collisionVer = this.ctx.sceneStructureVersion();
        this._collisionAt = typeof performance !== 'undefined' ? performance.now() : 0;
        this._newCollisionHood();
    }
    /** A collision snapshot member: never the Player (body, hair, garments, face decal, charms), never an array
     *  source-only phantom, never a VISUAL-ONLY overlay (noCollide / radialFade: contact blobs, light pools, decals —
     *  the player's own moving blob made it rise forever, rise bug 2026-10-04; collision-filter.ts), and
     *  (collisionSkipTileCrowd) not a streamed tile's merged static crowd. */
    private _isCollisionMesh(m: Mesh3D): boolean {
        return !this._isPlayerPart(m) && !m.arraySourceOnly && !(Scene3DManager.visualOnlyNoCollide && isVisualOnlyMesh(m))
            && !(Scene3DManager.collisionSkipTileCrowd && (m.name ?? '').startsWith('world:ped-')
            && /^World Tile .* World Pedestrians$/.test((m.parent as { name?: string } | null)?.name ?? ''));
    }
    private _newCollisionHood(): void {
        this._collisionHood = new CollisionHood<Mesh3D>({
            region: (x0, z0, x1, z1) => this._regionCandidates(x0, z0, x1, z1),
            touches: (m, b) => this._picker.meshMayTouchWorldBox(m, b[0], b[1], b[2], b[3], b[4], b[5]),
            alwaysKeep: (m) => m.cheapBounds,   // city movers (traffic, walkers): the snapshot says nothing about them
        });
    }
    /** Step 3b: the incremental collision snapshot (null = off / the legacy grid / collision off). */
    private _collSnap: CollisionSnapshot<Mesh3D> | null = null;
    /** Syncs that kept the hood's candidate list (no change near it). */
    private _hoodKept = 0;
    /** Collision is on (a broadphase exists: the legacy grid or the snapshot). */
    private _collisionOn(): boolean { return !!(this._collisionGrid || this._collSnap); }
    private _collisionVer = -1;
    private _collisionAt = 0;
    /** performance-plan P10.D: a streamed tiled city adds / removes tiles DURING Play — the snapshot then had no ground
     *  under the new tiles (the player walked on the fallback plane) and kept the removed tiles' meshes alive. Rebuild
     *  it when the scene structure changed, at most every COLLISION_REFRESH_MS. */
    private _refreshCollisionGrid(): void {
        if (!Scene3DManager.collisionFollowsStructure) return;
        const v = this.ctx.sceneStructureVersion();
        if (v === this._collisionVer) return;
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        if (now - this._collisionAt < Scene3DManager.COLLISION_REFRESH_MS) return;
        const snap = this._collSnap;
        if (!snap || !Scene3DManager.STEP3B.incrementalCollisionGrid) { this._buildCollisionGrid(); return; }
        // Step 3b: only what attached / detached / moved since the last sync (same answers as a rebuild). The hood's
        // short list is rebuilt only when a change lands in the cells its box covers (else it is still exactly what
        // region() returns for that box).
        const d = snap.sync(this.getAllMeshes());
        this._collisionVer = v;
        this._collisionAt = now;
        const hb = this._collisionHood?.box;
        if (d.rebuilt) this._newCollisionHood();
        else if (hb && (d.added.length || d.removed.length || d.moved.length)) {
            if (snap.touches(d, hb[0], hb[2], hb[3], hb[5])) this._collisionHood!.reset(); else this._hoodKept++;
        }
    }
    /** P10.D A/B: false = the Play-enter collision snapshot only (the old behaviour). */
    static collisionFollowsStructure = true;
    /** P10.D A/B: false = streamed tiles' static crowd layers are collision geometry too. */
    static collisionSkipTileCrowd = true;
    /** A/B (rise bug 2026-10-04): false = visual-only meshes (noCollide / radialFade) are collision again (the old,
     *  broken behaviour: the player stands on its own moving contact blob and rises forever). */
    static visualOnlyNoCollide = true;
    /** P10.D A/B: every Play collision ray (ground / walls / camera) builds at most MeshPicker.bvhBuildBudgetMs of new
     *  mesh BVHs per frame (false = only the camera bundle is budgeted). */
    static collisionBvhBudget = true;
    static COLLISION_REFRESH_MS = 500;
    /** P6 A/B switch: false = every Play ray tests its full broadphase list (the pre-P6 path). */
    static collisionHood = true;
    /** P9 A/B switch: false = the third-person camera's fallback candidate list (grid query + copy) is built every
     *  frame instead of on first use. */
    static lazyCameraCandidates = true;

    /** _meshXZBounds into [minX, minZ, maxX, maxZ] (no allocation; the collision snapshot's per-sync read). */
    private _meshXZBoundsInto(m: Mesh3D, out: Float64Array): void {
        const c = m.obbCorners;
        if (!c || c.length === 0) { out[0] = m.x; out[1] = m.z; out[2] = m.x; out[3] = m.z; return; }
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const p of c) {
            if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
            if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
        }
        out[0] = minX; out[1] = minZ; out[2] = maxX; out[3] = maxZ;
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
        if (!this._collisionOn()) return this._nonPlayerMeshes();
        this._refreshCollisionGrid();
        if (this._collSnap) return this._collSnap.queryPoint(x, z, this._candMeshes);   // step 3b
        this._collisionGrid!.queryPoint(x, z, this._candIdx);
        return this._fillCandidates();
    }

    /** Meshes overlapping an XZ region — the wall-cast candidate set. */
    private _regionCandidates(minX: number, minZ: number, maxX: number, maxZ: number): Mesh3D[] {
        if (this._collSnap) return this._collSnap.query({ minX, minZ, maxX, maxZ }, this._candMeshes);
        if (!this._collisionGrid || !this._collisionMeshes) return this._nonPlayerMeshes();
        this._collisionGrid.query({ minX, minZ, maxX, maxZ }, this._candIdx);
        return this._fillCandidates();
    }

    /** Every mesh except the driven Player avatar (the no-grid fallback — you don't collide with / pull the camera in
     *  against your own body). */
    private _nonPlayerMeshes(): Mesh3D[] {
        const all = this.getAllMeshes();
        // The auto default player's hair / garments / face decal are the player too (else the camera ray hits its hair).
        return all.filter(m => !this._isPlayerPart(m) && !(Scene3DManager.visualOnlyNoCollide && isVisualOnlyMesh(m)));
    }
    /** A mesh of the auto default player (body or any overlay part). */
    private _isAutoPlayerPart(m: Mesh3D): boolean { return this.autoPlayer.isRuntimeNode(m.id); }
    /** A mesh that belongs to the driven Player (its body, any part of it, or the auto player): never a ray obstacle. */
    private _isPlayerPart(m: Mesh3D): boolean {
        return m === this._playerMesh || this._playerPartIds.has(m.id) || this._isAutoPlayerPart(m);
    }
    /** Collect the bound Player's parts (see _playerPartIds): the character overlays of a procedural body, every mesh
     *  skinned to its skeleton, and the mesh descendants of the body and of that skeleton (joint-attached props). */
    private _collectPlayerParts(m: Mesh3D): void {
        const ids = this._playerPartIds;
        ids.clear();
        ids.add(m.id);
        for (const id of this._character.overlayMeshIds(m.id)) ids.add(id);
        const skelId = (m as Mesh3D & { skeletonId?: string | null }).skeletonId ?? null;
        type Walkable = { forEachDeep(cb: (n: unknown) => void): void };
        const addDeep = (n: Walkable | null | undefined) => n?.forEachDeep((c) => { if (c instanceof Mesh3D) ids.add(c.id); });
        addDeep(m as unknown as Walkable);
        if (skelId) {
            for (const x of this.getAllMeshes()) if ((x as Mesh3D & { skeletonId?: string | null }).skeletonId === skelId) ids.add(x.id);
            addDeep(this.getSkeleton(skelId) as unknown as Walkable | null);
        }
    }

    /** Map the scratch index list (_candIdx) → the scratch mesh list (_candMeshes). */
    private _fillCandidates(): Mesh3D[] {
        const src = this._collisionMeshes!;
        const out = this._candMeshes;
        out.length = 0;
        for (const i of this._candIdx) out.push(src[i]);
        return out;
    }

    /** Horizontal wall collision (R6.2): knee / mid-body / head rays along the move (collision-math
     *  resolveHorizontalMove) — anything the knee ray hits is too tall to step onto and blocks (with a slide along it);
     *  lower steps pass and the ground clamp lifts the feet by at most stepHeight. Best-effort — no capsule sweep; see
     *  docs/specs/play-mode.md. */
    private _resolveWallMove(cc: CharacterController, fx: number, fz: number, tx: number, tz: number, radius: number): [number, number] {
        if (Math.hypot(tx - fx, tz - fz) < 1e-6) return [tx, tz];
        // Broadphase: the meshes near the whole move segment (± radius) — shared by every wall cast.
        const pad = radius + cc.cfg.stepHeight;
        const meshes = this._regionCandidates(Math.min(fx, tx) - pad, Math.min(fz, tz) - pad, Math.max(fx, tx) + pad, Math.max(fz, tz) + pad);
        return resolveHorizontalMove(this._rayCaster(meshes), fx, fz, tx, tz, cc.pos[1], radius, cc.cfg.stepHeight, cc.cfg.eyeHeight);
    }

    /** Snapshot every mesh's TRS (the source of truth — localMatrix is derived) so Play exits non-destructively.
     *  Captures position/rotation/scale because the Player mesh (and later physics/scripts) move via setPosition3D
     *  etc., which rebuild localMatrix from these fields — restoring only the matrix would be undone by any later
     *  rebuild. */
    private _snapshotTransforms(): PlayXformSnapshot {
        const meshes = this.getAllMeshes();
        const trs = new Float64Array(meshes.length * 9);
        for (let i = 0, o = 0; i < meshes.length; i++, o += 9) {
            const m = meshes[i];
            trs[o] = m.x; trs[o + 1] = m.y; trs[o + 2] = m.z;
            trs[o + 3] = m.rotationX; trs[o + 4] = m.rotationY; trs[o + 5] = m.rotation;
            trs[o + 6] = m.scaleX; trs[o + 7] = m.scaleY; trs[o + 8] = m.scaleZ;
        }
        return { meshes: meshes.slice(), trs };
    }

    /** Restore transforms captured by _snapshotTransforms — only the meshes Play actually MOVED (a compare of 9 floats;
     *  the static city never pays the 3 matrix rebuilds). A mesh removed meanwhile is a harmless detached object. */
    private _restoreTransforms(snap: PlayXformSnapshot): void {
        const { meshes, trs } = snap;
        for (let i = 0, o = 0; i < meshes.length; i++, o += 9) {
            const m = meshes[i];
            if (m.x === trs[o] && m.y === trs[o + 1] && m.z === trs[o + 2] && m.rotationX === trs[o + 3] && m.rotationY === trs[o + 4]
                && m.rotation === trs[o + 5] && m.scaleX === trs[o + 6] && m.scaleY === trs[o + 7] && m.scaleZ === trs[o + 8]) continue;
            m.setRotation3D(trs[o + 3], trs[o + 4], trs[o + 5]);
            m.setScale3D(trs[o + 6], trs[o + 7], trs[o + 8]);
            m.setPosition3D(trs[o], trs[o + 1], trs[o + 2]);   // last → one final localMatrix rebuild with all fields restored
        }
    }

    /** Apply the DERIVED camera rules. free3D claims the camera for orbit (the 2D auto-sync backs off — same
     *  mechanism City mode uses), shows the nav gizmo, frames the content; the 2D modes release it back to the
     *  locked illustration camera at the right projection and snap the view back. */
    private _applyViewState(): void {
        const rules = deriveViewRules(this._viewState);
        const cam = this.renderer3D.getCamera();
        // free3D owns pan+zoom via its orbit controller; block the 2D pan/zoom gestures from shifting the artboard.
        // (The 2D box-select marquee is also gated on this flag in raster-interaction-controller — cameraOwnsView is
        // the RELIABLE "a 3D camera owns the view" signal; suppressBoxSelect gets cleared by other load-time calls.)
        this.ctx.interactionService.cameraOwnsView = rules.freeNavigation;
        this._flyLookHeld = false;   // clear any stuck RMB-fly hold across a mode switch (re-armed by Scene below)
        if (rules.freeNavigation) {
            cam.mode = 'perspective';
            // SCENE target → Unity "flythrough" input scheme (RMB free-look + WASD, Alt+LMB orbit, MMB pan, LMB
            // select). Illustration target keeps the classic orbit scheme (you're inspecting the artboard).
            const sceneFly = this._viewState.target === 'scene';
            this.enableOrbitControls({ freeLookNav: sceneFly });
            this._configureFreeZoom();   // T7.1: constant-rate dolly-through zoom, no near stall, effectively unbounded
            if (sceneFly) {
                const orb = this._armature.getOrbitController();
                if (orb) {
                    // WASD fly is live ONLY while RMB free-look is held (Unity flythrough) — so WASD never flies the
                    // camera while you're typing in a field, and it matches the "hold RMB to fly" muscle memory.
                    orb.onLookStart = () => { this._flyLookHeld = true;  this._applyFly(); };
                    orb.onLookEnd   = () => { this._flyLookHeld = false; this._applyFly(); };
                }
            }
            this.enableViewGizmo();
            this._armature.setMeshEditOrbitCenter([0, 0, 0]);   // any non-null center → the 2D sync stops fighting orbit
            this.renderer3D.setMeshEditModeActive(true);        // clean 3D workspace bg (drops the 2D artboard composite)
            // …with a NEUTRAL backdrop, not the 'wavy' focus default. ★ NOT while City mode is up: there the same bg slot
            // IS the city's time-of-day SKY gradient (WorldManager._applyTimeOfDay), only rewritten when the time / look
            // changes — overwriting it here (a camera-mode switch, Play exit, mesh-edit exit...) left the near-black
            // workspace grey as the "sky" until the next time-of-day change: black above the skyline, all-black from
            // above the clouds (polish-round-3 "black sky at altitude").
            if (!this._cityModeActive) this.renderer3D.setMeshEditBgMode(VIEW_3D_BG);
            // Restore the remembered free-cam vantage (leaving+returning, and reload, land where you were);
            // frame all meshes only on the FIRST entry when nothing has been captured yet.
            const orbit = this._armature.getOrbitController();
            const f = this._viewState.freeCam;
            if (f && orbit) {
                cam.setTarget(f.target[0], f.target[1], f.target[2]);
                orbit.radius    = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, f.radius));
                orbit.azimuth   = f.yaw;
                orbit.elevation = Math.max(orbit.minElevation, Math.min(orbit.maxElevation, f.pitch));
                orbit.setRoll(typeof f.roll === 'number' ? f.roll : 0);   // the view roll (old saves: none → level); applies
            } else {
                orbit?.syncFromCamera();
                this.frameAllMeshes(1.4);
            }
        } else {
            // Locked 2D camera (ortho2D / perspective2D). The SCENE target has no artboard, so keep the clean 3D
            // workspace bg (no 2D composite) even in these modes; the illustration target restores its composite.
            const sceneBg = this._viewState.target === 'scene';
            // City mode keeps its sky backdrop in every camera mode (see the free3D branch above).
            this.renderer3D.setMeshEditModeActive(sceneBg || this._cityModeActive);
            if (sceneBg && !this._cityModeActive) this.renderer3D.setMeshEditBgMode(VIEW_3D_BG);
            this.disableOrbitControls();                        // also tears down the nav gizmo
            this._armature.setMeshEditOrbitCenter(null);
            this.setIllustrationProjection(rules.projection);
            this._forceIllustrationResync();                    // snap back to the locked 2D view now
        }
        this._applyArtboardFrame();
        this._applyFly();                                       // fly camera only lives in free3D edit
    }

    /** T7.1 / T7.4 — free-3D zoom: the wheel dolly is DOLLY-THROUGH (constant rate near the pivot, which is pushed
     *  forward instead of the zoom stalling — see wheelDollyStep) and effectively unbounded (tiny min radius, huge
     *  max; autoFar keeps the far plane enclosing the scene at any distance). Used by free3D and City mode. */
    _configureFreeZoom(): void {
        const orb = this._armature.getOrbitController();
        if (!orb) return;
        orb.dollyThrough = true;
        orb.minRadius = 1e-4;
        orb.maxRadius = 1e5;
    }

    /** T7.1: the dolly-through floor follows the FRAMED CONTENT size (10% of its bounding radius) — not the camera's
     *  sceneRadius, which the reference-grid floor inflates (a tiny object would otherwise stop the orbit 1.4 units
     *  away and fly straight through it). */
    private _setDollyFloor(contentRadius: number): void {
        const orb = this._armature.getOrbitController();
        if (orb) orb.dollyFloor = Math.max(1e-4, contentRadius * 0.1);
    }

    /** Enter a clean ORBIT view of a SINGLE mesh (packaging box / product preview). Frames it, then CLAIMS the
     *  camera for orbit by setting `_meshEditOrbitCenter` so the 2D illustration auto-sync BACKS OFF. Without this
     *  claim, the sync locks the 3D camera to the 2D pan/zoom (a front view looking down −Z) EVERY frame, so a
     *  mesh lying in the horizontal XZ plane — the flat packaging dieline at fold 0 — renders EDGE-ON = an
     *  invisible thin line (the "box never shows" bug). Default 3/4 top-down angle makes the flat net face-on;
     *  `altOrbitOnly` keeps left-drag free (for surface painting). Pair with {@link exitMeshOrbit3D}. */
    enterMeshOrbit3D(meshId: string, opts: { azimuth?: number; elevation?: number; padding?: number } = {}): void {
        this._stopPlayForEditorCamera('enterMeshOrbit3D');
        if (!this._inCameraSubMode()) this._captureCurrentPose();   // snapshot the mode we're leaving (first entry only) so exitMeshOrbit3D restores it
        this._armature.enterMeshOrbit3D(meshId, opts);
    }

    /** Claim the camera for external control at `center` (console/diagnostic tool): the illustration auto-sync
     *  backs off (same `_meshEditOrbitCenter` mechanism as the edit modes). Orbit state syncs if present. */
    claimCameraForOrbit3D(center: [number, number, number]): void { return this._armature.claimCameraForOrbit3D(center); }

    /** Leave the single-mesh / group orbit view (surface-paint, packaging, CD/creator stage): tear down orbit,
     *  then RESTORE the mode the user was actually in via `_applyViewState` (free3D stays free3D). The armature
     *  teardown's own `_forceIllustrationResync` only handles the 2D-entry case; this makes it correct for all. */
    exitMeshOrbit3D(): void {
        this._armature.exitMeshOrbit3D();
        this._applyViewState();
    }

    /** Like {@link enterMeshOrbit3D} but frames + orbits a whole GROUP container (the packaging box's
     *  rigid-panel hierarchy: a root MeshGroup3D over N panel meshes). Centre = mean of the panel centres. */
    enterGroupOrbit3D(groupId: string, opts: { azimuth?: number; elevation?: number; padding?: number } = {}): void {
        this._stopPlayForEditorCamera('enterGroupOrbit3D');
        if (!this._inCameraSubMode()) this._captureCurrentPose();   // snapshot the mode we're leaving (first entry only) so exitMeshOrbit3D restores it
        this._armature.enterGroupOrbit3D(groupId, opts);
    }

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

    /** ONE switch for the focus backgrounds' 'wavy' animation (armature, mesh edit / UV, the creator stage): true =
     *  animate, false = a still frame, null = the machine caps decide (the default). Starts / stops the live loop.
     *  Safe before the renderer boots (the switch is a Renderer3D static; nothing to sync until a renderer exists). */
    setFocusBgAnimate3D(on: boolean | null): void {
        Renderer3D.setFocusBgAnimate(on);
        if (!this.ctx.webgpuRenderer?.peekRenderer3D?.()) return;
        this._syncFocusBgLiveLoop();   // the mesh-edit hold follows meshEditBgAnimating; the keep-alive self-evaluates
        this.ctx.scheduleRender();     // one frame: an animating bg keeps the loop going from there, a frozen one stills
    }

    /** The focus backgrounds' 'wavy' theme animates (the switch, else the machine caps). */
    getFocusBgAnimate3D(): boolean { return Renderer3D.focusBgAnimateSwitch ?? Renderer3D.caps.animatedFocusBg; }

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
    addFlatColorMeshGroup(name: string, layers: FlatColorLayer3D[], silent = false, parent?: MeshGroup3D): MeshGroup3D {
        const group = this.beginFlatColorMeshGroup3D(name);
        for (const L of layers) this.addFlatColorLayer3D(group, L);
        this.attachFlatColorMeshGroup3D(group, parent, silent);
        return group;
    }

    /** Step 3b (performance-plan §P13 "Step 3b"): addFlatColorMeshGroup in pieces, so a streamed tile's group can be
     *  wrapped over several frames: begin (a DETACHED group), add layers / instance ranges, attach once complete. The
     *  pieces run exactly the one-shot code (same meshes, same order); the group is in the scene only once attached. */
    beginFlatColorMeshGroup3D(name: string): MeshGroup3D {
        const group = new MeshGroup3D(this.ctx.interactionService);
        group.name = name;
        return group;
    }
    /** Units of work in a layer for addFlatColorLayer3D: one per spawned instance mesh, else 1 (one world-baked mesh or
     *  one GPU-instanced ArrayGroup). */
    flatColorLayerUnits3D(L: FlatColorLayer3D): number {
        return L.instances && L.instances.length && !L.arrayGroup ? L.instances.length : 1;
    }
    /** Add units [from, from + count) of layer `L` to `group` (see flatColorLayerUnits3D). Returns the next unit. */
    addFlatColorLayer3D(group: MeshGroup3D, L: FlatColorLayer3D, from = 0, count = Infinity): number {
        if (L.propXf && L.propXf.length) {   // P20 instanced props (full look + per-copy 3×3s, one typed array)
            if (from === 0 && count > 0) this._addPropArrayInstances(group, L);
            return 1;
        }
        if (L.instances && L.instances.length && L.arrayGroup) {
            if (from > 0) return 1;
            // City-scale: ONE GPU-instanced ArrayGroup for all instances (1 node + 1 draw) instead of N meshes.
            this.addExplicitArrayInstances(group, { name: L.name, geometry: L.geometry, color: L.color, emissive: L.emissive,
                pattern: L.pattern, wind: L.wind, foliageShade: L.foliageShade, leafCard: L.leafCard,
                renderStyle: L.renderStyle, rim: L.rim, castShadow: L.castShadow, transforms: L.instances, garp: L.garp,
                geometryKey: L.instanceKey, nearTwin: L.nearTwin, crowd: L.crowdInst });
            return 1;
        }
        if (L.instances && L.instances.length) {
            const end = Math.min(L.instances.length, from + count);
            for (let i = from; i < end; i++) this._makeFlatMesh(group, L, L.instances[i]);
            return end;
        }
        if (from === 0 && count > 0) this._makeFlatMesh(group, L);
        return 1;
    }
    /** Attach a group built with begin / addFlatColorLayer3D (the one-shot path's last step). */
    attachFlatColorMeshGroup3D(group: MeshGroup3D, parent?: MeshGroup3D, silent = false): void {
        (parent ?? this.ctx.sceneGraph.root).addChild(group);
        // `silent` (async city staging): the group is added HIDDEN and will be revealed on the swap. Skip the
        // scene-graph-changed notification so the host never processes the transient old-city + new-city ("2N")
        // state across the staging frames — that intermediate is where a host mesh cache would capture the
        // soon-to-be-removed old meshes and leak them. One notification fires at the reveal instead.
        if (!silent) this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }

    // Build one mesh for a layer at a given transform + tint. When a layer carries `instances`, its geometry is
    // LOCAL/canonical and we spawn one mesh PER instance, all sharing the geometry via `instanceKey` (→ one pool
    // allocation + batched instanced draws). Per-instance `tint` overrides the layer colour (free — material is
    // per-instance). No `instances` → one world-baked mesh at the origin (the original behaviour).
    private _makeFlatMesh(group: MeshGroup3D, L: FlatColorLayer3D, inst?: { x: number; y: number; z: number; ry: number; tint?: [number, number, number] }): void {
        const m = new Mesh3D(this.ctx.interactionService, inst?.x ?? 0, inst?.y ?? 0, inst?.z ?? 0, { primitive: 'custom', geometry: L.geometry, material: { doubleSided: !L.singleSided, roughness: 1, metalness: 0 } });
        if (inst && inst.ry) m.setRotation3D(0, inst.ry, 0);
        m.name = L.name;
        if (L.outlineRanges) this._meshOutlineRanges.set(m.id, L.outlineRanges);   // per-object sub-ranges (landmark exact-silhouette hover)
        m.pickable = false;   // the city is decoration, not individually selectable — the picker skips it (no per-mesh BVH build → hover/click stays 60fps after a regen)
        m.excludeFromDocument = true;   // procedural — regenerates from world params on load; never serialize its geometry (autosave freeze + bloat)
        if (L.excludeFromFrame) m.frameExclude = true;   // far decoration (void grid / apron) must not drag the auto-frame out
        // Shared-archetype geometry (traffic movers / instanced building detail): same key → ONE pool allocation + batched instanced draws.
        if (L.instanceKey) m.setGeometryKeyOverride('wld:' + L.instanceKey);
        if (L.groundUvSample) m.groundUvSample = L.groundUvSample;   // chunked ground → the unsplit uv scale (world/chunking.ts)
        if (L.nearTwin) {   // E2 near/far twin (chipped edges near only); P9 mid / xfar tiers + degraded prop far twins
            const tr = L.nearTwin.role;
            m.lodTwinRole = tr === 'near' ? 1 : tr === 'far' ? 2 : tr === 'mid' ? 3 : 4;
            m.lodTwinDist = L.nearTwin.dist; m.lodTwinDist2 = L.nearTwin.dist2 ?? 0; m.lodTwinOffNear = !!L.nearTwin.uvFromNear;
        }
        const col = inst?.tint ?? L.color;
        m.setDiffuseColor(col[0], col[1], col[2], 1);
        const e = L.emissive ?? 0.45;   // half-emissive default → reads flat/even like a map; higher = glows (neon / lit windows at night)
        m.material.emissive = { r: col[0] * e, g: col[1] * e, b: col[2] * e, a: 1 };
        if (L.opacity !== undefined && L.opacity < 1) m.material.opacity = L.opacity;   // clouds → transparent pass
        if (L.leafCard) m.material.leafCard = true;   // alpha-cut leaf silhouette (foliage cards)
        if (L.glass) m.material.glassEnhance = true;   // stylized fresnel sky-reflection glass (toggle-gated)
        if (L.radialFade) m.material.radialFade = true;   // soft radial edge dissolve (lamp light-pools → glow, not sticker)
        if (L.noFog) m.material.noFog = L.noFog;   // sky / clouds: no fog ('hardEdge' = only under Hard fog edge)
        if (L.reflect) {   // car-paint clearcoat: raise metalness + drop roughness → the base envSpecular reflects the sky hemisphere (GT sheen)
            m.material.metalness = L.reflect.strength ?? 0.4;
            m.material.roughness = L.reflect.roughness ?? 0.32;
        }
        if (L.renderStyle) m.material.renderStyle = L.renderStyle;   // per-layer style override (toon foliage)
        if (L.rim) m.material.rimEnabled = true;                     // Fresnel back-light (Ghibli leaves)
        applyFoliageLook(m.material, L.wind, L.foliageShade);        // S1 wind + S2 translucency/AO/ground blend
        // GARP on a NON-instanced (world-baked) layer — e.g. the city's advert sign faces (docs/ui/garp.md
        // §Adverts): the whole mesh samples ONE GARP atlas layer, named by the marker's skin (baked UVs pick the
        // region). Resolved per session (a layer index is never stored); blank until the pool resolves.
        if (L.garp && !(L.instances && L.instances.length) && this._garpLayerResolver) {
            m.material.hasTexture = true;
            m.material.garpTex = true;
            m.garpLayer = this._garpLayerResolver(L.garp.pool, L.garp.slot, 0, 0, L.garp.seed, L.garp.skin);
        }
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
        /** Share ONE GPU geometry allocation with every other source carrying the same key (a canonical geometry
         *  split into per-cell groups by world/chunking.ts). Only set when the geometry object really is identical. */
        geometryKey?: string;
        /** P8 instanced NEAR/FAR TWIN (the far tree crowns): the source mesh (instance 0, drawn by the renderer's mesh
         *  loop) and through it the ArrayGroup (the other N-1, the renderer's group twins) carry the twin role. */
        nearTwin?: { role: 'near' | 'far' | 'mid' | 'xfar'; dist: number; dist2?: number; uvFromNear?: boolean };
        /** `s` = per-instance uniform scale (tree size variation without another geometry variant); `skin` = the
         *  GARP skin NAME for this copy (only when `garp` is set — resolved to an atlas layer, never serialized). */
        transforms: { x: number; y: number; z: number; ry: number; s?: number; skin?: string; sv?: [number, number, number]; cs?: [number, number, number]; pi?: number }[];
        /** P12 INSTANCED CROWD (world/crowd-instanced.ts): the source is a never-drawn PHANTOM (Mesh3D.arraySourceOnly) and
         *  EVERY transform is a copy — so any one person can be hidden (InstanceOverride.visible) for a tier swap or a
         *  live-crowd promotion. Copies carry a non-uniform scale `sv` (width, height, width) and packed palette
         *  slots `cs` (Material3D.crowdPalette); `pi` (the person index) rides on the group as `crowdPi`. The twin is
         *  EXTERNALLY driven (Mesh3D.lodTwinExternal: world-crowd.ts decides which tier of a cell draws). */
        crowd?: { id: string };
    }): void {
        const T = opts.transforms;
        if (!T.length) return;
        if (opts.crowd) { this._addCrowdArrayInstances(parent, opts as typeof opts & { crowd: { id: string } }); return; }
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
        if (opts.geometryKey) src.setGeometryKeyOverride('wld:' + opts.geometryKey);
        src.setDiffuseColor(opts.color[0], opts.color[1], opts.color[2], 1);
        const e = opts.emissive ?? 0.45;
        src.material.emissive = { r: opts.color[0] * e, g: opts.color[1] * e, b: opts.color[2] * e, a: 1 };
        if (opts.castShadow) src.castsInstancedShadow = true;
        if (opts.nearTwin && (opts.nearTwin.role === 'near' || opts.nearTwin.role === 'far')) {   // P8 (two-tier only)
            src.lodTwinRole = opts.nearTwin.role === 'near' ? 1 : 2;
            src.lodTwinDist = opts.nearTwin.dist; src.lodTwinOffNear = !!opts.nearTwin.uvFromNear; src.lodTwinInstanced = true;
        }
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

    /** P12 instanced crowd cell group (see addExplicitArrayInstances' `crowd`). */
    private _addCrowdArrayInstances(parent: MeshGroup3D, opts: { name: string; geometry: MeshGeometry; color: [number, number, number]; emissive?: number; castShadow?: boolean;
        geometryKey?: string; nearTwin?: { role: 'near' | 'far' | 'mid' | 'xfar'; dist: number; dist2?: number }; crowd: { id: string };
        transforms: { x: number; y: number; z: number; ry: number; s?: number; sv?: [number, number, number]; cs?: [number, number, number]; pi?: number }[] }): void {
        const T = opts.transforms;
        const src = new Mesh3D(this.ctx.interactionService, T[0].x, T[0].y, T[0].z, { primitive: 'custom', geometry: opts.geometry, material: { doubleSided: true, roughness: 1, metalness: 0 } });
        src.name = opts.name;
        src.pickable = false;
        src.excludeFromDocument = true;
        src.arraySourceOnly = true;
        if (opts.geometryKey) src.setGeometryKeyOverride('wld:' + opts.geometryKey);
        src.setDiffuseColor(opts.color[0], opts.color[1], opts.color[2], 1);
        const e = opts.emissive ?? 0.45;
        src.material.emissive = { r: opts.color[0] * e, g: opts.color[1] * e, b: opts.color[2] * e, a: 1 };
        src.material.crowdPalette = true;
        if (opts.castShadow !== false) src.castsInstancedShadow = true;   // the baked crowd's meshes cast; so do its copies
        // EXTERNAL three-tier role (mid): world-crowd.ts writes lodTwinNear (false) / lodTwinNear2 (= any copy shown).
        src.lodTwinRole = 3; src.lodTwinExternal = true; src.lodTwinNear = false; src.lodTwinNear2 = true;
        src.lodTwinDist = opts.nearTwin?.dist ?? 0; src.lodTwinDist2 = opts.nearTwin?.dist2 ?? 0;
        src.gpuDirty = true;
        parent.addChild(src);
        const arr = new ArrayGroup3D(this.ctx.interactionService, src.id, { mode: 'explicit', offsets: T.map(t => [t.x, t.y, t.z] as [number, number, number]) });
        arr.name = `${opts.name} ×${T.length}`;
        const DEG = 180 / Math.PI, overrides = new Map<number, InstanceOverride>();
        for (let i = 0; i < T.length; i++) {
            const t = T[i], s = t.s ?? 1;
            overrides.set(i, { rotationEulerDeg: [0, t.ry * DEG, 0], scale: t.sv ? [t.sv[0], t.sv[1], t.sv[2]] : [s, s, s], ...(t.cs ? { crowdSlots: t.cs } : {}) });
        }
        arr.instanceOverrides = overrides;
        (arr as unknown as { crowdPi?: Int32Array; crowdId?: string }).crowdPi = Int32Array.from(T, t => t.pi ?? -1);
        (arr as unknown as { crowdId?: string }).crowdId = opts.crowd.id;
        parent.addChild(arr);
        this.registerRestoredArrayGroups();
    }

    /** P20 INSTANCED PROPS (world/prop-instancing.ts): the layer's WHOLE look (metal / ground / neon / pattern / glass …,
     *  exactly as _makeFlatMesh dresses a baked layer) on a never-drawn PHANTOM source at the origin, and an ArrayGroup
     *  whose every copy is an instance with its own 3×3 model part + normal matrix, read straight from the layer's
     *  typed `propXf` (ArrayGroup3D.instanceXf: no per-copy objects). The copies cast shadows and feed the outline
     *  prepass like the baked layer's mesh did (castsInstancedShadow). */
    private _addPropArrayInstances(parent: MeshGroup3D, L: FlatColorLayer3D): void {
        const xf = L.propXf!, S = 21, n = Math.floor(xf.length / S);
        const { instances: _drop, arrayGroup: _ag, propInst: _pi, propXf: _xf, ...look } = L;
        void _drop; void _ag; void _pi; void _xf;
        this._makeFlatMesh(parent, look as FlatColorLayer3D);
        const src = parent.children[parent.children.length - 1] as Mesh3D;
        src.arraySourceOnly = true;
        if (L.castShadow !== false) src.castsInstancedShadow = true;
        if (src.lodTwinRole === 1 || src.lodTwinRole === 2) src.lodTwinInstanced = true;
        const offsets: [number, number, number][] = new Array(n);
        for (let i = 0; i < n; i++) offsets[i] = [xf[i * S], xf[i * S + 1], xf[i * S + 2]];
        const arr = new ArrayGroup3D(this.ctx.interactionService, src.id, { mode: 'explicit', offsets });
        arr.name = `${L.name} ×${n}`;
        arr.instanceXf = xf;
        parent.addChild(arr);
        this.registerRestoredArrayGroups();
    }

    /** P12: re-pack these ArrayGroups' instance slots after their instanceOverrides changed (renderer repackArrayGroups). */
    repackArrayGroups3D(groups: Iterable<ArrayGroup3D>): number { return this.renderer3D?.repackArrayGroups?.(groups) ?? 0; }
    /** P12: whether a mesh's geometry is resident on the GPU (drawable this frame). */
    hasMeshGeometry3D(m: Mesh3D): boolean { return this.renderer3D?.hasMeshGeometry?.(m) ?? false; }
    /** P12: add ONE procedural flat-colour mesh (a lazily built crowd cell) under an EXISTING city group, quietly
     *  (no host notification — call notifySceneStructureChanged3D after a batch). Same defaults as addFlatColorMeshGroup's
     *  meshes: not pickable, never serialized. The caller sets the material / LOD fields. */
    addProceduralMesh3D(group: MeshGroup3D, name: string, geometry: MeshGeometry): Mesh3D {
        const m = new Mesh3D(this.ctx.interactionService, 0, 0, 0, { primitive: 'custom', geometry, material: { doubleSided: true, roughness: 1, metalness: 0 } });
        m.name = name;
        m.pickable = false;
        m.excludeFromDocument = true;
        m.gpuDirty = true;
        group.addChild(m);
        return m;
    }
    /** P12: remove a mesh added by addProceduralMesh3D (evicts the picker + renderer caches, frees its geometry). */
    removeProceduralMesh3D(m: Mesh3D): void {
        this._picker.evictMesh(m.id); this._picker.setDetached(m, true);
        this.renderer3D.evictMeshCaches([m.id]);
        m.parent?.removeChild(m);
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
        this.ctx.webgpuRenderer.addPreRenderCallback(this._scatterLodCb, 'scatterLod');
    }

    /** RE-ATTACH a group previously removed by {@link removeFlatColorMeshGroup} (the streamed-tile LRU cache).
     *  The group's meshes keep their draped/positioned geometry, so re-attaching skips generation entirely; the
     *  VRAM side was evicted on removal, so children re-mark gpuDirty for a fresh pool append. */
    reattachFlatColorMeshGroup(group: MeshGroup3D, parent?: MeshGroup3D, silent = false): void {
        // P16: a removal whose renderer cleanup is still queued finishes now (a resident allocation + gpuDirty would
        // read as an EDITED mesh and rebuild the whole pool).
        this.renderer3D.flushDeferredEviction(group.children.filter((ch): ch is Mesh3D => ch instanceof Mesh3D));
        for (const ch of group.children) if (ch instanceof Mesh3D) { ch.gpuDirty = true; this._picker.setDetached(ch, false); }
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
        // P16 deferredEviction (stream-hitch.ts): the group leaves the scene and the picker NOW (not drawn, not hit), and
        // the renderer's per-mesh cleanup is queued and drained under a per-frame budget (evictMeshCachesDeferred).
        const gone: Mesh3D[] = [];
        for (const ch of group.children) {
            if (ch instanceof Mesh3D) { gone.push(ch); this._picker.evictMesh(ch.id); this._picker.setDetached(ch, true); }
        }
        this.renderer3D.evictMeshCachesDeferred(gone);
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

    /** T7.2 — "RETURN TO THE SCENE": frame everything VISIBLE in the scene (or under `root`, e.g. the City wrapper)
     *  from the current view direction, excluding `frameExclude` far decoration (sky stars/moon, void grid, apron,
     *  border glow). Uses the renderer's CACHED world AABBs (no per-vertex scan — cheap on a whole city). A
     *  below-horizon / grazing view is lifted to a 3/4 angle. Syncs the orbit controller + autoFar. Returns false
     *  when there's nothing to frame. The host button sits by the zoom controls (free 3D / City mode). */
    frameScene3D(opts: { padding?: number; root?: MeshGroup3D | null; skip?: (m: Mesh3D) => boolean } = {}): boolean {
        let meshes: Mesh3D[];
        if (opts.root) { meshes = []; opts.root.forEachDeep(n => { if (n instanceof Mesh3D) meshes.push(n); }); }
        else meshes = this.getAllMeshes();
        if (opts.skip) meshes = meshes.filter(m => !opts.skip!(m));
        const b = sceneFrameBounds(meshes, (m) => this.renderer3D.getMeshWorldAABB3D(m));
        if (!b) return false;
        const cam = this.renderer3D.getCamera();
        const orbit = this._armature.getOrbitController();
        orbit?.stopDamping();
        const pose = framePose(b, [cam.position[0] - cam.target[0], cam.position[1] - cam.target[1], cam.position[2] - cam.target[2]],
            { mode: cam.mode, fov: cam.fov, aspect: cam.aspect, padding: opts.padding ?? 1.1, roll: orbit?.effectiveRoll ?? 0 });   // tight 8-corner box fit + 10% margin
        cam.autoFar = true;
        cam.sceneRadius = Math.max(pose.radius, this._gridRadiusFloor());
        this._setDollyFloor(pose.radius);
        if (pose.orthoSize != null) cam.orthoSize = pose.orthoSize;
        cam.lookAt(pose.position[0], pose.position[1], pose.position[2], pose.target[0], pose.target[1], pose.target[2]);
        orbit?.syncFromCamera();
        this.ctx.scheduleRender();
        return true;
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
    /** The scene STRUCTURE version (bumps on node add / remove): a cheap "did the scene change" stamp for callers. */
    sceneStructureVersion3D(): number { return this.ctx.sceneStructureVersion(); }

    cacheGroupBounds(group: MeshGroup3D, exclude?: (name: string) => boolean): void {
        // Step 3 (group-bounds.ts): the same min / max from per-geometry boxes cached by vertex array — only geometry
        // not seen before is scanned. Off = the full vertex walk below.
        if (Scene3DManager.STEP3.cachedGroupBounds) { const job = new GroupBoundsJob(group, exclude); job.step(); group.cachedBounds = job.result(); return; }
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
        if (this._isInternalV2Shape(meshId, shapeIndex)) return;
        this._blendShapes.setWeight(meshId, shapeIndex, weight);
    }
    /** A Character v2 body's own 'v2:*' shapes are driven by its sliders (with the matching bone offsets): a generic
     *  weight edit / removal fought them (vertices moved, bones didn't; the next slider reset it). Refused (review fix
     *  pipeline#5). */
    private _isInternalV2Shape(meshId: string, shapeIndex: number): boolean {
        const m = this.getMesh(meshId);
        if ((m as { characterKind?: string } | null)?.characterKind !== 'v2') return false;
        if (!m!.blendShapes[shapeIndex]?.name.startsWith('v2:')) return false;
        console.warn('[3D] blend shape "' + m!.blendShapes[shapeIndex].name + '" belongs to the Character v2 sliders (sm.characterV2.setSlider)');
        return true;
    }

    getBlendShapes3D(meshId: string): { name: string; weight: number }[] {
        return this._blendShapes.list(meshId);
    }

    removeBlendShape3D(meshId: string, shapeIndex: number): void {
        if (this._isInternalV2Shape(meshId, shapeIndex)) return;
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

            this._restoreOutline(skinnedMesh, state);   // characters' outlines never came back (these branches returned first)
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
            this._restoreOutline(skinnedMesh, state);   // characters' outlines never came back (these branches returned first)
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
            this._restoreOutline(skinnedMesh, state);   // characters' outlines never came back (these branches returned first)
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
            // The saved EDIT topology (edit-mesh-topology.md §5): rebuild it and recompile, so the mesh comes back
            // welded with its quads / seams and its vertex-colour render path, exactly as saved. (A save without it —
            // older documents — rebuilds the topology from the geometry when it next enters Edit Mesh.)
            if (state.editMesh && mesh && !(mesh instanceof SkinnedMesh3D)) {
                try { mesh.editMesh = EditMesh.fromJSON(state.editMesh); mesh.syncFromEditMesh(); }
                catch { mesh.editMesh = null; }
            }
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
        // A saved hasNormalMap with NOTHING behind it (a raw, unpersisted map — audit P13) would put the mesh on the
        // normal-mapped path with no map to sample. Keep the flag only if a GLB map is bound or a library map will be.
        if (mesh.material.hasNormalMap && !mesh.normalMapTexture && !mesh.normalMapLibraryId) mesh.material.hasNormalMap = false;
        // Persistent per-object outline: restore onto the mesh + mirror into the renderer's runtime draw cache.
        this._restoreOutline(mesh, state);
        mesh.cameraBlock = isCameraBlockMode(state.cameraBlock) ? state.cameraBlock : 'auto';   // Play camera occluder override
        if (state.keyframeTracks) mesh.keyframeTracks = cloneKeyframeTracks(state.keyframeTracks);
        if (state.frameLinkAnimation3D) this.setFrameLinkAnimation3D(mesh.id, state.frameLinkAnimation3D);
        this._restoreSubmeshes(mesh, state.submeshes);
        // Generator settings (Add Mesh › Cylinder… etc.): the restored geometry is what they last made, unless saved edited
        mesh.generator = readGeneratorRecord(state.generator);
        if (mesh.generator) mesh.stampGenerator();

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
    enableOutlines(color?: [number, number, number, number], threshold?: number, depthFade?: { near: number; far: number; minAlpha?: number } | null,
        extras?: import('../../renderer/3d/outline-pass').OutlineExtras): void {
        this.renderer3D.enableOutlines(color, threshold, depthFade, extras);   // depthFade / extras.creaseFade: world units (visual-polish #8 / #3)
        this.ctx.scheduleRender();
    }

    // ── PLAYER LIGHT (visual-polish #7c): a small key light riding with the Play player (src/game/player-light.ts) ──
    private _playerLightCfg: import('../../game/player-light').PlayerLightConfig | null = null;
    /** Turn the Play player light on (`{ strength, color }`) or off (null). Applied each Play render frame; outside
     *  Play nothing is lit. WorldManager drives it from CityLook.playerLight × the night level. */
    setPlayerLight3D(cfg: import('../../game/player-light').PlayerLightConfig | null): void {
        this._playerLightCfg = cfg && cfg.strength > 0 ? { strength: cfg.strength, color: [cfg.color[0], cfg.color[1], cfg.color[2]] } : null;
        if (!this._playerLightCfg) this.renderer3D.setPinnedPointLights([]);
        this.ctx.scheduleRender();
    }
    get playerLight3D(): import('../../game/player-light').PlayerLightConfig | null { return this._playerLightCfg ? { ...this._playerLightCfg, color: [...this._playerLightCfg.color] as [number, number, number] } : null; }
    private _updatePlayerLight(cc: CharacterController, feet: [number, number, number], eye: [number, number, number]): void {
        const cfg = this._playerLightCfg;
        if (!cfg) return;
        const pl = placePlayerLight(feet, eye, cc.cfg.eyeHeight, cfg);
        this.renderer3D.setPinnedPointLights(pl ? [pl] : []);
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
        if (Scene3DManager.STEP2.iterativeSceneWalk) { this._walkScene(ver); return this._allMeshesCache!; }
        const meshes: Mesh3D[] = [];
        this.ctx.sceneGraph.root.forEachDeep?.((n: any) => {
            if (n instanceof Mesh3D) meshes.push(n);
        });
        this._allMeshesCache = meshes;
        this._allMeshesCacheVer = ver;
        return meshes;
    }
    /** Step 2: ONE preorder walk (explicit stack, no closure per node; the same order as forEachDeep) fills both the
     *  mesh and the skeleton caches for this structure version — they were two separate whole-graph walks per change. */
    private _walkScene(ver: number): void {
        const meshes: Mesh3D[] = [], skeletons: Skeleton3D[] = [];
        const stack: any[] = [this.ctx.sceneGraph.root];
        while (stack.length) {
            const n = stack.pop();
            if (n instanceof Mesh3D) meshes.push(n);
            else if (n instanceof Skeleton3D) skeletons.push(n);
            const ch = n.children as any[] | undefined;
            if (ch) for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
        }
        // (a cache already current for this version keeps its array identity)
        if (!this._allMeshesCache || this._allMeshesCacheVer !== ver) { this._allMeshesCache = meshes; this._allMeshesCacheVer = ver; }
        if (!this._allSkeletonsCache || this._allSkeletonsCacheVer !== ver) { this._allSkeletonsCache = skeletons; this._allSkeletonsCacheVer = ver; }
    }

    /**
     * Render stats for an optional perf HUD. Triangle/vertex/object counts are the VISIBLE scene geometry (the
     * render cost); `byCategory` splits the triangles so the user can see WHAT to simplify. `geometryBytes` is the
     * exact mesh vertex+index buffer size (not full VRAM — textures aren't summed here). `frameMs` = the last
     * frame's CPU encode time; `fps` = render rate over the last second (0 when idle — on-demand rendering).
     * NOTE: array-tool GPU instances aren't multiplied in yet (the base mesh is counted once) — a v2 add, like the
     * real GPU time (needs the `timestamp-query` feature). GP strokes are a separate render path → reported as a count.
     *
     * ★ P11 (performance-plan.md): `triangles` is the SCENE's geometry — every visible-flagged mesh's triangles summed,
     * BEFORE frustum culling, distance LOD, near/far twins (both twins count) and fog; instanced copies count once.
     * It does not change when the camera turns (facing a wall reads the same as facing the whole city). It is kept
     * for compatibility. What the GPU really draws is `drawn` (triangles submitted last frame, per pass, instanced
     * copies multiplied): `main` = the colour pass (what is on screen), `shadow` = the shadow maps at their last
     * refresh, `other` = outline / SSAO-SSR / mirror prepasses. `drawCalls` is the same split for draw calls.
     */
    getRenderStats3D(): {
        triangles: number; vertices: number; objects: number;
        byCategory: { body: number; hair: number; clothing: number; charms: number; face: number; scenery: number };
        geometryBytes: number; gpStrokes: number; frameMs: number; fps: number; gpuName: string | null;
        sceneTriangles: number;
        drawn: PassSplit; drawCalls: PassSplit;
        culling: { meshesCulled: number; groupsCulled: number; lodHidden: number; fogHidden: number; trisCulledMain: number };
    } {
        let triangles = 0, vertices = 0, geometryBytes = 0, objects = 0;
        const byCategory = { body: 0, hair: 0, clothing: 0, charms: 0, face: 0, scenery: 0 };
        if (Scene3DManager.STEP2.cachedRenderStats) {
            // Step 2 (performance-plan §P13): each poll walked every mesh's geometry (~0.45 ms at 11.5 k meshes). The
            // per-mesh figures (triangles, vertices, bytes, category) are cached per (structure version, geometry
            // epoch); a poll only reads each mesh's `visible` flag and sums. A full refresh every 2 s backs up the
            // keys (a modifier list edited without invalidateModifierCache).
            const c = this._statsCache(), meshes = c.meshes, T = c.tris, V = c.verts, B = c.bytes, K = c.cat;
            const cat = [0, 0, 0, 0, 0, 0];
            for (let i = 0; i < meshes.length; i++) {
                if (!meshes[i].visible) continue;
                objects++;
                const t = T[i];
                triangles += t; vertices += V[i]; geometryBytes += B[i]; cat[K[i]] += t;
            }
            byCategory.body = cat[0]; byCategory.hair = cat[1]; byCategory.clothing = cat[2]; byCategory.charms = cat[3]; byCategory.face = cat[4]; byCategory.scenery = cat[5];
        } else
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
        const fs = this.renderer3D.getFrameStats3D();
        const split = splitPassStats(fs);
        return { triangles, vertices, objects, byCategory, geometryBytes, gpStrokes: this.getAllGpObjects().length, ...timing,
            sceneTriangles: triangles, drawn: split.tris, drawCalls: split.draws,
            culling: { meshesCulled: fs.meshesCulled, groupsCulled: fs.groupsCulled, lodHidden: fs.lodHidden, fogHidden: fs.fogHidden,
                trisCulledMain: Math.max(0, fs.trisTotal - fs.trisVisible) } };
    }

    // ── Step 3 BUDGETS (docs/ui/performance.md §Budgets) ────────────────────────────────────────────────────────────
    /** Scene budgets the HUD warns against (session setting; sm.setSceneBudget3D). */
    static readonly SCENE_BUDGET_DEFAULTS: SceneBudgetLimits3D = { ...SCENE_BUDGET_DEFAULTS };
    private _budget: SceneBudgetLimits3D = { ...Scene3DManager.SCENE_BUDGET_DEFAULTS };
    /** Set (a patch of) the budgets; null / 0 for a key = no limit. Returns the limits now in force. */
    setSceneBudget3D(patch: Partial<SceneBudgetLimits3D> | null): SceneBudgetLimits3D {
        if (patch === null) this._budget = { ...Scene3DManager.SCENE_BUDGET_DEFAULTS };
        else for (const k of Object.keys(patch) as (keyof SceneBudgetLimits3D)[]) { const v = patch[k]; if (v === undefined) continue; this._budget[k] = v && v > 0 ? v : 0; }
        return { ...this._budget };
    }
    /** The scene against its budgets: this frame's submitted triangles and draw calls (every pass that ran this frame:
     *  main + the shadow maps re-rendered this frame + the depth / mirror passes), the resident geometry (the GPU pool's
     *  live MB), the instanced copies drawn from array groups, and the keys over budget with a one-line warning (null
     *  when everything is within). Cheap: reads the renderer's frame counters (poll it like getRenderStats3D). */
    getSceneBudget3D(): SceneBudget3D {
        const fs = this.renderer3D.getFrameStats3D();
        const split = splitPassStats(fs);
        const pool = this.renderer3D.getGeomPoolStats();
        const drawnTris = split.tris.main + split.tris.other + split.tris.shadowThisFrame;
        const drawCalls = split.draws.main + split.draws.other + split.draws.shadowThisFrame;
        const geometryMB = pool.liveMB;
        const instances = fs.instances;
        const L = this._budget;
        const { over, warning } = evaluateSceneBudget({ drawnTris, drawCalls, geometryMB, instances }, L);
        return { drawnTris, drawCalls, geometryMB, instances, meshes: fs.meshes, mainTris: split.tris.main, shadowTris: split.tris.shadowThisFrame,
            limits: { ...L }, over, ok: over.length === 0, warning };
    }

    private _stats: { ver: number; epoch: number; at: number; meshes: Mesh3D[]; tris: Float64Array; verts: Float64Array; bytes: Float64Array; cat: Uint8Array } | null = null;
    /** Step 2: the per-mesh stats figures for getRenderStats3D (see there). Category: 0 body · 1 hair · 2 clothing ·
     *  3 charms · 4 face · 5 scenery — the same if-chain as the uncached loop. */
    private _statsCache(): { meshes: Mesh3D[]; tris: Float64Array; verts: Float64Array; bytes: Float64Array; cat: Uint8Array } {
        const ver = this.ctx.sceneStructureVersion(), epoch = Mesh3D.geometryEpoch, now = performance.now();
        const s = this._stats;
        if (s && s.ver === ver && s.epoch === epoch && now - s.at < 2000 && s.meshes === this.getAllMeshes()) return s;
        const meshes = this.getAllMeshes(), n = meshes.length;
        const tris = new Float64Array(n), verts = new Float64Array(n), bytes = new Float64Array(n), cat = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const m = meshes[i];
            tris[i] = m.triangleCount; verts[i] = m.vertexCount;
            const g = m.geometry; bytes[i] = g.vertices.byteLength + g.indices.byteLength;
            cat[i] = m.isProceduralBody ? 0 : m.isHair ? 1 : m.isClothing ? 2 : m.isAttachment ? 3 : m.isFaceDecal ? 4 : 5;
        }
        // (the geometry reads above can evaluate modifiers and bump the epoch: key on the value after them)
        const out = { ver, epoch: Mesh3D.geometryEpoch, at: now, meshes, tris, verts, bytes, cat };
        this._stats = out;
        return out;
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
        if (Scene3DManager.STEP2.iterativeSceneWalk) { this._walkScene(ver); return this._allSkeletonsCache!; }
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
        // serializeSkeletonForSave DROPS the unedited default clips/poses (they rebuild
        // deterministically) — this backfill is the restore half of that contract. Without it a
        // reloaded procedural body came back with an EMPTY Clips panel + Pose Library (found by
        // the P6 round-trip drive, 2026-09-15). Idempotent: existing names are never duplicated.
        if (skel.isProceduralBody) {
            try { this.installDefaultAnimations(skel.id); }
            catch (e) { console.warn('[Anim] default backfill on restore failed', e); }
        }
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

    /** Fetch and parse a kitbash part manifest. Parts then available via getKitbashParts(). */
    async loadKitbashManifest(url: string): Promise<void> { return this._kitbash.loadKitbashManifest(url); }

    /** Register parts from a pre-parsed array (e.g. from a bundled import). */
    addKitbashParts(parts: KitbashPartMeta[]): void { this._kitbash.addKitbashParts(parts); }

    /** Return all parts for a given slot, or [] if none are loaded. */
    getKitbashParts(slot: CharacterSlot): KitbashPartMeta[] { return this._kitbash.getKitbashParts(slot); }

    /** Return all slot types that have at least one part loaded. */
    getKitbashSlots(): CharacterSlot[] { return this._kitbash.getKitbashSlots(); }

    // ── Character assembly (Phase B) ─────────────────────────────────

    /** Assemble a character from a CharacterDefinition (GLB kitbash). Returns the stable character ID. */
    async createCharacter(def: CharacterDefinition, ox = 0, oy = 0, oz = 0): Promise<string> {
        return this._kitbash.createCharacter(def, ox, oy, oz);
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
        opts?: { sceneScale?: boolean },
    ): Promise<{ meshId: string; skeletonId: string }> {
        const { NEW_BODY_DEFAULTS } = await import('./body-generator');
        // NEW bodies get the measured joint-smoothness seam blend (audit C1 Phase 1) + the anime face normals (polish item 10);
        // a caller can still pass its own (0 = classic). Saved bodies never come through here — they restore their own
        // params (absent = 0 = classic).
        params = { ...NEW_BODY_DEFAULTS, ...(params ?? {}) };
        // Generated OFF the main thread ('character' worker lane, performance-plan P3.2d); a worker failure falls back
        // to the same generator here (identical output either way).
        const merged = params;
        const result = await generateBodyAsync(merged).catch(() => generateBodyResult(merged));
        return this._commitProceduralBody(params, result, ox, oy, oz, opts?.sceneScale !== false);
    }

    /** createProceduralBody3D + its garments/hair generated in ONE worker job (body → fit → garments → hair, the
     *  final dressed state). The body is committed like createProceduralBody3D; the garment/hair geometry is PRIMED
     *  on the character subsystem so the caller's following setClothingParams / setHairParams calls (garments first,
     *  then hair) just wrap + upload it. Inputs that don't match what was primed simply generate synchronously, as
     *  before. The caller MUST call `clearPrimedCharacterParts3D(meshId)` when done (createFullCharacter3D does). */
    async createProceduralCharacter3D(
        spec: { body?: Partial<import('./body-generator').BodyParams>; garments?: import('./clothing-generator').ClothingParams[]; hair?: import('./hair-generator').HairParams | null },
        ox = 0, oy = 0, oz = 0,
        opts?: { sceneScale?: boolean },
    ): Promise<{ meshId: string; skeletonId: string }> {
        const { NEW_BODY_DEFAULTS } = await import('./body-generator');
        const params = { ...NEW_BODY_DEFAULTS, ...(spec.body ?? {}) };
        const partsSpec = { body: params, garments: spec.garments ?? [], hair: spec.hair ?? null };
        let parts: import('./character-parts').CharacterParts | null = null;
        try { parts = await generateCharacterPartsAsync(partsSpec); } catch { parts = null; }
        const r = await this._commitProceduralBody(params, parts?.body ?? generateBodyResult(params), ox, oy, oz, opts?.sceneScale !== false);
        if (parts) this._character.primeGeneratedParts(r.meshId, parts);
        return r;
    }
    /** Drop any worker-precomputed garment/hair geometry still primed for a body (see createProceduralCharacter3D). */
    clearPrimedCharacterParts3D(bodyMeshId: string): void { this._character.clearPrimedParts(bodyMeshId); }

    /** Character v2 (src/character-v2, docs/specs/character-v2.md): a rigged SkinnedMesh3D + Skeleton3D from a skinned
     *  result, added at the scene root — the createProceduralBody3D construction path WITHOUT the v1 body registration
     *  (no isProceduralBody, no Scene3DCharacter params), so no v1 code path adopts the v2 body. */
    async createRiggedFromResult3D(
        result: import('../../renderer/3d/gltf-importer').GltfSkinnedResult, ox: number, oy: number, oz: number, name = 'Character',
        opts?: { meshId?: string; skeleton?: Skeleton3D },
    ): Promise<{ mesh: SkinnedMesh3D; skeleton: Skeleton3D }> {
        // Character v2 review fix runtime#1 (stable ids): the caller may hand a ready skeleton (its id already set — a
        // restored save keeps its skeleton id) and the mesh id to use; both are applied BEFORE the nodes enter the scene,
        // so the id registry / picker / renderer caches never see a throwaway id. A taken mesh id falls back to a fresh one.
        const skeleton = opts?.skeleton ?? await this._createSkeletonFromResult(result);
        if (opts?.skeleton) this.ctx.sceneGraph.root.addChild(skeleton);
        const def: CharacterDefinition = { id: 'rig_' + Date.now().toString(36), name, slots: { base_body: 'procedural' } };
        const mesh = await this._createSkinnedMeshForSlot(result, skeleton, ox, oy, oz, def, 'base_body');
        if (opts?.meshId && !this.ctx.sceneGraph.findNodeById(opts.meshId)) mesh.setId(opts.meshId);
        this.ctx.sceneGraph.root.addChild(mesh);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return { mesh, skeleton };
    }
    /** Remove a rig made by createRiggedFromResult3D (mesh + skeleton; caches evicted; no undo step). Its per-body
     *  runtime state goes with it (review fix runtime#7): the idle (its live-render hold), the Play avatar binding, the
     *  skeleton-sync / spring / NLA trackers. */
    removeRigged3D(mesh: SkinnedMesh3D, skeleton: Skeleton3D): void {
        this._dropRiggedRuntimeState(mesh, skeleton, true);
        mesh.parent?.removeChild(mesh);
        skeleton.parent?.removeChild(skeleton);
        this._picker.evictMesh(mesh.id);
        this.renderer3D.evictMeshCaches([mesh.id]);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }
    /** Detach a rig made by createRiggedFromResult3D WITHOUT disposing it (an undoable delete): its idle stops (the
     *  live-render hold released), it stops being the running Play avatar, its GPU / picker caches are evicted (rebuilt
     *  on re-attach). The persisted Player binding id is kept, so an undo brings the binding back. */
    detachRigged3D(mesh: SkinnedMesh3D, skeleton: Skeleton3D): { wasIdle: boolean } {
        const r = this._dropRiggedRuntimeState(mesh, skeleton, false);
        mesh.parent?.removeChild(mesh);
        skeleton.parent?.removeChild(skeleton);
        this._picker.evictMesh(mesh.id);
        this.renderer3D.evictMeshCaches([mesh.id]);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return r;
    }
    /** Re-attach a rig detached by detachRigged3D (the skeleton at the root, the mesh under `parent`, default the root). */
    attachRigged3D(mesh: SkinnedMesh3D, skeleton: Skeleton3D, parent?: import('../../scene-graph/shapes/base/node').Node | null, opts?: { idle?: boolean }): void {
        if (!skeleton.parent) this.ctx.sceneGraph.root.addChild(skeleton);
        if (!mesh.parent) (parent ?? this.ctx.sceneGraph.root).addChild(mesh);
        mesh.gpuDirty = true; mesh.skinDirty = true;
        skeleton.objectTransform.set(mesh.localMatrix as unknown as Float32Array);
        skeleton.computeWorldMatrices();
        if (opts?.idle) this.setIdleAnimation(mesh.id, true);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
    }
    /** The per-body runtime state of a rig leaving the scene. MUST run while the mesh is still attached (the idle
     *  teardown resolves the body by id). `forget` = a permanent removal (drop the trackers + a persisted Player binding). */
    private _dropRiggedRuntimeState(mesh: SkinnedMesh3D, skeleton: Skeleton3D, forget: boolean): { wasIdle: boolean } {
        const wasIdle = this.isIdleAnimating(mesh.id);
        if (wasIdle) this.setIdleAnimation(mesh.id, false);   // releases the idle's live-loop hold + interactive count
        if (this._playing && this._playerMesh === mesh) {
            const keep = this._playerMeshId;
            this.setPlayerObject3D(null);                       // the loco rig released; the auto player takes over
            if (!forget) this._playerMeshId = keep;
        } else if (forget && this._playerMeshId === mesh.id) this._playerMeshId = null;
        if (forget) {
            this._charSkelSyncVer.delete(mesh.id);
            this._playArmClearanceCache.delete(mesh.id);
            for (const m of [this._animation.squashStretch, this._animation.idleBreaks, this._animation.legIdleModes] as Map<string, unknown>[]) m.delete(mesh.id);
            this._springActiveUntil.delete(skeleton.id);
            this._animation.nlaBindPoses.delete(skeleton.id);
        }
        return { wasIdle };
    }

    // ── Character providers (Character v2 review fixes runtime#3/#4/#5) ──────────────────────────────────────────────
    // A character system living OUTSIDE the engine (src/character-v2) registers here so the engine's generic mesh paths
    // treat its characters as characters without knowing about it: the outliner delete / Ctrl+D route to its own
    // whole-character operations, and its internal nodes (the v2 save marker) stay out of the outliner.
    private readonly _characterProviders: Array<{ owns(id: string): boolean; hidden?(id: string): boolean; delete?(id: string): boolean; duplicate?(id: string): boolean }> = [];
    /** Register a character provider; returns the unregister function. */
    registerCharacterProvider3D(p: { owns(id: string): boolean; hidden?(id: string): boolean; delete?(id: string): boolean; duplicate?(id: string): boolean }): () => void {
        this._characterProviders.push(p);
        return () => { const i = this._characterProviders.indexOf(p); if (i >= 0) this._characterProviders.splice(i, 1); };
    }
    private _providerOf(id: string): { owns(id: string): boolean; hidden?(id: string): boolean; delete?(id: string): boolean; duplicate?(id: string): boolean } | null {
        for (const p of this._characterProviders) if (p.owns(id)) return p;
        return null;
    }
    /** "Is this a character BODY" for the character-level features (outline, scale, Play gait seed, arm clearance): a
     *  v1 procedural body OR a Character v2 body (a runtime-only `characterKind = 'v2'` its manager sets — never saved).
     *  The v1-PARAMS paths (setBodyParams, overlay fits, the bodyParams save) keep keying on isProceduralBody. */
    private _isCharacterBody(m: unknown): boolean {
        return m instanceof SkinnedMesh3D && (m.isProceduralBody || (m as { characterKind?: string }).characterKind === 'v2');
    }
    /** Public form of the character-body predicate (v1 procedural body OR Character v2 body) for hosts (e.g. hiding
     *  "Bind Mesh", outliner character grouping). isProceduralBody3D keeps meaning "has v1 bodyParams". */
    isCharacterBody3D(meshId: string): boolean { return this._isCharacterBody(this.getMesh(meshId)); }
    isCharacterBodySkeleton3D(skeletonId: string): boolean {
        const s = this.getSkeleton(skeletonId);
        return !!s && (s.isProceduralBody || (s as { characterKind?: string }).characterKind === 'v2');
    }
    /** Give a NEW character the characters-only outline when it is on (what v1's commit path does). */
    applyCharacterOutline3D(meshId: string): boolean {
        return this._charOutlines ? this.setMeshOutline3D(meshId, this._charOutlines) : false;
    }
    /** Restore a persisted outline (+ rings) onto a mesh exactly (the mesh + the renderer's draw cache). */
    restoreMeshOutline3D(meshId: string, state: { outline?: HighlightStyle | null; outlineRings?: HighlightStyle[] | null }): boolean {
        const m = this.getMesh(meshId);
        if (!m) return false;
        this._restoreOutline(m, state);
        this.ctx.scheduleRender();
        return true;
    }
    /** A character's REST changed (Character v2 sliders: joint offsets) while Play may be running. When it is the bound
     *  Play avatar: the rest pose Stop restores gets the same per-joint rest shift (`restDelta`, 3 floats per joint —
     *  else Stop put the OLD bone lengths back over the NEW inverse binds), then the avatar is re-bound in place
     *  (re-measured, camera re-framed, controller re-seated on its feet, the default gait rebuilt for the new legs).
     *  No-op outside Play or for any other mesh. */
    refreshPlayerAvatar3D(meshId: string, restDelta?: ArrayLike<number>): boolean {
        if (!this._playing || this._playerMesh?.id !== meshId) return false;
        const r = this._locoRest;
        if (r && restDelta) {
            const sk = this.getSkeleton(r.skelId);
            if (sk && sk.id === this._playerSkeletonId()) {
                const P = r.pose.positions;
                for (let i = 0; i < P.length && i * 3 + 2 < restDelta.length; i++) {
                    P[i] = [P[i][0] + restDelta[i * 3], P[i][1] + restDelta[i * 3 + 1], P[i][2] + restDelta[i * 3 + 2]];
                }
            }
        }
        this.setPlayerObject3D(meshId);
        return true;
    }

    private async _commitProceduralBody(
        params: Partial<import('./body-generator').BodyParams>,
        result: ReturnType<typeof generateBodyResult>,
        ox: number, oy: number, oz: number,
        sceneScale = true,
    ): Promise<{ meshId: string; skeletonId: string }> {
        const { DEFAULT_BODY_PARAMS } = await import('./body-generator');
        const skeleton = await this._createSkeletonFromResult(result);
        // NEW bodies skin with dual quaternions (volume-preserving joints — audit C1 Phase 3). Per skeleton, so this
        // body's clothes/hair/charms (same skeleton) deform identically. Saved skeletons keep what they had ('linear').
        skeleton.skinningMethod = 'dualQuat';
        const def: CharacterDefinition = {
            id: 'proc_' + Date.now().toString(36),
            name: 'ProcBody',
            slots: { base_body: 'procedural' },
        };
        this.clearProceduralBodyPreview(); // committing — drop any live ghost
        const mesh = await this._createSkinnedMeshForSlot(result, skeleton, ox, oy, oz, def, 'base_body');
        mesh.material.doubleSided = true; // PROTOTYPE: visible regardless of tube winding
        mesh.material.metalness = 0; mesh.material.roughness = 0.72;   // SKIN: soft + matte; the env-specular grazing sheen reads as the skin highlight (vs the plasticky default 0.5)
        mesh.material.softLighting = true;   // flat anime skin: wrapped/half-Lambert diffuse (amount = global setSoftLightingStrength3D) so a face's 3-D form doesn't cut a hard "dark triangle"
        // Tag both so the armature panel can hide "Bind Mesh" — the body is already rigged with the
        // generator's tube weights; re-binding would clobber them with distance-based auto-weights.
        mesh.isProceduralBody = true;
        mesh.transformViaSkeleton = true;   // object transform lives on the skeleton (gizmo moves the whole character)
        skeleton.isProceduralBody = true;
        // Scene scale: in a city a new character is generated at REAL human size (see _applySceneCharacterScale).
        // Before the IK pole targets below, which are placed from the (now scaled) joint world positions.
        if (sceneScale) this._applySceneCharacterScale(mesh);

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
        if (this._charOutlines) this.setMeshOutline3D(mesh.id, this._charOutlines);   // E3: new characters pick up the characters-only outline
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return { meshId: mesh.id, skeletonId: skeleton.id };
    }

    /** Metres per world unit of the scene when it has a real-world scale (a city: cityMetresPerUnit), else null. The
     *  same provider Play uses (setPlayMetresPerUnitProvider). */
    getSceneMetresPerUnit3D(): number | null { return this._playMetreScale(); }

    /** In a scene with a metre scale (a city, ~15 m per unit) a NEW procedural character is scaled UNIFORMLY on its body
     *  transform so it stands AUTO_PLAYER_HEIGHT_M (1.7 m) tall, whatever its height slider (the generator builds ~0.75–
     *  1.7 units, i.e. a 10–25 m giant in a city). The skeleton follows the body transform (transformViaSkeleton) and
     *  every overlay (face decal, hair, garments, charms, spring bones) rides that skeleton in body space, so all of it
     *  scales together, and regenerating a part later keeps the scale (the parts are rebuilt in body space). The scale
     *  is an ordinary node scale: it persists, and the gizmo can still change it. Returns the factor (1 = unchanged). */
    /** The uniform factor that makes a character `H` world units tall stand AUTO_PLAYER_HEIGHT_M at `mpu` metres per
     *  unit (1 = leave it). Shared by the committed body (_applySceneCharacterScale) and the live ghost preview, so
     *  preview == result. */
    private _sceneCharacterScaleFactor(H: number, mpu: number | null): number {
        if (mpu === null || !(H > 0) || !Number.isFinite(H)) return 1;
        const k = (AUTO_PLAYER_HEIGHT_M / mpu) / H;
        return !Number.isFinite(k) || k <= 0 || Math.abs(k - 1) < 1e-9 ? 1 : k;
    }

    private _applySceneCharacterScale(mesh: SkinnedMesh3D): number {
        const mpu = this._playMetreScale();
        if (mpu === null) return 1;
        const c = mesh.obbCorners;
        if (!c || c.length === 0) return 1;
        let lo = Infinity, hi = -Infinity;
        for (const p of c) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
        const k = this._sceneCharacterScaleFactor(hi - lo, mpu);
        if (k === 1) return 1;
        const spawnY = mesh.y;
        mesh.setScale3D(mesh.scaleX * k, mesh.scaleY * k, mesh.scaleZ * k);
        // Character scale (2026-10-04): stand the SOLES on the spawn floor point. The origin sits at the hips with the legs
        // below it, so placing the origin on the floor buried the feet ~0.37 m into the street (Play hid it: the
        // controller measures the feet).
        if (Scene3DManager.citySpawnFeetOnFloor) {
            const soles = this._meshWorldMinY(mesh);
            if (soles !== null && Math.abs(spawnY - soles) > 1e-9) mesh.setPosition3D(mesh.x, mesh.y + (spawnY - soles), mesh.z);
        }
        // Sync the skeleton now (the per-frame _syncCharacterSkeletons would do it next frame) so anything measuring
        // joints right after creation (spawn reveal, face framing, overlay fits) sees the final transform.
        if (mesh.skeleton) { mesh.skeleton.objectTransform.set(mesh.localMatrix as unknown as Float32Array); mesh.skeleton.computeWorldMatrices(); }
        return k;
    }

    // ── Character scale (2026-10-04; docs/ui/character-creator.md "Scaling a character") ─────────────────────────────
    // ONE uniform node scale on the procedural body: the body transform drives the skeleton (transformViaSkeleton) and
    // every overlay (clothes, hair, face kit, eyes, charms, spring bones) is skinned to it, so the whole character scales
    // with no regeneration, and the scale is saved with the body node. The body's origin sits at its hips, so every path
    // keeps the SOLES at the same world height. Play re-measures it (camera framing, eye height, capsule, stride).

    /** World height of a mesh's rest geometry with FRESH bounds (a character body: its standing height); 0 = unknown. */
    private _meshStandingHeight(m: Mesh3D): number {
        m.calculateBoundingBox();
        const c = m.obbCorners;
        if (!c || c.length === 0) return 0;
        let lo = Infinity, hi = -Infinity;
        for (const p of c) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
        return hi > lo && Number.isFinite(hi - lo) ? hi - lo : 0;
    }
    /** Lowest world Y of a mesh's rest geometry (a character's soles), fresh; null = unknown. */
    private _meshWorldMinY(m: Mesh3D): number | null {
        m.calculateBoundingBox();
        const c = m.obbCorners;
        if (!c || c.length === 0) return null;
        let lo = Infinity;
        for (const p of c) if (p[1] < lo) lo = p[1];
        return Number.isFinite(lo) ? lo : null;
    }
    private readonly _restMinYCache = new WeakMap<object, number | null>();
    /** Lowest MESH-space Y of a body's rest geometry (the soles), cached per vertex buffer. */
    private _restMinY(m: Mesh3D): number | null {
        const v = m.geometry?.vertices;
        if (!v || v.length === 0) return null;
        const hit = this._restMinYCache.get(v);
        if (hit !== undefined) return hit;
        const lo = geometryMinY(v, FLOATS_PER_VERT);
        this._restMinYCache.set(v, lo);
        return lo;
    }
    /** A procedural character body (the Character group's node) by id, else null. */
    private _characterBody(id: string): SkinnedMesh3D | null {
        const m = this.getMesh(id);
        return m instanceof SkinnedMesh3D && this._isCharacterBody(m) ? m : null;   // v1 or v2 (review fix runtime#2/#5)
    }
    /** After a body's size changed: skeleton now (not next frame — joints / overlays / measurements see it), save-dirty,
     *  render, and — when it is the running Play avatar — re-measure + re-frame it (camera, eye height, capsule). */
    private _afterCharacterResize(m: SkinnedMesh3D): void {
        if (m.skeleton) { m.skeleton.objectTransform.set(m.localMatrix as unknown as Float32Array); m.skeleton.computeWorldMatrices(); }
        m.stateDirty = true;
        // Springs restart from the new rest pose (their world-space tips held the OLD size: a resize yanked the hair tails
        // up toward where they used to hang).
        if (m.skeleton) resetSpringState(m.skeleton);
        const cc = this._playController;
        if (this._playing && cc && this._playerMesh === m) {
            this._measureBoundAvatar(m);
            this._applyAvatarCameraFraming(cc, this._explicitPlayConfig());
            this._drivePlayerMesh(cc);
            if (m.skeleton) { m.skeleton.objectTransform.set(m.localMatrix as unknown as Float32Array); m.skeleton.computeWorldMatrices(); }
            this._tpCam.reset();
        }
        this.renderer3D.markTransformsDirty();
        this.ctx.scheduleRender();
    }

    /** A character's size: `scale` = the body's uniform node scale (1 = the generated size), `height` = its standing
     *  height in world units (rest pose, body only — hair can add a little), `heightMetres` = that in metres (the scene's
     *  metres per unit: a city's scale, else 1 unit = 1 m), `restHeight` = the height at scale 1 (what the height PARAM
     *  gives). null = not a procedural character body. */
    getCharacterScale3D(bodyMeshId: string): { scale: number; height: number; heightMetres: number; restHeight: number; metresPerUnit: number; sceneMetresPerUnit: number | null } | null {
        const m = this._characterBody(bodyMeshId);
        if (!m) return null;
        const h = this._meshStandingHeight(m), mpu = this.getPlayMetresPerUnit3D(), s = Math.abs(m.scaleY) || 1;
        return { scale: Math.abs(m.scaleY), height: h, heightMetres: h * mpu, restHeight: h / s, metresPerUnit: mpu, sceneMetresPerUnit: this._playMetreScale() };
    }

    /** Scale a whole character UNIFORMLY (body + skeleton + every overlay) to `scale` × its generated size, FEET kept on
     *  the ground. Clamped to [0.01, 1000]; keeps any authored axis ratio. Undoable (one step) unless `opts.undo` is
     *  false; live in Play (the camera / capsule / stride follow) and kept after Stop. Returns false for a non-character. */
    setCharacterScale3D(bodyMeshId: string, scale: number, opts?: { undo?: boolean }): boolean {
        const m = this._characterBody(bodyMeshId);
        const s = clampCharacterScale(scale);
        if (!m || s === null) return false;
        const f = s / (Math.abs(m.scaleY) || 1);
        if (!Number.isFinite(f) || Math.abs(f - 1) < 1e-12) return true;
        type Xf = { x: number; y: number; z: number; sx: number; sy: number; sz: number };
        const before: Xf = { x: m.x, y: m.y, z: m.z, sx: m.scaleX, sy: m.scaleY, sz: m.scaleZ };
        const lo = this._restMinY(m);
        const y = lo !== null ? feetAnchoredY(m.y, m.scaleY, m.scaleY * f, lo) : m.y;
        m.setScale3D(m.scaleX * f, m.scaleY * f, m.scaleZ * f);
        m.setPosition3D(m.x, y, m.z);
        // Mid-Play: Stop restores the pre-Play transforms — carry the new size (feet kept) into that snapshot so it sticks.
        const snap = this._playing ? this._prePlayXforms : null;
        const i = snap ? snap.meshes.indexOf(m) : -1;
        if (snap && i >= 0) {
            const o = i * 9, sy0 = snap.trs[o + 7];
            if (lo !== null) snap.trs[o + 1] = feetAnchoredY(snap.trs[o + 1], sy0, sy0 * f, lo);
            snap.trs[o + 6] *= f; snap.trs[o + 7] *= f; snap.trs[o + 8] *= f;
        }
        const after: Xf = { x: m.x, y: m.y, z: m.z, sx: m.scaleX, sy: m.scaleY, sz: m.scaleZ };
        this._afterCharacterResize(m);
        if (opts?.undo !== false) {
            const apply = (t: Xf) => {
                const b = this._characterBody(bodyMeshId);
                if (!b) return;
                b.setScale3D(t.sx, t.sy, t.sz); b.setPosition3D(t.x, t.y, t.z);
                this._afterCharacterResize(b);
            };
            this._undoManager.push({ description: 'Scale character', undo: () => apply(before), redo: () => apply(after) });
        }
        return true;
    }

    /** Scale a character so it stands `height` tall — in METRES by default (the scene's metres per unit: a city's scale,
     *  else 1 unit = 1 m), or in world units with `unit: 'units'`. Feet kept; undoable. Returns the new scale, or null. */
    setCharacterHeight3D(bodyMeshId: string, height: number, unit: 'metres' | 'units' = 'metres'): number | null {
        const m = this._characterBody(bodyMeshId);
        if (!m || !(height > 0) || !Number.isFinite(height)) return null;
        const target = unit === 'units' ? height : height / this.getPlayMetresPerUnit3D();
        const k = scaleFactorForHeight(this._meshStandingHeight(m), target);
        if (!this.setCharacterScale3D(bodyMeshId, Math.abs(m.scaleY) * k)) return null;
        return Math.abs(m.scaleY);
    }

    /** "Fit to city": scale a character to real human size in the scene — `metres` (default 1.7 m, what new characters
     *  get in a city) at the scene's metres per unit (getSceneMetresPerUnit3D; 1 outside a city). Returns the scale. */
    fitCharacterToScene3D(bodyMeshId: string, metres: number = AUTO_PLAYER_HEIGHT_M): number | null {
        return this.setCharacterHeight3D(bodyMeshId, metres, 'metres');
    }

    /** Where a NEW character should stand. Outside a city: `position` (default the origin), unchanged. In a city, a
     *  missing position, the origin, or the 2D illustration centre (what hosts pass by default — it means nothing in a
     *  free-3D city, and is usually far from the streets on screen) is treated as "put it where I'm looking": the first
     *  floor-like surface along the camera's view ray, else the ground under the camera target. Any other explicit
     *  position is honoured. */
    resolveCharacterSpawn3D(position?: readonly [number, number, number] | null): [number, number, number] {
        const given: [number, number, number] = position ? [position[0], position[1], position[2]] : [0, 0, 0];
        const mpu = this._playMetreScale();
        if (mpu === null) return given;
        const ic = this.getIllustrationCenter3D();
        const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
        const hint = !position || same(given, [0, 0, 0]) || (!!ic && same(given, ic));
        if (!hint) return given;
        return this._cameraFocusGround(mpu) ?? given;
    }

    /** The floor point the camera is looking at (city spawn): view ray → first up/down-facing hit; else a down ray at the
     *  camera target from 3 m above it. Characters are never spawn surfaces. Broadphase by world AABB so a city cast
     *  only builds BVHs for the few meshes the ray actually crosses. */
    private _cameraFocusGround(mpu: number): [number, number, number] | null {
        const cam = this.renderer3D.getCamera();
        const o = cam.position, t = cam.target;
        // Never a character, and never far decoration (frameExclude: the sky clouds, void grid, nature apron).
        const skip = (m: Mesh3D) => m.frameExclude || m instanceof SkinnedMesh3D || m.isHair || m.isClothing || m.isFaceDecal || m.isAttachment || this.autoPlayer.isRuntimeNode(m.id);
        const boxes: { m: Mesh3D; b: [number, number, number, number, number, number] }[] = [];
        for (const m of this.getAllMeshes()) {
            if (!m.visible || skip(m)) continue;
            const c = m.obbCorners;
            if (!c || c.length === 0) continue;
            const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
            for (const p of c) { for (let i = 0; i < 3; i++) { if (p[i] < b[i]) b[i] = p[i]; if (p[i] > b[i + 3]) b[i + 3] = p[i]; } }
            boxes.push({ m, b });
        }
        const cast = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) => {
            const cands = boxes.filter(({ b }) => _rayAABBIntersect(ox, oy, oz, dx, dy, dz, b[0], b[1], b[2], b[3], b[4], b[5]) !== null).map((e) => e.m);
            return cands.length ? this._picker.raycastWorld([ox, oy, oz] as unknown as vec3, [dx, dy, dz] as unknown as vec3, cands, true) : null;
        };
        const dx = t[0] - o[0], dy = t[1] - o[1], dz = t[2] - o[2];
        const len = Math.hypot(dx, dy, dz);
        const u = 1 / mpu;   // one metre in world units
        if (len > 1e-9) {
            const ux = dx / len, uy = dy / len, uz = dz / len;
            const hit = cast(o[0], o[1], o[2], ux, uy, uz);
            if (hit && Math.abs(hit.faceNormal[1]) > 0.6) return [hit.hitPoint[0], hit.hitPoint[1], hit.hitPoint[2]];
            if (hit) {
                // A wall (a facade seen from the street): stand on the floor just IN FRONT of it, on the camera's side.
                const px = hit.hitPoint[0] - ux * 0.6 * u, py = hit.hitPoint[1] - uy * 0.6 * u, pz = hit.hitPoint[2] - uz * 0.6 * u;
                const floor = cast(px, py + 0.5 * u, pz, 0, -1, 0);
                if (floor) return [px, floor.hitPoint[1], pz];
            }
        }
        const down = cast(t[0], t[1] + 3 * u, t[2], 0, -1, 0);
        if (down) return [t[0], down.hitPoint[1], t[2]];
        return Number.isFinite(t[0]) && Number.isFinite(t[1]) && Number.isFinite(t[2]) ? [t[0], t[1], t[2]] : null;
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
        // Character scale (2026-10-04): the soles before the swap — the generator roots the rig at the hips, so a height /
        // leg-length change grew the legs about that point and the character sank into / floated above its floor.
        const feet0 = Scene3DManager.bodyEditKeepsFeet ? this._meshWorldMinY(body) : null;
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
        // …keep them there (the body is lifted / lowered by the change), with fresh bounds for the selection box and Play.
        const feet1 = feet0 !== null ? this._meshWorldMinY(body) : null;
        if (feet0 !== null && feet1 !== null && Math.abs(feet1 - feet0) > 1e-9) body.setPosition3D(body.x, body.y + (feet0 - feet1), body.z);
        else body.calculateBoundingBox();
        this._afterCharacterResize(body);
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
            this.clearArmsForSkeleton(body.skeleton);   // a heavier body may now swallow the arms
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
                    if (body.skeleton) this.clearArmsForSkeleton(body.skeleton);   // a heavier body may now swallow the arms
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
    /** Face kit (face-features.ts) — the character subsystem, forwarded directly (A1). */
    get faceKit(): Pick<Scene3DCharacter, 'setFaceFeatures' | 'getFaceFeatures' | 'setCharacterExpression' | 'getCharacterExpression' | 'pulseBrows' | 'getFaceKitMeshIds'> { return this._character; }
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
    serializeAttachments(): { id: string; bodyMeshId: string; placement: AttachmentPlacement; params: AttachmentParams }[] { return this._character.serializeAttachments(); }
    restoreAttachments(states: { id: string; bodyMeshId: string; placement: AttachmentPlacement; params: AttachmentParams }[] | undefined): void { this._character.restoreAttachments(states); }

    removeClothing(bodyMeshId: string, slot: 'top' | 'bottom' | 'shoes' | 'socks' | 'undershirt' | 'underpants'): void { this._character.removeClothing(bodyMeshId, slot); }
    /** Clothing fit round 2: the body-hiding mask + the skirt hem swing (Scene3DCharacter). */
    getHideBodyUnderClothes(bodyMeshId: string): boolean { return this._character.getHideBodyUnderClothes(bodyMeshId); }
    setHideBodyUnderClothes(bodyMeshId: string, on: boolean): void { this._character.setHideBodyUnderClothes(bodyMeshId, on); }
    getSkirtSwing(bodyMeshId: string): number | null { return this._character.getSkirtSwing(bodyMeshId); }
    setSkirtSwing(bodyMeshId: string, amount: number): void { this._character.setSkirtSwing(bodyMeshId, amount); }
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
        return this._kitbash.registerBakedPart('part_' + _nanoid(), bakeSlot, name || (slot.charAt(0).toUpperCase() + slot.slice(1)), result.blob);
    }

    /** Baked-part metadata for the document (the GLB bytes ride separately via getBakedPartBuffers). */
    serializeBakedParts(): KitbashPartMeta[] { return this._kitbash.serializeBakedParts(); }
    /** Baked-part GLB bytes keyed by part id (written into the document package like models3d). */
    async getBakedPartBuffers(): Promise<Record<string, ArrayBuffer>> { return this._kitbash.getBakedPartBuffers(); }
    /** Re-register baked parts on load from the persisted metadata + bytes. */
    restoreBakedParts(metas: KitbashPartMeta[] | undefined, buffers: Record<string, ArrayBuffer> | undefined): void {
        this._kitbash.restoreBakedParts(metas, buffers);
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
        return this._kitbash.registerBakedPart('part_' + _nanoid(), 'hair', name || 'Hair', result.blob);
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
        const { generateBodyResult, BODY_POSES, NEW_BODY_DEFAULTS } = await import('./body-generator');
        // Same params the commit uses (createProceduralBody3D / createProceduralCharacter3D add the new-body defaults).
        const result = generateBodyResult({ ...NEW_BODY_DEFAULTS, ...(params ?? {}) });
        const geom = result.geometry, skin = result.skinning;
        // SCENE SCALE (preview == result): the committed body is scaled so it stands 1.7 m in a city
        // (_applySceneCharacterScale, measured on the rest geometry under result.scale). Same factor here, from the same
        // rest-geometry height; O(verts) once per slider change. 1 outside a city.
        let yLo = Infinity, yHi = -Infinity;
        for (let v = 1; v < geom.vertices.length; v += 12) { const y = geom.vertices[v]; if (y < yLo) yLo = y; if (y > yHi) yHi = y; }
        const baseScale: [number, number, number] = [result.scale[0], result.scale[1], result.scale[2]];
        const k = this._sceneCharacterScaleFactor((yHi - yLo) * Math.abs(baseScale[1]), this._playMetreScale());
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
        for (const name of IDLE_JOINTS) { const j = byName.get(name); if (j) base.set(name, [...j.localRotation] as [number, number, number, number]); }
        this._ghostIdle = {
            skel, base, indices: geom.indices, ji: skin.jointIndices, jw: skin.jointWeights,
            rest: new Float32Array(geom.vertices), out: new Float32Array(geom.vertices.length),
            t0: this._ghostIdle?.t0 ?? performance.now(),   // preserve phase across live slider rebuilds
            scale: [baseScale[0] * k, baseScale[1] * k, baseScale[2] * k],
            // In a city the committed body stands its SOLES on the floor point (_applySceneCharacterScale) — same lift here.
            offset: [result.position[0], result.position[1] + (k !== 1 && Scene3DManager.citySpawnFeetOnFloor && Number.isFinite(yLo) ? -yLo * baseScale[1] * k : 0), result.position[2]],
        };
        this._ensureGhostIdleCallback();
        if (!this._ghostHeldLive && !this.ctx.webgpuRenderer.isLive) { this.ctx.webgpuRenderer.play(); this._ghostHeldLive = true; }
        this._tickGhostIdle();   // skin one frame now so it shows immediately
        this.ctx.scheduleRender();
    }

    /** Hide the procedural-body ghost preview. */
    clearProceduralBodyPreview(): void {
        this._ghostIdle = null;
        this._ghostSpawn = null;
        if (this._ghostHeldLive) { this.ctx.webgpuRenderer.pause(); this._ghostHeldLive = false; }
        this.renderer3D.setGhostPreviewData(null);
        this.ctx.scheduleRender();
    }

    // ── Animated ghost (the preview breathes/sways in the Relaxed stance instead of a static T-pose) ──
    private _ghostIdle: { skel: Skeleton3D; base: Map<string, [number, number, number, number]>; rest: Float32Array; out: Float32Array; indices: Uint32Array; ji: Uint8Array; jw: Float32Array; t0: number; scale: [number, number, number]; offset: [number, number, number] } | null = null;
    /** City preview placement cache: where a committed character would spawn for the camera pose `key` (the view-ray
     *  floor cast of resolveCharacterSpawn3D). Re-cast only when the camera moved, at most every GHOST_SPAWN_RECAST_MS,
     *  so neither slider drags nor the per-frame idle tick pay a city raycast each time. */
    private _ghostSpawn: { key: number[]; pos: [number, number, number]; at: number } | null = null;
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
        this.ctx.webgpuRenderer.addPreRenderCallback(this._ghostIdleCallback, 'ghostIdle');
    }

    /** Pose the throwaway skeleton (Relaxed + one idle frame), re-FK, CPU-skin the rest verts, push to the ghost. */
    private _tickGhostIdle(): void {
        const g = this._ghostIdle;
        if (!g) return;
        this._animation.applyIdle(g.skel, { intensity: 1, base: g.base, legMode: 'none' }, (performance.now() - g.t0) / 1000);   // preview: breathing only
        g.skel.computeWorldMatrices();
        this._skinGhostVerts(g.rest, g.ji, g.jw, g.skel.skinMatrices, g.out);
        const p = this._ghostPreviewOrigin();
        this.renderer3D.setGhostPreviewData({
            vertices: g.out, indices: g.indices,
            instances: [{ x: p[0] + g.offset[0], y: p[1] + g.offset[1], z: p[2] + g.offset[2], rx: 0, ry: 0, rz: 0, sx: g.scale[0], sy: g.scale[1], sz: g.scale[2] }], alpha: 0.55,
        });
    }

    /** Where the ghost's ORIGIN (feet) goes. Outside a city: the camera's look-at point (unchanged — the spawned
     *  character stands feet-at-origin and the look-at sits at origin too, so both read feet-at-centre). In a city:
     *  exactly where a default-positioned character would spawn (resolveCharacterSpawn3D: the floor the camera looks
     *  at), cached per camera pose and re-cast at most every GHOST_SPAWN_RECAST_MS while the camera moves. */
    private _ghostPreviewOrigin(): [number, number, number] {
        const cam = this.getCamera();
        const t = cam.target;
        if (this._playMetreScale() === null) { this._ghostSpawn = null; return [t[0], t[1], t[2]]; }
        const o = cam.position;
        const key = [o[0], o[1], o[2], t[0], t[1], t[2]];
        const c = this._ghostSpawn;
        const now = performance.now();
        if (c && (key.every((v, i) => v === c.key[i]) || now - c.at < GHOST_SPAWN_RECAST_MS)) return c.pos;
        const pos = this.resolveCharacterSpawn3D(null);
        this._ghostSpawn = { key, pos, at: now };
        return pos;
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

    /** Play a SPAWN SPIN on a just-created character (spins in + eases to face front). Runtime-only. */
    playSpawnSpin(bodyMeshId: string, opts?: { turns?: number; durationSec?: number }): void {
        this._kitbash.playSpawnSpin(bodyMeshId, opts);
    }

    /** Swap one slot on a live character (removes old mesh, loads + remaps + attaches the new part). */
    async swapCharacterSlot(charId: string, slot: CharacterSlot, partId: string): Promise<void> {
        return this._kitbash.swapCharacterSlot(charId, slot, partId);
    }

    /** Apply a diffuse color tint to one slot's mesh. */
    setCharacterSlotColor(charId: string, slot: CharacterSlot, r: number, g: number, b: number): void {
        this._kitbash.setCharacterSlotColor(charId, slot, r, g, b);
    }

    /** Remove a character and all its skeleton + part meshes from the scene. */
    removeCharacter(charId: string): void { this._kitbash.removeCharacter(charId); }

    /** Get the CharacterData for a given character ID, or null. */
    getCharacter(charId: string): CharacterData | null { return this._kitbash.getCharacter(charId); }

    /** Get all assembled characters in the scene. */
    getAllCharacters(): CharacterData[] { return this._kitbash.getAllCharacters(); }

    /** Serialize all assembled characters for project save. */
    getScene3DCharacterStates(): any[] { return this._kitbash.getScene3DCharacterStates(); }

    /** Restore character catalog entries (call AFTER meshes + skeletons are restored). */
    restoreCharacterStates(states: any[]): void { this._kitbash.restoreCharacterStates(states); }

    // ── Private character assembly helpers ────────────────────────────

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

    // ── Grease Pencil 3D (Phase C) ────────────────────────────────────

    /** Create a new GpObject3D in the scene and return its ID. */
    createGpObject(name = 'GP Object', skeletonId?: string): string {
        return this._gp.createObject(name, skeletonId);
    }

    /** Remove a GpObject3D from the scene (one 3D undo step puts it back with all its drawings). */
    removeGpObject(gpId: string): void {
        if (this._gpDrawGpId === gpId) this.exitGpDrawMode();
        const node = this._gp.removeObject(gpId);
        if (!node) return;
        this._undoManager.push({
            description: 'Delete Grease Pencil object',
            undo: () => this._gp.reattachObject(node),
            redo: () => { this._gp.removeObject(node.id); },
        });
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

    /** Remove a layer from a GpObject3D (one 3D undo step puts it back). */
    removeGpLayer(gpId: string, layerId: string): void {
        if (this._gpDrawGpId === gpId && this._gpDrawLayerId === layerId) this.exitGpDrawMode();
        const removed = this._gp.removeLayer(gpId, layerId);
        if (!removed) return;
        this._undoManager.push({
            description: 'Delete Grease Pencil layer',
            undo: () => this._gp.restoreLayer(gpId, removed.layer, removed.index),
            redo: () => { this._gp.removeLayer(gpId, layerId); },
        });
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

    /** Finalize the active GP stroke. Strokes with < 2 points are discarded. Returns whether the stroke was kept. */
    endGpStroke(): boolean {
        return this._gp.endStroke();
    }

    /** Abandon the active GP stroke (removed as if never drawn). */
    cancelGpStroke(): void {
        this._gp.cancelStroke();
    }

    /**
     * Erase GP strokes within `radius` world units of `worldPos` on a layer.
     * Pass `frame` to erase from a keyframe instead of base strokes.
     */
    eraseGpStrokes(gpId: string, layerId: string, worldPos: [number, number, number], radius: number, frame?: number): void {
        this._gp.eraseStrokes(gpId, layerId, worldPos, radius, frame);
    }

    /** Whether a GP layer has a keyframe at `frame`. */
    hasGpKeyframe(gpId: string, layerId: string, frame: number): boolean {
        return this._gp.hasKeyframe(gpId, layerId, frame);
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

        // The face is picked on a TAP — press + release within GP_FACE_TAP_SLOP_PX, one pointer, plain left / pen tip /
        // finger — never on the press: a drag that starts on the mesh (an orbit, a pinch's first finger, an Alt-orbit)
        // used to lock a plane where it began.
        let press: { id: number; x: number; y: number; multi: boolean } | null = null;
        const touchesDown = new Set<number>();
        const onDown = (e: PointerEvent) => {
            if (e.pointerType === 'touch') {
                touchesDown.add(e.pointerId);
                if (touchesDown.size > 1) { if (press) press.multi = true; return; }
            }
            if (e.button !== 0 || e.altKey || e.isPrimary === false) { press = null; return; }
            press = { id: e.pointerId, x: e.clientX, y: e.clientY, multi: false };
        };
        const onUp = (e: PointerEvent) => {
            if (e.pointerType === 'touch') touchesDown.delete(e.pointerId);
            const p = press;
            if (!p || p.id !== e.pointerId) return;
            press = null;
            if (p.multi || Math.hypot(e.clientX - p.x, e.clientY - p.y) > Scene3DManager.GP_FACE_TAP_SLOP_PX) return;
            this._lockGpPlaneAt(e.clientX, e.clientY, canvas.getBoundingClientRect());
        };
        const onCancel = (e: PointerEvent) => {
            if (e.pointerType === 'touch') touchesDown.delete(e.pointerId);
            if (press?.id === e.pointerId) press = null;
        };

        addZonelessListener(canvas, 'pointermove', onMove);
        addZonelessListener(canvas, 'pointerdown', onDown, { capture: true });
        addZonelessListener(canvas, 'pointerup', onUp, { capture: true });
        addZonelessListener(canvas, 'pointercancel', onCancel, { capture: true });
        this._gpFaceSelectCleanup = () => {
            removeZonelessListener(canvas, 'pointermove', onMove);
            removeZonelessListener(canvas, 'pointerdown', onDown, { capture: true });
            removeZonelessListener(canvas, 'pointerup', onUp, { capture: true });
            removeZonelessListener(canvas, 'pointercancel', onCancel, { capture: true });
        };
    }

    /** Movement (CSS px) under which a face-select press still counts as a tap. */
    static GP_FACE_TAP_SLOP_PX = 8;

    /** Face-select: lock the drawing plane on the mesh face under a client point (a miss clears it). */
    private _lockGpPlaneAt(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): void {
        const hit = this.pickFromClient3D(clientX, clientY, rect);
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
        if (this._gpDrawPlane && this._gpDrawPlacement === 'sheet') {
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
            placement?: 'surface' | 'sheet';
            surfaceOffset?: number;
            eraseMode?: 'partial' | 'stroke';
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
        // Finalise any open stroke (kept, with its undo step).
        this._gpGesture?.reset();
        this._gpGesture = null;
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
    enterSurfacePaintInput(meshId: string, handlers: SurfacePaintHandlers): void {
        this._surfacePaint.enter(meshId, handlers);
    }

    /** Exit 3D surface-paint input. */
    exitSurfacePaintInput(): void {
        this._surfacePaint.exit();
    }

    /** Multi-mesh variant of {@link enterSurfacePaintInput}: raycast a SET of meshes (the box's panels) and
     *  paint whichever is hit. The panel ids are resolved per-event so a hierarchy rebuild (setDimensions) is safe. */
    enterSurfacePaintInputMulti(meshIds: string[], handlers: SurfacePaintHandlers): void {
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
            removeZonelessListener(canvas, 'pointerdown', onDown, { capture: true });
            if (onMove) removeZonelessListener(canvas, 'pointermove', onMove, { capture: true });
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
            removeZonelessListener(canvas, 'pointerdown', onDown, { capture: true });
            if (onMove) removeZonelessListener(canvas, 'pointermove', onMove, { capture: true });
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
        placement?: 'surface' | 'sheet';
        surfaceOffset?: number;
        eraseMode?: 'partial' | 'stroke';
    }): void {
        this._applyGpDrawOpts(opts);
    }

    private static readonly _GP_DRAW_OPT_KEYS = new Set([
        'mode', 'color', 'baseWidth', 'fillColor', 'parentJoint',
        'closed', 'eraseRadius', 'depth', 'depthMode', 'placement', 'surfaceOffset', 'eraseMode',
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
        placement?: 'surface' | 'sheet';
        surfaceOffset?: number;
        eraseMode?: 'partial' | 'stroke';
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
        if (opts.surfaceOffset   !== undefined && Number.isFinite(opts.surfaceOffset)) this._gpSurfaceOffset = Math.max(0, opts.surfaceOffset);
        if (opts.eraseMode === 'partial' || opts.eraseMode === 'stroke') this._gpDrawEraseMode = opts.eraseMode;
        if ((opts.placement === 'surface' || opts.placement === 'sheet') && opts.placement !== this._gpDrawPlacement) {
            this._gpDrawPlacement = opts.placement;
            this._pushGpOverlay();                       // the flat sheet's tint shows only in Flat-sheet placement
            this.ctx.scheduleRender();
        }
    }

    /** The placement / eraser modes and the surface offset now in force (for UI and tests). */
    getGpDrawModes(): { placement: 'surface' | 'sheet'; eraseMode: 'partial' | 'stroke'; surfaceOffset: number } {
        return { placement: this._gpDrawPlacement, eraseMode: this._gpDrawEraseMode, surfaceOffset: this._gpSurfaceOffset };
    }

    /** The view ray through a client point (world origin + unit direction). */
    private _gpRayAt(clientX: number, clientY: number, canvas: HTMLCanvasElement): { origin: [number, number, number]; dir: [number, number, number] } {
        const rect = canvas.getBoundingClientRect();
        const sx = (clientX - rect.left) * (canvas.width  / (rect.width || 1));
        const sy = (clientY - rect.top)  * (canvas.height / (rect.height || 1));
        const camera = this.renderer3D.getCamera();
        const { origin, dir } = this._picker.castRay(sx, sy, canvas.width, canvas.height, camera);
        const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        return { origin: [origin[0], origin[1], origin[2]], dir: [dir[0] / len, dir[1] / len, dir[2] / len] };
    }

    /**
     * Where a client point draws: the cursor ray meets the locked drawing plane (face-select). Without a plane, a plane
     * facing the camera through its target (the orbit pivot) — never the old fixed mid-depth unproject, which in
     * perspective sits right at the near plane. Null when the ray misses (parallel to / pointing away from the plane).
     */
    private _gpDrawPointAt(clientX: number, clientY: number, canvas: HTMLCanvasElement): [number, number, number] | null {
        const { origin, dir } = this._gpRayAt(clientX, clientY, canvas);
        let point: ArrayLike<number>, normal: ArrayLike<number>;
        if (this._gpDrawPlane) {
            point = this._gpDrawPlane.point; normal = this._gpDrawPlane.normal;
        } else {
            const cam = this.renderer3D.getCamera();
            const t = cam.target, pos = cam.position;
            const fx = t[0] - pos[0], fy = t[1] - pos[1], fz = t[2] - pos[2];
            const fl = Math.hypot(fx, fy, fz) || 1;
            point = t; normal = [fx / fl, fy / fl, fz / fl];
        }
        const [nx, ny, nz] = [normal[0], normal[1], normal[2]];
        const denom = dir[0]*nx + dir[1]*ny + dir[2]*nz;
        if (Math.abs(denom) <= 1e-6) return null;
        const tHit = ((point[0] - origin[0])*nx + (point[1] - origin[1])*ny + (point[2] - origin[2])*nz) / denom;
        if (!(tHit > 0)) return null;
        return [origin[0] + dir[0] * tHit, origin[1] + dir[1] * tHit, origin[2] + dir[2] * tHit];
    }

    /**
     * Surface placement: the raycast a stroke starting at this client point uses — against the SELECTED mesh(es) (the
     * pencil opens on a selected mesh; no face tap needed), or, with nothing selected, the mesh under the press (that
     * one mesh for the whole stroke). Null when there is no target under the press.
     */
    private _gpSurfaceRaycast(clientX: number, clientY: number, canvas: HTMLCanvasElement): ((x: number, y: number) => GpSurfaceHit | null) | null {
        let targets: Mesh3D[] = [];
        for (const id of this.renderer3D.getSelectedMeshIds()) {
            const m = this.getMesh(id);
            if (m && m.visible) targets.push(m);
        }
        if (targets.length === 0) {
            const { origin, dir } = this._gpRayAt(clientX, clientY, canvas);
            const hit = this._picker.raycastWorld(origin as unknown as vec3, dir as unknown as vec3, this.getAllMeshes(), false);
            if (!hit) return null;
            targets = [hit.mesh];
        }
        return (x, y) => {
            const { origin, dir } = this._gpRayAt(x, y, canvas);
            const hit = this._picker.raycastWorld(origin as unknown as vec3, dir as unknown as vec3, targets, true);
            return hit ? { point: hit.hitPoint, normal: hit.faceNormal, rayDir: dir } : null;
        };
    }

    /** The animation timeline's frame — the one the GP pass shows (and a stroke on a keyframed layer edits). */
    private _gpCurrentFrame(): number {
        return this.ctx.rasterLayerManager?.getTimeline?.()?.getCurrentFrame?.() ?? 0;
    }

    private _setupGpDrawListeners(): void {
        this._gpDrawListenerCleanup?.();
        const canvas = this.ctx.webgpuRenderer.getCanvas() as HTMLCanvasElement | null;
        if (!canvas) return;
        canvas.style.cursor = 'crosshair';

        const gesture = new GpDrawGesture({
            capture: (id) => { try { canvas.setPointerCapture(id); } catch { /* pointer already gone */ } },
            release: (id) => { try { if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id); } catch { /* gone */ } },
            claim: (e) => claimPointerEvent(e),
        }, () => (this._gpDrawActive ? handlers : undefined));
        this._gpGesture = gesture;

        type Edit = NonNullable<Scene3DManager['_gpGestureEdit']>;
        const eraseAt = (clientX: number, clientY: number, g: Edit) => {
            const { origin, dir } = this._gpRayAt(clientX, clientY, canvas);
            if (this._gpDrawEraseMode === 'partial') this._gp.eraseStrokesNearRayPartial(g.gpId, g.layerId, origin, dir, this._gpDrawEraseRadius, g.frame);
            else this._gp.eraseStrokesNearRay(g.gpId, g.layerId, origin, dir, this._gpDrawEraseRadius, g.frame);
        };
        const sampleErase = (s: GpGestureSample, g: Edit) => {
            // Partial: the path between two samples is erased too (a fast drag would otherwise leave dashes behind).
            const last = g.lastErase;
            if (this._gpDrawEraseMode === 'partial' && last) {
                const n = Math.min(32, Math.floor(Math.hypot(s.clientX - last.x, s.clientY - last.y) / 4));
                for (let i = 1; i < n; i++) eraseAt(last.x + (s.clientX - last.x) * i / n, last.y + (s.clientY - last.y) * i / n, g);
            }
            eraseAt(s.clientX, s.clientY, g);
            g.lastErase = { x: s.clientX, y: s.clientY };
        };
        const style = () => ({
            color:       this._gpDrawColor,
            baseWidth:   this._gpDrawBaseWidth,
            fillColor:   this._gpDrawFillColor ?? undefined,
            parentJoint: this._gpDrawParentJoint ?? undefined,
            closed:      this._gpDrawClosed,
        });
        const handlers = {
            begin: (s: GpGestureSample, eraserTip: boolean): boolean => {
                const gpId = this._gpDrawGpId, layerId = this._gpDrawLayerId;
                if (!gpId || !layerId) return false;
                if (s.pointerType === 'touch' && this.getTouchNavigate3D()) return false;   // Navigate lock: fingers are the camera's
                const erase = eraserTip || this._gpDrawMode === 'erase';
                const f = this._gpCurrentFrame();
                const frame = this._gp.hasKeyframe(gpId, layerId, f) ? f : undefined;   // a keyframe there: edit what shows
                const list = this._gp.getStrokeList(gpId, layerId, frame);
                if (!list) return false;
                if (erase) {
                    const g: Edit = { gpId, layerId, frame, erase, before: list.slice() };
                    this._gpGestureEdit = g;
                    sampleErase(s, g);
                    return true;
                }
                if (this._gpDrawPlacement === 'surface') {
                    const cast = this._gpSurfaceRaycast(s.clientX, s.clientY, canvas);
                    if (!cast) return false;                         // nothing under the press → leave it to the camera
                    const placer = new GpSurfacePlacer(cast, this._gpSurfaceOffset);
                    const events = placer.sample(s.clientX, s.clientY, s.pressure);
                    if (!placer.onSurface) return false;
                    this._gpGestureEdit = { gpId, layerId, frame, erase, before: list.slice(), placer };
                    this._gp.applyPlacedEvents(gpId, layerId, frame, style(), events);
                    return true;
                }
                const pt = this._gpDrawPointAt(s.clientX, s.clientY, canvas);
                if (!pt) return false;                               // missed the plane → leave the press to the camera
                this._gpGestureEdit = { gpId, layerId, frame, erase, before: list.slice() };
                this._gp.beginStroke(gpId, layerId, this._gpDrawColor, this._gpDrawBaseWidth, {
                    fillColor:   this._gpDrawFillColor ?? undefined,
                    parentJoint: this._gpDrawParentJoint ?? undefined,
                    closed:      this._gpDrawClosed,
                    frame,
                });
                this._gp.addPoint(pt[0], pt[1], pt[2], s.pressure, 1);
                return true;
            },
            move: (s: GpGestureSample): void => {
                const g = this._gpGestureEdit;
                if (!g) return;
                if (g.erase) { sampleErase(s, g); return; }
                if (g.placer) {
                    this._gp.applyPlacedEvents(g.gpId, g.layerId, g.frame, style(), g.placer.sample(s.clientX, s.clientY, s.pressure));
                    return;
                }
                const pt = this._gpDrawPointAt(s.clientX, s.clientY, canvas);
                if (pt) this._gp.addPoint(pt[0], pt[1], pt[2], s.pressure, 1);
            },
            end: (): void => {
                const g = this._gpGestureEdit;
                this._gpGestureEdit = null;
                if (!g) return;
                // Finish the open stroke (a dot, < 2 points, is dropped). A Surface stroke may be several pieces.
                if (g.placer) this._gp.endSurfaceStroke(g.gpId, g.layerId, g.frame, g.before);
                else if (!g.erase) this._gp.endStroke();
                const after = this._gp.getStrokeList(g.gpId, g.layerId, g.frame);
                if (!after) return;
                const afterCopy = after.slice();
                // Nothing kept / the eraser touched nothing: no undo step. One step covers the whole drag (every piece
                // of a Surface stroke, every cut of a partial erase).
                if (Scene3DGreasePencil.sameStrokes(afterCopy, g.before)) return;
                const before = g.before;
                this._undoManager.push({
                    description: g.erase ? 'Grease Pencil erase' : 'Grease Pencil stroke',
                    undo: () => this._gp.setStrokeList(g.gpId, g.layerId, g.frame, before.slice()),
                    redo: () => this._gp.setStrokeList(g.gpId, g.layerId, g.frame, afterCopy.slice()),
                });
            },
            cancel: (): void => {
                const g = this._gpGestureEdit;
                this._gpGestureEdit = null;
                if (!g) return;
                if (!g.erase) this._gp.cancelStroke();
                // Anything this gesture already changed (a Surface stroke's earlier pieces, an erase) goes back too.
                const now = this._gp.getStrokeList(g.gpId, g.layerId, g.frame);
                if (now && !Scene3DGreasePencil.sameStrokes(now, g.before)) this._gp.setStrokeList(g.gpId, g.layerId, g.frame, g.before.slice());
            },
        };

        const onDown = (e: PointerEvent) => gesture.down(e);
        const onMove = (e: PointerEvent) => gesture.move(e);
        const onUp = (e: PointerEvent) => gesture.up(e);
        const onCancel = (e: PointerEvent) => gesture.cancel(e);
        const onLost = (e: PointerEvent) => gesture.lostCapture(e);

        addZonelessListener(canvas, 'pointerdown',   onDown,   { capture: true });
        addZonelessListener(canvas, 'pointermove',   onMove,   { capture: true });
        addZonelessListener(canvas, 'pointerup',     onUp,     { capture: true });
        addZonelessListener(canvas, 'pointercancel', onCancel, { capture: true });
        addZonelessListener(canvas, 'lostpointercapture', onLost, { capture: true });

        this._gpDrawListenerCleanup = () => {
            removeZonelessListener(canvas, 'pointerdown',   onDown,   { capture: true });
            removeZonelessListener(canvas, 'pointermove',   onMove,   { capture: true });
            removeZonelessListener(canvas, 'pointerup',     onUp,     { capture: true });
            removeZonelessListener(canvas, 'pointercancel', onCancel, { capture: true });
            removeZonelessListener(canvas, 'lostpointercapture', onLost, { capture: true });
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
    showBoneOverlay3D(skeletonId: string | null, meshId?: string): void {
        // Capture the pre-armature pose only on the true ENTRY (not on skeleton switches while already active),
        // and restore the actual prior mode on teardown — so leaving the armature panel returns you to free3D
        // if that's where you were, instead of the flat 2D view the auto-sync would otherwise resume.
        const wasActive = this._armature.getBoneOverlaySkeletonId() !== null;
        // enterArmatureMode3D (the panel opening) already captured the pose BEFORE it framed the mesh — capturing again
        // here would record the armature framing as "where you were", and exit would restore THAT instead of your
        // free-3D view (the camera bug on leaving armature mode).
        if (skeletonId !== null && !this._inCameraSubMode() && !this._armatureEntryCaptured) this._captureCurrentPose();
        this._armature.showBoneOverlay3D(skeletonId, meshId);
        this._pauseIdleForEditMode('armature', skeletonId !== null);
        // (not when Edit Mesh / UV already took the camera over: its own exit restores the view state)
        if (skeletonId === null && (wasActive || this._armatureEntryCaptured) && this._armature.editViewOwner !== 'meshEdit') this._applyViewState();
        if (skeletonId === null) this._armatureEntryCaptured = false;
    }
    /** True between enterArmatureMode3D (which snapshots the pre-armature camera) and the panel closing. */
    private _armatureEntryCaptured = false;

    // ── Armature focus mode helpers ──────────────────────────────────────────

    /**
     * Set the visual style for the armature focus mode background.
     * Default is 'gradient' (a calm blue → cream gradient); 'wavy' (the animated wave pattern) is an option.
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
    enterArmatureMode3D(meshId?: string): void {
        // Snapshot the camera BEFORE the armature framing moves it, so leaving armature mode returns to it exactly.
        if (!this._inCameraSubMode() && !this._armatureEntryCaptured) { this._captureCurrentPose(); this._armatureEntryCaptured = true; }
        return this._armature.enterArmatureMode3D(meshId);
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
        this.clearArmsForSkeleton(skel);   // fit the preset to THIS body: hanging arms raised just enough to clear it
        skel.computeWorldMatrices();
        this.ctx.scheduleRender();
        return true;
    }

    /**
     * Keep a procedural body's HANGING arms out of its own torso/hips (arm-clearance.ts): raises each down-hanging arm
     * sideways the minimum that clears THIS body's shape (+ a small margin for the idle sway). A pose that already
     * clears is untouched. Runs after a preset / pose-library pose and after a body-shape change. If the idle is
     * running, its captured base is corrected too (else the next idle frame would restore the clipping pose).
     * Returns the degrees added per side.
     */
    clearArmsForSkeleton(skel: Skeleton3D): { L: number; R: number } {
        const none = { L: 0, R: 0 };
        const body = this.getAllMeshes().find(m => m instanceof SkinnedMesh3D && m.isProceduralBody && m.skeletonId === skel.id) as SkinnedMesh3D | undefined;
        if (!body?.geometry || !body.jointIndices || !body.jointWeights) return none;
        const joints = skel.data.joints;
        const m: SkinnedMeshData = {
            vertices: body.geometry.vertices, stride: 12, posOffset: 0, indices: body.geometry.indices,
            jointIndices: body.jointIndices, jointWeights: body.jointWeights, jointNames: joints.map(j => j.name),
            jointParents: Int16Array.from(joints.map(j => j.parentIndex)),
            jointLocalPositions: Float32Array.from(joints.flatMap(j => [j.localPosition[0], j.localPosition[1], j.localPosition[2]])),
            inverseBindMatrices: Float32Array.from(joints.flatMap(j => Array.from(j.inverseBindMatrix))),
        };
        const idleBase = this._animation.getIdleBase(body.id);
        const rot = new Map(joints.map(j => [j.name, [...(idleBase?.get(j.name) ?? j.localRotation)] as [number, number, number, number]]));
        let added = none;
        try { added = resolveArmClearance(m, rot, skel.skinningMethod); } catch { return none; }   // never let a fit failure break posing
        for (const side of ['L', 'R'] as const) {
            if (!added[side]) continue;
            const name = `shoulder_${side}`, q = rot.get(name)!, j = joints.find(jj => jj.name === name);
            if (j) { j.localRotation = [...q]; j.ikRotation = undefined; j.constraintRotation = undefined; }
            if (idleBase?.has(name)) idleBase.set(name, [...q] as [number, number, number, number]);
        }
        if (added.L || added.R) { skel.computeWorldMatrices(); skel.matricesDirty = true; }
        return added;
    }

    /** Pre-clip gaze per body, captured at a clip's first gaze event and restored by its `restore` event. */
    private _clipGazeBase = new Map<string, [number, number]>();
    /** Bodies whose face-kit expression a clip changed (so its `restore` event returns them to rest). */
    private _clipExprSet = new Set<string>();
    /** A clip face event → the procedural body driven by `skel`: gaze jump (offset from the pre-clip gaze), blink,
     *  restore. Face-less bodies ignore it. */
    private _clipFaceEvent(skel: Skeleton3D, ev: import('../../types/armature-3d').ClipFaceEvent): void {
        const body = this.getAllMeshes().find(m => m instanceof SkinnedMesh3D && m.isProceduralBody && m.skeletonId === skel.id);
        if (!body) return;
        const id = body.id;
        if (ev.blink) this._character.blinkNow(id);
        // Face kit (face-features.ts): expressions + brow raises; `restore` also returns to the resting expression.
        if (ev.expression) { if (this._character.setCharacterExpression(id, ev.expression, { weight: ev.weight, blendMs: 220 })) this._clipExprSet.add(id); }
        else if (ev.restore && this._clipExprSet.delete(id)) this._character.setCharacterExpression(id, 'default', { blendMs: 260 });
        if (ev.browRaise) this._character.pulseBrows(id, ev.browRaise);
        if (ev.gaze || ev.restore) {
            const cur = this._character.getFaceGaze(id);
            if (!cur) return;
            if (!this._clipGazeBase.has(id)) this._clipGazeBase.set(id, cur);
            const base = this._clipGazeBase.get(id)!;
            if (ev.restore) { this._character.setFaceGaze(id, base[0], base[1]); this._clipGazeBase.delete(id); }
            else if (ev.gaze) this._character.setFaceGaze(id, base[0] + ev.gaze[0], base[1] + ev.gaze[1]);
        }
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

    // ── Armature tool strip + tap-select (UI review 2026-10-07 §4; Scene3DArmature) ──
    selectArmatureJoint3D(skeletonId: string, jointIndex: number, additive = false): boolean { return this._armature.selectArmatureJoint(skeletonId, jointIndex, additive); }
    getSelectedArmatureJoints3D(): { skeletonId: string; jointIndex: number }[] { return this._armature.getSelectedArmatureJoints(); }
    onArmatureJointSelectionChanged(cb: (sel: { skeletonId: string; jointIndex: number }[]) => void): () => void { return this._armature.onJointSelectionChanged(cb); }
    pickArmatureJointAt3D(clientX: number, clientY: number, radiusCss?: number): { skeletonId: string; jointIndex: number; jointName: string } | null { return this._armature.pickArmatureJointAt(clientX, clientY, radiusCss); }
    setArmatureActiveTool3D(tool: import('./scene3d-armature').ArmatureTool): boolean { return this._armature.setArmatureActiveTool(tool); }
    getArmatureActiveTool3D(): import('./scene3d-armature').ArmatureTool { return this._armature.getArmatureActiveTool(); }
    addArmatureChildJoint3D(skeletonId: string, parentJointIndex: number, name?: string): number { return this._armature.addArmatureChildJoint(skeletonId, parentJointIndex, name); }
    setArmatureIK3D(skeletonId: string, jointIndex: number, opts: { chainLength: number; poleJointIndex?: number | null; enabled: boolean }): string | null { return this._armature.setArmatureIK(skeletonId, jointIndex, opts); }
    getArmatureIK3D(skeletonId: string, jointIndex: number) { return this._armature.getArmatureIK(skeletonId, jointIndex); }

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
    deleteMeshGroup(groupId: string): boolean {
        const prov = this._providerOf(groupId);   // a provider's group (the Character v2 save marker) → delete the character
        if (prov?.delete) return prov.delete(groupId);
        return this._grouping.deleteMeshGroup(groupId);
    }

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

        // P3 (editing-loop-polish.md): re-express the mesh's transform in the group's frame so a
        // transformed group adopting it does NOT move it in world space.
        rebase3DNodeToParent(mesh, group);
        this.ctx.emitSceneGraphChanged();
        this.ctx.scheduleRender();
        return true;
    }

    removeMeshFromGroup(meshId: string): boolean {
        const mesh = this.getMesh(meshId);
        if (!mesh || !mesh.parent || mesh.parent === this.ctx.sceneGraph.root) return false;
        // P3: compose the group chain's transform into the mesh on the way out (world pose holds).
        rebase3DNodeToParent(mesh, this.ctx.sceneGraph.root);
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
        for (const m of [this._animation.squashStretch, this._animation.idleBreaks, this._animation.idleRigs,
                         this._kitbash.spawnSpins, this._animation.legIdleModes] as Map<string, any>[])
            cap(m, bodyMeshId);
        cap(this._charSkelSyncVer, bodyMeshId);
        for (const id of partIds) cap(this._charSkelSyncVer, id);
        if (skelId) { cap(this._springActiveUntil as unknown as Map<string, any>, skelId); cap(this._animation.nlaBindPoses as unknown as Map<string, any>, skelId); }
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
        // A provider's character (Character v2 body) → its own ONE undoable whole-character delete (body + skeleton +
        // save marker + record); the plain mesh delete orphaned the skeleton + record (review fix runtime#4).
        const prov = this._providerOf(nodeId);
        if (prov?.delete) return prov.delete(nodeId);
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
        // A provider's character (Character v2 body): a REAL character copy, built asynchronously by its provider (one
        // undo step there) — never a static T-pose statue sharing the live vertex array (review fix runtime#3). Returns
        // null: the copy is not ready synchronously.
        const prov = this._providerOf(nodeId);
        if (prov) { prov.duplicate?.(nodeId); return null; }
        const src = this.getMesh(nodeId);
        if (!src) return null;

        const copy = new Mesh3D(this.ctx.interactionService, src.x, src.y, src.z, {
            primitive: 'custom',
            // A blend-shaped source is re-shaped IN PLACE by its weights: never alias its vertex array (the copy moved
            // with every later weight change of the original).
            geometry:  src.blendShapes.length ? { ...src.geometry, vertices: src.geometry.vertices.slice() } : src.geometry,
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
        // The copy keeps live generator settings while they still describe the source (its eye parts stay the source's)
        if (src.generatorApplies && src.generator) {
            const { parts: _parts, ...gen } = cloneGeneratorRecord(src.generator);
            copy.generator = gen;
            copy.stampGenerator();
        }

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
        mesh.stateDirty = true;   // persisted (P8) — submeshes ride Mesh3D.toJSON
        this.ctx.scheduleRender();
    }

    appendSubmesh(meshId: string, submesh: Submesh3D): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        mesh.submeshes.push({ ...submesh });
        mesh.gpuDirty = true;
        mesh.stateDirty = true;   // persisted (P8) — submeshes ride Mesh3D.toJSON
        this.ctx.scheduleRender();
    }

    removeSubmesh(meshId: string, slotIndex: number): void {
        const mesh = this.getMesh(meshId);
        if (!mesh || slotIndex < 0 || slotIndex >= mesh.submeshes.length) return;
        mesh.submeshes.splice(slotIndex, 1);
        mesh.gpuDirty = true;
        mesh.stateDirty = true;   // persisted (P8) — submeshes ride Mesh3D.toJSON
        this.ctx.scheduleRender();
    }

    clearSubmeshes(meshId: string): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        mesh.submeshes = [];
        mesh.gpuDirty = true;
        mesh.stateDirty = true;   // persisted (P8) — submeshes ride Mesh3D.toJSON
        this.ctx.scheduleRender();
    }

    /** Apply saved multi-material slots after a mesh is rebuilt (audit P8). Saved slots WIN over whatever a GLB
     *  re-import produced — they carry the user's per-slot material edits. Skipped (with a warning) when the ranges no
     *  longer fit the restored geometry. */
    private _restoreSubmeshes(mesh: Mesh3D, saved: unknown): void {
        if (!Array.isArray(saved) || saved.length === 0) return;
        const clones = validSavedSubmeshes(saved, mesh.geometry?.indices?.length ?? 0);
        if (!clones) { console.warn('[Salsa] saved submeshes no longer fit mesh', mesh.id, '— keeping the rebuilt slots'); return; }
        mesh.submeshes = clones;
        mesh.gpuDirty = true;
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
    /** Public: free a GPUTexture ONLY if no other live mesh (or the texture library) still references it. Use
     *  before overwriting a mesh's diffuse/normal texture — a raw `.destroy()` would free a texture a duplicated
     *  sibling still renders (use-after-free). Leak-safe: frees when the last holder is torn down. */
    destroyTextureIfUnshared3D(tex: GPUTexture | null | undefined, exceptMeshId?: string): void { this._destroyTextureIfUnshared(tex, exceptMeshId); }

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
                cascades:   this.renderer3D.shadowCascades,
            },
            snap: this.snapMode,
            snapGridSize:   this.snapGridSize,
            snapRotateStep: this.snapAngle,
            snapScaleStep:  this.snapScaleStep,
            grid: { visible: this._gridVisible, color: this.gridColor, opacity: this._gridOpacity },
            softLightStrength: this.renderer3D.softLightStrength,   // global wrapped/half-Lambert amount for soft-lit skin
            skinRamp: { ...this.renderer3D.skinRamp },              // global skin toon-ramp look (bands/softness/tint)
            sketchPaper: this.renderer3D.sketchPaper,               // Sketch style paper amount (0 colour .. 1 paper)
            toonShadows: this.renderer3D.toonShadows,               // toon-shadow look (Cel + toonShadow materials)
            rimLight: this.renderer3D.rimLight,                     // parameterised rim (strength 0 = original)
            environmentStyle: { ...(this._environmentStyle ?? {}) },   // the Environment style ({} = none)
            shadowTint: this.renderer3D.shadowTint,                        // coloured shadows (null = neutral)
            heightFog: this.renderer3D.heightFog,                          // height fog (density 0 = off)
            aerialHaze: this.renderer3D.aerialHaze,                        // aerial perspective (strength 0 = off)
            ...(this.renderer3D.fogHardEdge ? { fogHardEdge: true } : {}),  // only when on → old saves stay identical
            ...((): { fogHorizon?: Partial<import('../../renderer/3d/fog-horizon').FogHorizonSettings> } => { const d = fogHorizonDiff(this.renderer3D.fogHorizon); return d ? { fogHorizon: d } : {}; })(),   // only non-default fields → old saves stay identical
            edgeOutlines: this.renderer3D.outlineConfig,            // screen-space edge outline (null = off)
            characterOutlines: this._charOutlines ? { ...this._charOutlines } : null,   // E3 characters-only outline (null = off)
            playCharacterOutlines: this._playCharOutlines,                  // item 10: ink line in Play (absent in old saves = off)
            particleBloom: this.renderer3D.bloomConfig,             // particle "Bloom Glow" (null = off)
            antiAliasing: this.renderer3D.antiAliasing,             // 3D AA (FXAA medium by default)
            scriptBehaviors: this._scriptManager.serialize(),      // custom per-node game-logic sources
            // Refresh the current mode's camera pose so a save made without ever switching modes still
            // records where the camera is (so reload restores the vantage, not a reframe).
            viewState: (this._captureCurrentPose(), { ...this._viewState }),
            // Only serialize the library when it actually has entries (keeps old/empty saves clean).
            ...(this._animLibrary && this._animLibrary.size > 0 ? { animationLibrary: this._animLibrary.serialize() } : {}),
            ...(this._assetRefs.size > 0 ? { assetReferences: this._assetRefs.serialize() } : {}),
            // Play settings (eye height / auto default character) — only when non-default, so old saves stay identical.
            ...(this.playSettings.serialize() ? { play: this.playSettings.serialize() } : {}),
            // Play-mode player binding + locomotion set (only when set).
            ...((this._playerMeshId || this._locoSet || this._locoBlend || this._playerOverlayRef) ? { player: { meshId: this._playerMeshId, locomotionSet: this._locoSet, ...(this._locoBlend ? { locomotionBlend: this._locoBlend } : {}), ...(this._playerOverlayRef ? { overlay: this._playerOverlayRef } : {}) } } : {}),
        };
    }

    /** Device-lost recovery (docs/ui/device-recovery.md): drop the GPU objects this manager's helpers keep across a
     *  document load (the restore that follows rebuilds the document content on the new device). Returns what the
     *  recovery can't bring back (not document content). */
    resetGpuResourcesForDeviceLoss(): string[] {
        const lost: string[] = [];
        this._textures.resetForDeviceLoss();
        const html = this._htmlTex.count;
        if (html) lost.push(`${html} HTML texture(s) (runtime-only, not document content): set them again`);
        this._htmlTex.dispose();
        const cloth = this._cloth.resetForDeviceLoss();
        if (cloth) lost.push(`${cloth} live cloth simulation(s) stopped: start them again`);
        return lost;
    }

    /** Clear every 3D-side registry before a document restore (audit 2026-09-28 P6): character rigs, the kitbash
     *  catalog + baked parts, and the GLB model store (refilled by restoreMeshState for each GLB mesh — without this
     *  the PREVIOUS doc's 50-200 MB of GLBs were written into the new doc's folder on the next save). */
    clearForDocumentLoad3D(): void {
        // bug-hunt 2026-10-01: a load while PLAYING left the GameLoop driving the old doc's player, the editor
        // suspended (autosave blocked), and Stop later wrote the old pre-play transforms/camera onto the new doc.
        this.exitPlayMode3D();
        this._character.clearForDocumentLoad();
        this._kitbash.clearForDocumentLoad();
        this._modelStore.clear();
        this._textures.resetForDocumentLoad();   // the texture library MERGED across loads (new-document audit 2026-10-06)
        // Document-content registries that restoreGlobalScene3DSettings used to clear UNCONDITIONALLY — which also
        // fired on PARTIAL restores (exitCityMode's lighting restore, sm.authoring.applySceneSettings) and wiped the
        // document's scripts / animation library / asset refs / play settings / player binding (bug-hunt 2026-10-01).
        // The forget-the-previous-doc step lives here now; the restore only touches keys that are present.
        this._scriptManager.restore(undefined);
        this.animLibrary.clearForDocumentLoad();
        this._assetRefs.clearForDocumentLoad();
        this.playSettings.restore(undefined);
        this._playerMeshId = null; this._locoSet = null; this._locoBlend = null; this._playerOverlayRef = null;
        // The session IBL cache (live ImageData / sky source / encoded data URL) must not outlive its document: the
        // restore prefers the cache over the doc's own ibl.image, so doc B rendered (and re-saved) doc A's env map.
        this._envMapImageRaw = null; this._envMapSkySrc = null; this._envMapDataUrlRaw = null;
        this._preSkyEnv = null;   // resetSky3D in doc B restored doc A's pre-preset sun / ambient / IBL
        // §P15 stats fix: the GPU-driven records of doc A's meshes must not outlive it (they held the meshes + their
        // geometry, and their read-back counters showed in doc B's HUD); the next frame rebuilds from doc B
        (this.ctx.webgpuRenderer.getRenderer3D() as Renderer3D | null)?.resetGpuScene();
        // New-document audit 2026-10-06 — more state that outlived its document:
        // camera preview / look-through (orbit stayed disabled on a stale edit-camera snapshot) and the cut list (the
        // host's Cameras lane — and the host's save — kept the previous document's cuts, pointing at dead ids).
        if (this._previewThroughCameras) this.setPreviewThroughCameras3D(false);
        if (this._lookThroughCamId !== null) this.lookThroughCamera3D(null);
        if (this._cameraCuts.length) this.setCameraCuts3D([]);
        // Grease Pencil registry: its nodes leave with the scene graph, but gather() wrote every registered object into
        // the next document's save (restoreGpStates, the only reset, runs only for a document that has GP objects).
        this._gp.dispose();
        // Particle emitters: detached emitters kept ticking (and forcing frames); restored ones re-register.
        this._particles.dispose();
        // Host-set street-lamp point lights kept lighting the next document.
        this.setPointLights3D([]);
        this.setCandidatePointLights3D([]);
        this.clearSelection();
    }

    /** The engine's global-settings defaults, snapshotted at the START of the first document load (before anything
     *  is restored) — see resetGlobalScene3DSettingsForLoad. */
    private _globalSettingsDefaults: GlobalScene3DSettings | null = null;

    /** Reset global scene settings to the engine defaults before a document's own settings are applied (audit P6).
     *  restoreGlobalScene3DSettings only overwrites the fields a save CONTAINS, so a document saved before a field
     *  existed (or a legacy doc with no globalScene block at all) inherited the PREVIOUS doc's fog/PS1/SSAO/wind/
     *  skin-ramp/… — and then saved it as its own. Resetting first makes every load start from the same baseline.
     *  The snapshot is taken lazily at the first load because renderer3D doesn't exist at construction. */
    resetGlobalScene3DSettingsForLoad(): void {
        if (!this._globalSettingsDefaults) {
            const d = JSON.parse(JSON.stringify(this.getGlobalScene3DSettings())) as GlobalScene3DSettings;
            // Settings only — never the first session's document CONTENT (scripts, library, refs, play, player):
            // those would otherwise be re-applied to every later doc lacking the key (bug-hunt 2026-10-01).
            for (const k of ['scriptBehaviors', 'animationLibrary', 'assetReferences', 'play', 'player'] as const) delete (d as Partial<GlobalScene3DSettings>)[k];
            // Only-when-on keys are absent from a gather → pin their default so a doc without the key loads as off.
            d.fogHardEdge = false;
            d.fogHorizon = {};   // (only-non-default too: {} = the defaults)
            this._globalSettingsDefaults = d;
        }
        this.restoreGlobalScene3DSettings(JSON.parse(JSON.stringify(this._globalSettingsDefaults)));
    }

    /** How a character's joints blend (audit C1 Phase 3): 'linear' (the original) or 'dualQuat' (keeps volume at bent
     *  joints). Accepts a Skeleton3D id OR any skinned-mesh id bound to it (body/clothes/hair → the shared skeleton, so
     *  the whole character switches together). Persists with the skeleton. Returns false if nothing resolved. */
    setSkinningMethod3D(id: string, method: 'linear' | 'dualQuat'): boolean {
        const skel = this.getSkeleton(id) ?? this.getSkinnedMesh(id)?.skeleton ?? null;
        if (!skel) return false;
        skel.skinningMethod = method;
        skel.matricesDirty = true;   // re-upload the skin buffer in the new packing
        this.ctx.scheduleRender();
        return true;
    }
    getSkinningMethod3D(id: string): 'linear' | 'dualQuat' | null {
        const skel = this.getSkeleton(id) ?? this.getSkinnedMesh(id)?.skeleton ?? null;
        return skel ? skel.skinningMethod : null;
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
            // Intent + ARTISTIC knobs persist (internal blur = ssrFillBlur, edge feather = ssrEdgeFeather); the
            // march tuning (maxSteps/stride/thickness) stays engine-owned.
            this.setSSR3D({ ssr: r.ssr, ssrIntensity: r.ssrIntensity, ssrMaxRoughness: r.ssrMaxRoughness, cubemapRes: r.cubemapRes, ssrFillBlur: r.ssrFillBlur, ssrEdgeFeather: r.ssrEdgeFeather, ssrReach: r.ssrReach, ssrFallbackShadow: r.ssrFallbackShadow });
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
            // Cascades: a shadows block without the key (older saves, partial restores) means the original single map.
            this.renderer3D.setShadowCascades(s.shadows.cascades ?? { cascades: 1 });
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
        if (s.softLightStrength !== undefined) this.renderer3D.setSoftLightStrength(s.softLightStrength);
        if (s.skinRamp !== undefined) this.renderer3D.setSkinRamp(s.skinRamp);
        // Only touch a setting whose KEY is present: this is also called with PARTIAL objects (the city tool restores
        // just lighting/bg/fog/shadows; the scene-authoring API a patch), which must not reset everything else. A
        // document load first resets to the defaults (resetGlobalScene3DSettingsForLoad), so an older save that lacks
        // a key still lands on the default (Sketch 0.75, toon defaults, rim strength 0, edge outline + particle bloom OFF).
        if ('sketchPaper' in s) this.renderer3D.setSketchPaper(s.sketchPaper ?? 0.75);
        if ('toonShadows' in s) this.renderer3D.setToonShadows({ ...DEFAULT_TOON_SHADOWS, ...(s.toonShadows ?? {}) });
        if ('rimLight' in s) this.renderer3D.setRimLight({ ...DEFAULT_RIM_LIGHT, ...(s.rimLight ?? {}) });
        // The Environment style VALUE only — every object already carries (and restores) its own style.
        if ('environmentStyle' in s) this._environmentStyle = sanitizeObjectStyle(s.environmentStyle);
        if ('shadowTint' in s) this.renderer3D.setShadowTint(Array.isArray(s.shadowTint) ? s.shadowTint : null);
        if ('aerialHaze' in s) { const a = Array.isArray(s.aerialHaze) && s.aerialHaze.length === 4 ? s.aerialHaze : [0, 20, 0.6, 0.5]; this.renderer3D.setAerialHaze(a[0], a[1], a[2], a[3]); }
        if ('fogHardEdge' in s) this.renderer3D.fogHardEdge = s.fogHardEdge === true;
        if ('fogHorizon' in s) this.renderer3D.setFogHorizon({ ...(s.fogHorizon && typeof s.fogHorizon === 'object' ? s.fogHorizon : {}), reset: true });
        if ('heightFog' in s) { const h = Array.isArray(s.heightFog) && s.heightFog.length === 4 ? s.heightFog : [0, 0, 1, 0.05]; this.renderer3D.setHeightFog(h[0], h[1], h[2], h[3]); }
        if ('edgeOutlines' in s) { if (s.edgeOutlines) this.renderer3D.enableOutlines(s.edgeOutlines.color, s.edgeOutlines.threshold, s.edgeOutlines.depthFade ?? null); else this.renderer3D.disableOutlines(); }
        // E3: the setting only (each saved body restores its own outline); future characters pick it up.
        if ('characterOutlines' in s) this._charOutlines = s.characterOutlines ? { ...s.characterOutlines } : null;
        // Item 10: always saved since it existed. A FULL document save from before it (it carries the always-written
        // characterOutlines / viewState keys) has no key → off, so old documents play as they did; a partial patch
        // (lighting only) leaves it alone; a new / empty document keeps the default (on).
        this._playCharOutlines = playCharacterOutlinesOnRestore(s, this._playCharOutlines);
        if ('antiAliasing' in s) this.renderer3D.setAntiAliasing(s.antiAliasing ?? { mode: 'fxaa', quality: 'medium' });
        if ('particleBloom' in s) { if (s.particleBloom) this.renderer3D.enableBloom(s.particleBloom.threshold, s.particleBloom.intensity); else this.renderer3D.disableBloom(); }
        // Document-content keys below: only when PRESENT (partial restores must not wipe them — clearForDocumentLoad3D
        // does the forget-the-previous-doc reset on a real load).
        if ('scriptBehaviors' in s) this._scriptManager.restore(s.scriptBehaviors);   // clears stale first, then loads
        if (s.viewState) {
            // Restore the target × camera mode (+ poses). normalizeViewState coerces legacy/partial blobs; older
            // saves have no viewState → left at the illustration/ortho2D default (loaded unchanged).
            this._viewState = normalizeViewState(s.viewState);
            this._applyViewState();
            this.onViewStateChanged.emit();
            void this._refreshArtboardTexture();   // capture the artboard texture if restored into illustration × free3D
        }
        // Animation Library: always CLEAR (stale-registry rule — a doc without a library must not inherit the
        // previous doc's), then load the incoming one. `load(merge:false)` replaces + re-mints ids.
        if (s.animationLibrary) { this.animLibrary.clearForDocumentLoad(); this.animLibrary.load(s.animationLibrary); }
        if (s.assetReferences) { this._assetRefs.clearForDocumentLoad(); this._assetRefs.load(s.assetReferences); }
        // Play settings (absent = defaults, reset by clearForDocumentLoad3D: automatic eye height, auto default character on).
        if ('play' in s) this.playSettings.restore(s.play);
        // Play-mode player binding + locomotion set (reset by clearForDocumentLoad3D; restored when present).
        if ('player' in s) {
            this._playerMeshId = s.player?.meshId ?? null;
            this._locoSet = s.player?.locomotionSet ? { ...s.player.locomotionSet } : null;
            this._locoBlend = s.player?.locomotionBlend ? { ...s.player.locomotionBlend } : null;
            this._playerOverlayRef = s.player?.overlay ? { clip: s.player.overlay.clip, region: Array.isArray(s.player.overlay.region) ? [...s.player.overlay.region] : s.player.overlay.region, mode: s.player.overlay.mode, weight: s.player.overlay.weight } : null;
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
    // P4.1: both are LAZY. A procedural-sky bake (the time-of-day path) only records its source params
    // (`_envMapSkySrc`); the equirect ImageData and its webp data URL are materialized on first read (save / restore /
    // reset), not on every rebake. `_envMapDataUrlRaw === undefined` = not encoded yet.
    private _envMapImageRaw: ImageData | null = null;
    private _envMapSkySrc: { sky: SkyState; sunDir: [number, number, number] } | null = null;
    private _envMapDataUrlRaw: string | null | undefined = null;
    private get _envMapImage(): ImageData | null {
        const src = this._envMapSkySrc;
        if (!this._envMapImageRaw && src) {
            const { width, height, data } = bakeSkyEquirect(src.sky, src.sunDir);
            if (typeof ImageData !== 'undefined') { const img = new ImageData(width, height); img.data.set(data); this._envMapImageRaw = img; }
            else this._envMapImageRaw = { width, height, data } as unknown as ImageData;
        }
        return this._envMapImageRaw;
    }
    private set _envMapImage(v: ImageData | null) { this._envMapImageRaw = v; this._envMapSkySrc = null; }
    private get _envMapDataUrl(): string | null {
        if (this._envMapDataUrlRaw === undefined) { const img = this._envMapImage; this._envMapDataUrlRaw = img ? Scene3DManager._imageDataToDataUrl(img) : null; }
        return this._envMapDataUrlRaw;
    }
    private set _envMapDataUrl(v: string | null) { this._envMapDataUrlRaw = v; }
    private _envMapIntensity = 1.0;
    setEnvironmentMap3D(imageData: ImageData | null, intensity = 1.0): void {
        this._envMapImage = imageData; this._envMapIntensity = intensity;
        this._envMapDataUrlRaw = imageData ? undefined : null;   // encoded lazily on save
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
        // P4.1: ONE bake call — SH diffuse + prefiltered specular, on the GPU (compute) when available, else the CPU
        // reference. The env-map cache records only the sky SOURCE; its equirect image + data URL (for save / restore /
        // reset) are materialized lazily, so a time-of-day rebake costs no CPU equirect + webp encode.
        const sky = JSON.parse(JSON.stringify(st.sky)) as SkyState;
        this._envMapImage = null;
        this._envMapSkySrc = { sky, sunDir };
        this._envMapDataUrlRaw = undefined;
        this._envMapIntensity = intensity;
        this.renderer3D.onSkyBakeApplied ??= () => this.ctx.scheduleRender();   // a pipeline-pending bake lands later
        this.renderer3D.bakeSkyLighting(sky, sunDir, intensity);
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
    setIBLDiffuseIntensity3D(v: number): void {
        this.renderer3D.setIBLDiffuseIntensity(v);
        this._envMapIntensity = Math.max(0, v);   // saved as ibl.intensity: a reload kept the intensity of the last upload / bake
        this.ctx.scheduleRender();
    }
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
        this.renderer3D.setSSRParams(r.ssrMaxSteps, r.ssrStride, r.ssrThickness, r.ssrIntensity, r.ssrMaxRoughness, r.ssrFillBlur, r.ssrEdgeFeather, r.ssrReach, r.ssrFallbackShadow);
        this.renderer3D.setSSREnabled(r.ssr);
        this.ctx.scheduleRender();
    }
    /** Current reflections config (SSR params + cubemap res). */
    getReflections3D(): ReflectionsState { return { ...this._environment.state.reflections }; }

    /** SSR DEBUG view: reflective fragments show the ray-hit UV (red=u, green=v) instead of the reflected colour, so
     *  the reflection mapping is visible for diagnosing a direction/sign bug. */
    setSSRDebug3D(on: boolean): void { this.renderer3D.setSSRDebug(on); this.ctx.scheduleRender(); }

    /** ENGINE ESCAPE HATCH (debug/A-B only — not persisted, no host UI): toggle SSR's depth-peeled backface-fill.
     *  ON (default with SSR): exact volume-membership fills (second prepass). OFF: the single-layer thickness
     *  heuristic — for isolating whether an artifact comes from the peel pass or predates it. */
    setSSRDepthPeeling3D(on: boolean): void { this.renderer3D.setSSRDepthPeeling(on); this.ctx.scheduleRender(); }

    /** ENGINE ESCAPE HATCH (debug/A-B only — not persisted, no host UI): toggle the deferred half-res SSR
     *  resolve pass (Stage 3b). OFF = the inline per-fragment trace (identical algorithm, higher cost). */
    setSSRDeferred3D(on: boolean): void { this.renderer3D.setSSRDeferred(on); this.ctx.scheduleRender(); }

    /** UI System world control: scale WORLD time (1 = normal, 0 = frozen, 0.5 = slow-mo). Freezes/slows the
     *  shader scene clock (water/neon/holograms) AND every AnimationPlayer3D (clips + NLA). */
    uiSetWorldSpeed3D(speed: number): void {
        this.renderer3D.setWorldSpeed(speed);
        AnimationPlayer3D.worldSpeed = Math.max(0, speed);
        this.ctx.scheduleRender();
    }
    /** UI System world control: move the 3D camera — instant, or eased over durationMs. The tween runs on UI
     *  time (RAF), so a camera move still plays inside a frozen (worldSpeed 0) state. */
    uiSetCamera3D(position?: [number, number, number], target?: [number, number, number], durationMs?: number): void {
        if (this._uiCamTweenRaf != null) { cancelAnimationFrame(this._uiCamTweenRaf); this._uiCamTweenRaf = null; }
        if (!durationMs || durationMs <= 0 || typeof requestAnimationFrame === 'undefined') {
            this.renderer3D.uiSetCamera(position, target);
            this.ctx.scheduleRender();
            return;
        }
        const from = this.renderer3D.uiGetCamera();
        const p1 = position ?? from.position, t1 = target ?? from.target;
        const start = performance.now();
        const step = (): void => {
            const t = Math.min(1, (performance.now() - start) / durationMs);
            const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;   // easeInOut
            const lerp3 = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
                [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
            this.renderer3D.uiSetCamera(lerp3(from.position, p1), lerp3(from.target, t1));
            this.ctx.scheduleRender();
            this._uiCamTweenRaf = t < 1 ? requestAnimationFrame(step) : null;
        };
        step();
    }
    private _uiCamTweenRaf: number | null = null;

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
        // An animated outline keeps frames flowing via the self-evaluating 'hoverOutline' pre-render callback (for
        // Renderer3D.HOVER_ANIM_HOLD_MS after the hover changed) — a begin/endInteractive hold here kept the loop live
        // for as long as the pointer rested on the landmark.
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

    /** The Edit Mesh selection's WORLD centre (null = nothing selected): the edit camera orbits around it (else the
     *  mesh's bounding-box centre — Scene3DArmature.getEditOrbitPivot). Supplied by ShapeManager. */
    setEditSelectionPivotProvider(fn: (() => [number, number, number] | null) | null): void { this._armature.editSelectionPivotProvider = fn; }
    /** The point the edit camera's next orbit gesture revolves around (null outside an edit view). */
    getEditOrbitPivot3D(): [number, number, number] | null { return this._armature.getEditOrbitPivot(); }

    /**
     * Enable the transform gizmo + click-to-select for 3D meshes.
     * Attaches pointer event listeners to the canvas.
     */
    enableTransformControls(): void { return this._armature.enableTransformControls(); }

    /** Set up (or re-use) the canvas listeners that drive bone overlay hover, drag, and placement.
     *  Idempotent — safe to call multiple times; only registers once per canvas session. */

    disableTransformControls(): void {
        // Forced teardown. If armature/bone-overlay was live, restore the mode the user was actually in
        // afterwards (else the 2D auto-sync resumes and drops a free3D user into the flat 2D view).
        const wasArmature = this._armature.getBoneOverlaySkeletonId() !== null;
        this._armature.disableTransformControls();
        if (wasArmature) this._applyViewState();
    }

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
        this.ctx.webgpuRenderer.addPreRenderCallback(this._arrayToolPreRenderCb, 'arrayTool');
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
        // In Edit Mesh the selection gizmo follows the scene's gizmo mode too (the object gizmo is hidden there).
        if (this._elementXf?.handles()) this._elementXf.setGizmoMode(mode);
        return this._armature.setGizmoMode(mode);
    }

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
    private _gridVisible = true;   // default ON — a fresh 3D scene shows the ground reference grid (2026-09-22)
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
        // P5 (editing-loop-polish.md): the visible grid is scene content too — feed its diagonal
        // extent into autoFar's sceneRadius so grazing views can't far-clip it (grow-only; a
        // reframe re-derives the mesh radius but keeps this floor).
        const floor = this._gridRadiusFloor();
        if (floor > 0) {
            const cam = this.renderer3D.getCamera();
            if (floor > cam.sceneRadius) { cam.autoFar = true; cam.sceneRadius = floor; }
        }
        this.ctx.scheduleRender();
    }

    /** World radius that encloses the reference grid when it's visible (0 when hidden). Mirrors
     *  gizmo-renderer drawGrid's extent math: lines out to ±min(floor(10/step), 200)·step. */
    private _gridRadiusFloor(): number {
        if (!(this._gridVisible && this._gridVisibleOverride)) return 0;
        const step = Math.max(this.snapGridSize, 1e-4);
        const n = Math.max(1, Math.min(Math.floor(10 / step), 200));
        return n * step * Math.SQRT2;   // corner-to-center diagonal of the square grid
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
    } { return this._elementXf?.dragInfo() ?? this._armature.getDragInfo(); }

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

    /** Edit Mesh element transforms (docs/specs/edit-mesh-topology.md §11): while a mesh is in Edit Mesh the G / R / S
     *  family below drives the SELECTED ELEMENTS (the MeshEditPointerController's router), not the object. */
    private _elementXf: ElementTransformRouter | null = null;
    setElementTransformRouter(router: ElementTransformRouter | null): void { this._elementXf = router; }
    /** The element transform owns the G / R / S family right now: one runs, or a mesh is in Edit Mesh. */
    private _xfRouted(): ElementTransformRouter | null {
        const r = this._elementXf;
        return r && (r.isActive() || r.handles()) ? r : null;
    }

    get isShortcutActive(): boolean {
        const r = this._xfRouted();
        if (r) return r.isModal();
        return this._armature.getTransformController()?.isShortcutActive ?? false;
    }
    get shortcutMode(): 'grab' | 'rotate' | 'scale' | null {
        const r = this._xfRouted();
        if (r) return r.isModal() ? r.mode() : null;
        return this._armature.getTransformController()?.shortcutMode ?? null;
    }
    get shortcutAxis(): 'x' | 'y' | 'z' | null {
        const r = this._xfRouted();
        if (r) return r.isModal() ? r.axis() : null;
        return this._armature.getTransformController()?.shortcutAxis ?? null;
    }
    get shortcutNumericDisplay(): string {
        const r = this._xfRouted();
        if (r) return r.isModal() ? r.numeric() : '';
        return this._armature.getTransformController()?.shortcutNumericDisplay ?? '';
    }

    // Round 8: the G/R/S modal-transform family is an EDITOR hotkey path (the host's keydown calls it) — inert while
    // playing (Play's WASD reaches the host's document listener too; S would start a scale). Cancel still works.
    beginTransform3D(mode: 'grab' | 'rotate' | 'scale'): void {
        if (this._playing) return;
        const r = this._xfRouted();
        if (r) { r.begin(mode); return; }   // Edit Mesh: the selected elements (nothing selected → nothing)
        return this._armature.beginTransform3D(mode);
    }

    constrainAxis3D(axis: 'x' | 'y' | 'z'): void {
        if (this._playing) return;
        const r = this._xfRouted();
        if (r) { if (r.isModal() || r.acceptsAxis?.()) r.constrainAxis(axis); return; }   // (+ a drag on the selection)
        this._armature.getTransformController()?.constrainAxis3D(axis);
    }

    appendNumericInput(char: string): void {
        if (this._playing) return;
        const r = this._xfRouted();
        if (r) { if (r.isModal()) r.appendNumeric(char); return; }
        this._armature.getTransformController()?.appendNumericInput(char);
    }

    commitTransform3D(): void {
        if (this._playing) return;
        const r = this._xfRouted();
        if (r) { r.commit(); return; }
        return this._armature.commitTransform3D();
    }

    cancelTransform3D(): void {
        const r = this._xfRouted();
        if (r) { r.cancel(); return; }
        return this._armature.cancelTransform3D();
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
        this.detachKeyframesFromTimeline();
        if (!this._tryAttachKeyframesToTimeline()) {
            // Timeline not ready yet — poll via pre-render callback until it is
            const retry = () => {
                if (this._tryAttachKeyframesToTimeline()) {
                    this.ctx.webgpuRenderer.removePreRenderCallback(retry);
                    if (this._keyframeAttachRetry === retry) this._keyframeAttachRetry = undefined;
                }
                return false; // never requests a render itself
            };
            this._keyframeAttachRetry = retry;
            this.ctx.webgpuRenderer.addPreRenderCallback(retry);
        }
    }

    /** A pending attach retry (attach called before the timeline existed) — dropped by a re-attach / detach, so two
     *  attaches in a row can't leave two retries that each subscribe (two keyframe passes per frame). */
    private _keyframeAttachRetry?: () => boolean;

    /** @internal — attempts to subscribe; returns true if successful. */
    private _tryAttachKeyframesToTimeline(): boolean {
        const timeline = this.ctx.rasterLayerManager?.getTimeline();
        if (!timeline) return false;
        this._keyframeUnsub?.();
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
        if (this._keyframeAttachRetry) {
            this.ctx.webgpuRenderer.removePreRenderCallback(this._keyframeAttachRetry);
            this._keyframeAttachRetry = undefined;
        }
    }

    /**
     * Interpolate and apply all keyframe tracks for every mesh at the given frame.
     */
    applyAllKeyframesAtFrame(frame: number): void {
        // Runs on EVERY timeline frame (playback) — only meshes with something to apply: a keyframe track or a Frame
        // Link. Camera nodes always run (with no FOV track they drop a stale evaluated FOV).
        const fla = this._animation.frameLinkAnims;
        let animated = false;
        for (const mesh of this.getAllMeshes()) {
            const has = hasAnyKeyframes(mesh.keyframeTracks) || fla.has(mesh.id);
            if (!has && !mesh.isCamera) continue;
            this.applyMeshKeyframesAtFrame(mesh.id, frame);
            if (has) animated = true;
        }
        this.applyCameraKeyframesAtFrame(frame);
        // Mesh transforms changed — tell the renderer to re-upload instance matrices.
        // Without this, _instancesDirty stays false and uploadMeshInstances returns early,
        // leaving the GPU with stale model/normal matrices. (Not when nothing is keyframed: a full re-upload per frame
        // for nothing.)
        if (animated || this._previewThroughCameras || hasAnyKeyframes(this._cameraKeyframeTracks)) this.renderer3D.markInstancesDirty();
        // Cinematic preview: the camera nodes have just been moved to their frame pose above — now point the render
        // camera through whichever one is active at this frame (runs AFTER, so it overrides the legacy camera track).
        if (this._previewThroughCameras) this._applyCameraPreviewAt(frame);
    }

    applyCameraKeyframesAtFrame(frame: number): void {
        const t = this._cameraKeyframeTracks;
        const cam = this.renderer3D.getCamera();
        const pos = sampleTrack(t.position ?? EMPTY_TRACK, frame, interpolateVec3);
        if (pos) cam.setPosition(pos[0], pos[1], pos[2]);
        const tgt = sampleTrack(t.target ?? EMPTY_TRACK, frame, interpolateVec3);
        if (tgt) cam.setTarget(tgt[0], tgt[1], tgt[2]);
        const fov = sampleTrack(t.fov ?? EMPTY_TRACK, frame, interpolateScalar);
        if (fov !== null) cam.fov = fov * Math.PI / 180;
    }

    applyMeshKeyframesAtFrame(meshId: string, frame: number): void {
        const mesh = this.getMesh(meshId);
        if (!mesh) return;
        const tracks = mesh.keyframeTracks;

        const pos = sampleTrack(tracks.position ?? EMPTY_TRACK, frame, interpolateVec3);
        if (pos) { mesh.x = pos[0]; mesh.y = pos[1]; mesh.z = pos[2]; }

        // Camera nodes slerp their rotation so pans arc smoothly (euler-lerp wobbles on big turns); everything
        // else keeps the cheaper component-wise lerp (unchanged behaviour for characters/props).
        const rot = sampleTrack(tracks.rotation ?? EMPTY_TRACK, frame, mesh.isCamera ? interpolateEulerSlerp : interpolateVec3);
        if (rot) { mesh.rotationX = rot[0]; mesh.rotationY = rot[1]; mesh.rotation = rot[2]; }

        // Camera nodes: sample the optional FOV track (radians) into a transient map read by the preview driver for
        // an in-shot zoom. Not persisted here — the KEYFRAMES persist on the mesh; this is just the evaluated value.
        if (mesh.isCamera) {
            const fov = sampleTrack(tracks.fov ?? EMPTY_TRACK, frame, interpolateScalar);
            if (fov !== null) this._animatedCamFov.set(mesh.id, fov);
            else this._animatedCamFov.delete(mesh.id);
        }

        const scale = sampleTrack(tracks.scale ?? EMPTY_TRACK, frame, interpolateVec3);
        if (scale) { mesh.scaleX = scale[0]; mesh.scaleY = scale[1]; mesh.scaleZ = scale[2]; }

        const color = sampleTrack(tracks.diffuseColor ?? EMPTY_TRACK, frame, interpolateVec4);
        if (color) mesh.setDiffuseColor(color[0], color[1], color[2], color[3]);

        const opacity = sampleTrack(tracks.opacity ?? EMPTY_TRACK, frame, interpolateScalar);
        if (opacity !== null) mesh.setOpacity(opacity);

        const vis = sampleTrack(tracks.visible ?? EMPTY_TRACK, frame, (a, _b, _t) => a);
        if (vis !== null) mesh.visible = vis;

        // Blend shape weight tracks
        if (tracks.blendWeights) {
            for (const [shapeName, track] of Object.entries(tracks.blendWeights)) {
                const w = sampleTrack(track, frame, interpolateScalar);
                if (w !== null) {
                    const idx = mesh.blendShapes.findIndex(s => s.name === shapeName);
                    if (idx >= 0) {
                        mesh.blendWeights[idx] = w;
                        if (!Mesh3D.blendFastPath) mesh.gpuDirty = true;
                    }
                }
            }
            if (tracks.blendWeights && Object.keys(tracks.blendWeights).length > 0) {
                // Phase 1.5: only the changed shapes, uploaded in place (skinned parts too — they used to miss
                // keyframed weights entirely, nothing set skinDirty here).
                if (Mesh3D.blendFastPath) this._blendShapes.sync(mesh);
                else mesh.evaluateBlendShapes();
            }
        }

        // Apply frame-link animation delta on top of keyframed values
        // (scroll type is driven by _ensureScrollCb pre-render callback instead)
        const fla = this._animation.frameLinkAnims.get(meshId);
        if (fla?.enabled && fla.type !== 'scroll') {
            const { pos: dp, rot: dr, scale: ds } = evalFrameLink3D(fla, frame);
            if (fla.type === 'spin') {
                // Spin accumulates intentionally — constant angular velocity via +=
                mesh.rotationX += dr[0]; mesh.rotationY += dr[1]; mesh.rotation += dr[2];
            } else {
                // Oscillating types: anchor to a rest pose so drift is structurally impossible.
                // Capture rest on the first frame this FLA runs (post-keyframe, pre-delta).
                // If a keyframe was applied this frame, use it as the base instead of rest.
                const flaRest = this._animation.flaRestTransforms;
                if (!flaRest.has(meshId)) {
                    flaRest.set(meshId, {
                        x: mesh.x, y: mesh.y, z: mesh.z,
                        rx: mesh.rotationX, ry: mesh.rotationY, rz: mesh.rotation,
                        sx: mesh.scaleX, sy: mesh.scaleY, sz: mesh.scaleZ,
                    });
                }
                const rest = flaRest.get(meshId)!;
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

    // ── Frame Link Animation 3D — extracted (scene3d-animation.ts Slice B); delegate. ──

    /** Set (or replace) the procedural frame-link animation for a mesh or MeshGroup3D. */
    setFrameLinkAnimation3D(meshId: string, anim: Partial<FrameLinkAnimation3D>): boolean { return this._animation.setFrameLinkAnimation3D(meshId, anim); }

    /** Get the frame-link animation config for a mesh or group (first child as representative). */
    getFrameLinkAnimation3D(meshId: string): FrameLinkAnimation3D | null { return this._animation.getFrameLinkAnimation3D(meshId); }

    /** Remove the frame-link animation from a mesh or all children of a MeshGroup3D. */
    removeFrameLinkAnimation3D(meshId: string): boolean { return this._animation.removeFrameLinkAnimation3D(meshId); }

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

    // ── Animation player + skeleton playback + NLA — extracted (scene3d-animation.ts); delegate. ──

    createAnimationPlayer(config?: AnimationPlayer3DConfig): AnimationPlayer3D { return this._animation.createAnimationPlayer(config); }
    getAnimationPlayer(): AnimationPlayer3D | undefined { return this._animation.getAnimationPlayer(); }
    destroyAnimationPlayer(): void { this._animation.destroyAnimationPlayer(); }

    /** Create a paused AnimationPlayer3D driving a SkeletonAnimClip (call .play(); destroy when done). */
    playSkeletonClip(skeletonId: string, clip: SkeletonAnimClip): AnimationPlayer3D { return this._animation.playSkeletonClip(skeletonId, clip); }
    /** Crossfade into a clip out of a captured pose over `blendFrames` (see scene3d-animation). */
    playSkeletonClipBlended(skeletonId: string, clip: SkeletonAnimClip, fromPose: import('../../renderer/3d/skeleton-animator').SkeletonPose, blendFrames: number): AnimationPlayer3D {
        return this._animation.playSkeletonClipBlended(skeletonId, clip, fromPose, blendFrames);
    }
    /** Snapshot a skeleton's current joint pose (for crossfade "from"), or null if not a skeleton. */
    snapshotSkeletonPose3D(skeletonId: string): import('../../renderer/3d/skeleton-animator').SkeletonPose | null {
        const skel = this.getSkeleton(skeletonId);
        return skel ? snapshotSkeletonPose(skel) : null;
    }

    createNLATrack3D(skeletonId: string, name: string, fps = 24, loop = true): string { return this._animation.createNLATrack3D(skeletonId, name, fps, loop); }
    getNLATracks3D(skeletonId: string): NLATrack[] { return this._animation.getNLATracks3D(skeletonId); }
    addNLASegment3D(trackId: string, clipId: string, startFrame: number, opts?: Partial<Omit<NLAClipSegment, 'clipId' | 'startFrame'>>): number {
        return this._animation.addNLASegment3D(trackId, clipId, startFrame, opts);
    }
    removeNLASegment3D(trackId: string, segIndex: number): void { this._animation.removeNLASegment3D(trackId, segIndex); }
    updateNLASegment3D(trackId: string, segIndex: number, updates: Partial<NLAClipSegment>): void { this._animation.updateNLASegment3D(trackId, segIndex, updates); }
    playNLATrack3D(trackId: string): AnimationPlayer3D { return this._animation.playNLATrack3D(trackId); }
    stopNLATrack3D(trackId: string): void { this._animation.stopNLATrack3D(trackId); }
    seekNLATrack3D(trackId: string, frame: number): void { this._animation.seekNLATrack3D(trackId, frame); }
    crossfade3D(trackId: string, fromSegIdx: number, toSegIdx: number, durationFrames: number): void { this._animation.crossfade3D(trackId, fromSegIdx, toSegIdx, durationFrames); }

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
    createEmptySkeleton3D(name = 'Skeleton'): string { return this._armature.createEmptySkeleton3D(name); }

    /** Append a joint to a skeleton. Returns the new joint index. */
    addBone3D(skeletonId: string, parentIndex: number, localPos: [number, number, number], name?: string): number {
        return this._armature.addBone3D(skeletonId, parentIndex, localPos, name);
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
        // A Character v2 body / skeleton ships frozen weights, and the bind REPLACES the mesh node (its manager kept the
        // orphan → the next save dropped the character). Refused (review fix runtime#5).
        const v2 = (n: unknown) => (n as { characterKind?: string } | null)?.characterKind === 'v2';
        if (v2(this.getMesh(meshId)) || v2(this.getSkeleton(skeletonId))) { console.warn('[3D] Bind Mesh refused: a Character v2 body is already rigged'); return false; }
        return this._armature.bindMeshToSkeleton3D(meshId, skeletonId);
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

    // ── Default idle animations + poses + pose library — extracted (scene3d-animation.ts); delegate. ──

    /** Resolve the skeleton id a mesh is bound to (or null). Accepts a body/skinned-mesh id. */
    getSkeletonIdForMesh(meshId: string): string | null { return this._animation.getSkeletonIdForMesh(meshId); }

    /** Pre-populate a skeleton's Clips + Pose Library with the default idle/personality set (idempotent). */
    installDefaultAnimations(skelOrMeshId: string): number { return this._animation.installDefaultAnimations(skelOrMeshId); }

    /** Skeleton JSON for persistence with UNEDITED default clips/poses stripped (re-installed on load). */
    serializeSkeletonForSave(skel: Skeleton3D): any { return this._animation.serializeSkeletonForSave(skel); }

    /** The clip names installDefaultAnimations adds (so the host can label/filter the built-ins). */
    getDefaultClipNames(): string[] { return this._animation.getDefaultClipNames(); }

    /** Copy-pasteable text block of the CURRENT pose (posed joints only) — for LLM/author handoff. */
    exportPoseData(skelId?: string): string { return this._animation.exportPoseData(skelId); }

    /** Copy-pasteable text block of a procedural body's proportions — pair with exportPoseData. */
    exportBodyData(idOrSkel?: string): string { return this._animation.exportBodyData(idOrSkel); }

    capturePose(skelId: string, name: string): string { return this._animation.capturePose(skelId, name); }
    applyPose(skelId: string, poseId: string): void { this._animation.applyPose(skelId, poseId); }
    getPoses(skelId: string): { id: string; name: string; region?: AnimRegion }[] { return this._animation.getPoses(skelId); }
    setPoseRegion(skelId: string, poseId: string, region: AnimRegion | null): void { this._animation.setPoseRegion(skelId, poseId, region); }
    setClipRegion(clipId: string, region: AnimRegion | null): void { this._animation.setClipRegion(clipId, region); }
    getAnimationsByRegion(skelId: string, region: AnimRegion): { poses: { id: string; name: string }[]; clips: SkeletonAnimClip[] } {
        return this._animation.getAnimationsByRegion(skelId, region);
    }
    renamePose(skelId: string, poseId: string, name: string): void { this._animation.renamePose(skelId, poseId, name); }
    deletePose(skelId: string, poseId: string): void { this._animation.deletePose(skelId, poseId); }

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
        // Joint-name remap via the shared pure core (anim-retarget.ts) — same matching the Animation Library uses.
        const { data: tracks, missing } = retargetClipTracks(clip.tracks, found.skel.data.joints, targetSkel.data.joints);
        for (const m of missing) console.warn('retarget: no match for joint', m);
        return this._createClipFromTracks(targetSkeletonId, clip.name + ' (retargeted)', clip.fps, clip.endFrame, tracks, clip.region);
    }

    /** Create a clip on a skeleton from already-remapped tracks (shared by retarget + the Animation Library). */
    private _createClipFromTracks(
        skeletonId: string, name: string, fps: number, endFrame: number,
        tracks: import('../../types/armature-3d').SkeletonKeyframeTrack[], region?: AnimRegion,
    ): string {
        const newClipId = this.createSkeletonClip3D(skeletonId, name, fps, endFrame);
        if (!newClipId) return '';
        for (const track of tracks) {
            for (const kf of track.keyframes) {
                this.setClipJointKeyframe3D(newClipId, track.jointIndex, track.channel, kf.frame, [...kf.value]);
            }
        }
        if (region) this.setClipRegion(newClipId, region);
        return newClipId;
    }

    // ── Animation Library (docs/specs/animation-library-and-triggers.md, Phase A) ─────────────────────
    // Promote authored clips/poses out of a skeleton into a reusable, cross-skeleton library; apply any
    // entry to any skeleton via joint-name retargeting. GPU-free store — see animation-library.ts.
    private _animLibrary?: AnimationLibrary;
    private get animLibrary(): AnimationLibrary {
        if (!this._animLibrary) {
            this._animLibrary = new AnimationLibrary({
                findClip: (clipId) => {
                    const f = this._findClip(clipId);
                    return f ? { clip: f.clip, joints: f.skel.data.joints, rig: f.skel.data.name } : null;
                },
                findPose: (skeletonId, poseId) => {
                    const skel = this.getSkeleton(skeletonId);
                    const pose = skel?.data.poses?.find((p) => p.id === poseId);
                    return skel && pose ? { pose, joints: skel.data.joints, rig: skel.data.name } : null;
                },
                skeletonJoints: (skeletonId) => this.getSkeleton(skeletonId)?.data.joints ?? null,
                createClip: (skeletonId, name, fps, endFrame, tracks, region) =>
                    this._createClipFromTracks(skeletonId, name, fps, endFrame, tracks, region),
                addPose: (skeletonId, name, rotations, region) => {
                    const skel = this.getSkeleton(skeletonId);
                    if (!skel) return '';
                    (skel.data.poses ??= []).push({ id: crypto.randomUUID(), name, rotations, ...(region ? { region } : {}) });
                    const id = skel.data.poses[skel.data.poses.length - 1].id;
                    this.ctx.emitSceneGraphChanged();
                    return id;
                },
            });
        }
        return this._animLibrary;
    }

    /** Promote a clip into the library → entry id (null if the clip isn't found). */
    addClipToLibrary3D(clipId: string, opts?: { name?: string; tags?: string[] }): string | null { return this.animLibrary.addClip(clipId, opts); }
    /** Promote a pose into the library → entry id. */
    addPoseToLibrary3D(skeletonId: string, poseId: string, opts?: { name?: string; tags?: string[] }): string | null { return this.animLibrary.addPose(skeletonId, poseId, opts); }
    /** All library entries (copies) for the host panel. */
    getAnimationLibrary3D(): AnimLibraryEntry[] { return this.animLibrary.list(); }
    /** Apply a library entry to a skeleton via joint-name retarget → new clip/pose id (null on fail / zero matches). */
    applyLibraryEntry3D(entryId: string, targetSkeletonId: string, opts?: { rename?: string }): string | null { return this.animLibrary.apply(entryId, targetSkeletonId, opts); }
    /** Apply an entry OBJECT (e.g. a payload from the global Shared Asset Library) onto a skeleton → new clip/pose id.
     *  The Shared Asset Library's anim provider uses this to instantiate a global asset into the open document. */
    applyLibraryEntryObject3D(entry: AnimLibraryEntry, targetSkeletonId: string, opts?: { rename?: string }): string | null { return this.animLibrary.applyEntry(entry, targetSkeletonId, opts); }
    /** Build a library-entry OBJECT from a clip WITHOUT storing it in the doc library — for promoting straight to the
     *  global Shared Asset Library. Returns null if the clip isn't found. */
    buildLibraryEntryFromClip3D(clipId: string, opts?: { name?: string; tags?: string[]; rigType?: string }): AnimLibraryEntry | null { return this.animLibrary.buildClipEntry(clipId, opts); }
    /** Build a library-entry OBJECT from a pose without storing it (see {@link buildLibraryEntryFromClip3D}). */
    buildLibraryEntryFromPose3D(skeletonId: string, poseId: string, opts?: { name?: string; tags?: string[]; rigType?: string }): AnimLibraryEntry | null { return this.animLibrary.buildPoseEntry(skeletonId, poseId, opts); }
    /** Preflight: {matched, missing[]} joints for applying an entry to a skeleton (UI compat chip). */
    libraryCompatibility3D(entryId: string, skeletonId: string): { matched: number; missing: string[] } | null { return this.animLibrary.compatibility(entryId, skeletonId); }
    removeLibraryEntry3D(entryId: string): boolean { return this.animLibrary.remove(entryId); }
    renameLibraryEntry3D(entryId: string, name: string): boolean { return this.animLibrary.rename(entryId, name); }
    /** Override a library entry's rig-type label ('humanoid' | 'creature' | …) — a filter/grouping label. */
    setLibraryEntryRigType3D(entryId: string, rigType: string): boolean { return this.animLibrary.setRigType(entryId, rigType); }
    /** The coarse rig type of a skeleton (joint-signature classification) — for pre-filtering the library
     *  panel to entries that likely fit. NOT the exact compat check (use libraryCompatibility3D). */
    getSkeletonRigType3D(skeletonId: string): string | null {
        const skel = this.getSkeleton(skeletonId);
        return skel ? classifyRig(skel.data.joints) : null;
    }
    /** Export the library as JSON (cross-document reuse). */
    exportAnimationLibrary3D(): string { return JSON.stringify(this.animLibrary.serialize()); }
    /** Import a library JSON. `merge` appends (fresh ids); default replaces. Returns new entry ids. */
    importAnimationLibrary3D(json: string, opts?: { merge?: boolean }): string[] { return this.animLibrary.load(json, opts); }

    // ── Shared Asset Library provenance (L3) — which GLOBAL assets this document instantiated ────────
    private readonly _assetRefs = new AssetReferenceStore();
    /** Record that a document-local object was instantiated from a global asset (called by the ShapeManager hook). */
    recordAssetReference(ref: DocumentAssetReference): void { this._assetRefs.record(ref); }
    /** The document's global-asset provenance links (for the "linked assets / update available" panel). */
    listAssetReferences(): DocumentAssetReference[] { return this._assetRefs.list(); }
    /** Forget a provenance link (e.g. the instantiated object was deleted). */
    removeAssetReferenceByDocId(docLocalId: string): boolean { return this._assetRefs.removeByDocLocalId(docLocalId); }

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
    getScene3DHierarchy(): Scene3DHierarchyNode[] {
        let flat = this._grouping.getScene3DHierarchy();
        // Runtime-only nodes (the Play auto default player: body, skeleton, face decal, hair, garments) never show in
        // the outliner, including during the first spawn (marked runtime before the cache holds them).
        flat = flat.filter(n => !this.autoPlayer.isRuntimeNode(n.id) && !this._character.isRuntimePart(n.id));
        // A character provider's internal nodes (the Character v2 save marker — deleting that row silently lost the
        // character) never show either (review fix runtime#4).
        if (this._characterProviders.length) flat = flat.filter(n => !this._characterProviders.some(p => p.hidden?.(n.id)));
        // DISPLAY-ONLY character grouping: a procedural character adds its parts (body + eye decal + hair + garments
        // + attachments) as FLAT siblings under root, so the outliner shows ~6-9 rows per character. Nest a
        // character's overlay parts under a single collapsible "Character" node (the body). The scene graph is
        // untouched — this only restructures the returned tree — so transforms, skeleton drive, and persistence are
        // all unaffected. A REAL container isn't needed: the character already MOVES together via selection expansion
        // (_expandCharacterSelection), and a real group would drag in the persistence/reload-reparent complexity the
        // character system's save path only just got stabilized around. Whole-character hide/delete fan out via
        // characterPartIds3D(bodyId). Nodes with no character link pass through unchanged.
        const overlaysByBody = new Map<string, Scene3DHierarchyNode[]>();
        for (const node of flat) {
            if (node.type !== '3DMesh') continue;
            const bodyId = this._character.overlayBodyOf(node.id);
            if (!bodyId) continue;
            let arr = overlaysByBody.get(bodyId);
            if (!arr) { arr = []; overlaysByBody.set(bodyId, arr); }
            arr.push(node);
        }
        if (overlaysByBody.size === 0) return flat;   // no characters → identical to before
        const result: Scene3DHierarchyNode[] = [];
        for (const node of flat) {
            if (node.type === '3DMesh' && this._character.overlayBodyOf(node.id)) continue;   // an overlay → nested below
            const overlays = overlaysByBody.get(node.id);
            if (overlays) result.push({ ...node, name: 'Character', type: '3DMeshGroup', character: true, collapsed: node.collapsed ?? true, children: overlays });
            else result.push(node);
        }
        return result;
    }

    /** The mesh ids that make up one character — the body plus every part whose overlay links back to it (eye decal,
     *  hair, garments, attachments). Use it to fan out whole-character outliner ops (select/hide/delete all) since
     *  the character is a VIRTUAL outliner group, not a real scene-graph container. */
    characterPartIds3D(bodyId: string): string[] {
        const ids = [bodyId];
        for (const m of this.getAllMeshes()) if (m.id !== bodyId && this._character.overlayBodyOf(m.id) === bodyId) ids.push(m.id);
        return ids;
    }
    /** If `meshId` is a character part (eye decal / hair / garment / attachment), the body it belongs to; else null. */
    overlayBodyOf3D(meshId: string): string | null { return this._character.overlayBodyOf(meshId); }

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

    /** @deprecated Use getClothVertexSlot for pins, getClothVertexDenseIndex for stitches.
     *  KEPT (audit B3, verified 2026-09-11): Frogmarks cloth-builder.component.ts still calls this —
     *  do not delete until the host migrates. */
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
    /** Dirty meshes + their stateVersion at this instant — pair with {@link clearMeshDirtyStateIfUnchanged}. */
    snapshotDirtyMeshes(): Array<{ id: string; version: number }> {
        return this.getAllMeshes().filter(m => m.stateDirty).map(m => ({ id: m.id, version: m.stateVersion }));
    }

    /** After a successful save of a {@link snapshotDirtyMeshes} snapshot: clear each mesh's flag ONLY if it wasn't
     *  edited again since the snapshot (its version is unchanged). A mid-write edit keeps its flag, so the next save
     *  still writes it (audit 2026-09-28 P5 — clearing everything marked those edits saved when they weren't). */
    clearMeshDirtyStateIfUnchanged(snapshot: Array<{ id: string; version: number }>): void {
        for (const { id, version } of snapshot) {
            const m = this.getMesh(id);
            if (m && m.stateVersion === version) m.stateDirty = false;
        }
    }

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
